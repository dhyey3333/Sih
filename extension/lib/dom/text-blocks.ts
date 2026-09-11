/**
 * Visible page text, grouped into blocks, with a way back to exact pixel rects.
 *
 * Two things make this non-trivial:
 *
 *  1. A PII value is often split across text nodes — `<b>Aadhaar</b>: 2234 5678 9012`
 *     or a table cell with a stray `<span>`. Scanning node by node would miss those,
 *     so we concatenate a block's nodes and keep an offset map back into them.
 *  2. A match needs *pixel* boxes, not a node. `Range.getClientRects()` gives one
 *     rect per rendered line, which is exactly right — a value wrapped across two
 *     lines gets two boxes and stays fully covered.
 */

import type { Rect } from '../protocol';
import { scopesUnder } from './deep';

export interface TextPiece {
  node: Text;
  /** Offsets into the block's concatenated text. */
  start: number;
  end: number;
}

export interface TextBlock {
  text: string;
  pieces: TextPiece[];
  /** Nearest block-level ancestor, used as the element for context words. */
  container: Element;
  /**
   * Label text from *outside* the block that qualifies its content.
   *
   * Displayed PII is almost always laid out as label-then-value in two sibling
   * elements — `<dt>Date of birth</dt><dd>14/03/2001</dd>`, or a `<td>` under a
   * `<th>Card</th>`. Without this, the value's own block reads as bare digits and
   * every context-dependent rule correctly declines to fire, which is the single
   * biggest source of missed detections on profile and statement pages.
   */
  labelContext: string;
  /**
   * CSS pixels to add to every rect measured inside this block, to move it from the
   * scope it was found in into the top-level viewport. Zero for the top document;
   * non-zero for text inside a same-origin frame (lib/dom/deep.ts).
   */
  dx: number;
  dy: number;
}

const BLOCK_SELECTOR =
  'p,div,li,td,th,tr,section,article,header,footer,main,aside,nav,form,fieldset,legend,' +
  'label,dt,dd,figcaption,blockquote,pre,h1,h2,h3,h4,h5,h6,summary,details,address,body';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);

export interface CollectOptions {
  viewport: { w: number; h: number };
  /** Stop after this much text. Guards against pathological pages. */
  maxChars?: number;
}

/**
 * Collect on-screen text, grouped by block-level container.
 * Off-screen text is skipped: we cannot redact what isn't in the screenshot, and
 * scanning the whole DOM of a long page is the main cost in this stage.
 */
export function collectTextBlocks(root: ParentNode & Node, options: CollectOptions): TextBlock[] {
  const { viewport, maxChars = 60_000 } = options;
  const blocks = new Map<Element, TextBlock>();
  let budget = maxChars;

  // A TreeWalker stops at a shadow boundary and will not enter a frame, so every
  // reachable scope is walked in turn. Without this, text rendered by a web component
  // or inside a same-origin frame is not scanned at all — and it is still in the
  // screenshot, so it would go out unredacted (lib/dom/deep.ts).
  const texts: Array<{ node: Text; dx: number; dy: number }> = [];
  for (const scope of scopesUnder(root)) {
    const walker = document.createTreeWalker(scope.root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (!(node as Text).data.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      texts.push({ node: node as Text, dx: scope.dx, dy: scope.dy });
    }
  }

  for (const { node: text, dx, dy } of texts) {
    if (budget <= 0) break;
    const parent = text.parentElement;
    if (!parent) continue;

    // One range measurement decides visibility; cheaper than getComputedStyle.
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = range.getBoundingClientRect();
    range.detach?.();
    if (rect.width < 1 || rect.height < 1) continue;
    // Visibility is judged against the viewport the screenshot covers, so the rect
    // is moved out of its own scope first.
    const top = rect.top + dy;
    const left = rect.left + dx;
    if (top + rect.height <= 0 || left + rect.width <= 0 || top >= viewport.h || left >= viewport.w) {
      continue;
    }

    const container = parent.closest(BLOCK_SELECTOR) ?? parent;
    let block = blocks.get(container);
    if (!block) {
      block = { text: '', pieces: [], container, labelContext: labelContextFor(container), dx, dy };
      blocks.set(container, block);
    }

    // A separator keeps "OTP" and "482913" from concatenating into one token,
    // while still letting the context check see both.
    if (block.text) block.text += ' ';
    const start = block.text.length;
    block.text += text.data;
    block.pieces.push({ node: text, start, end: block.text.length });
    budget -= text.data.length;
  }

  return [...blocks.values()];
}

/**
 * Label text that describes a block from outside it.
 *
 * Two patterns cover almost every real "labelled value" on the web:
 *   - the previous sibling element  (`<dt>` before `<dd>`, `<label>` before a span)
 *   - the column header             (`<th>` above a `<td>`)
 */
function labelContextFor(container: Element): string {
  const parts: string[] = [];

  const previous = container.previousElementSibling;
  if (previous && looksLikeALabel(previous)) parts.push(previous.textContent ?? '');

  if (container.tagName === 'TD' || container.tagName === 'TH') {
    const row = container.parentElement;
    const table = container.closest('table');
    if (row && table) {
      const column = [...row.children].indexOf(container);
      const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr');
      // Guard against the header row describing itself.
      if (headerRow && headerRow !== row) {
        parts.push(headerRow.children[column]?.textContent ?? '');
      }
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Tags whose whole job is to name the thing that follows. */
const LABEL_TAGS = new Set(['DT', 'TH', 'LABEL', 'STRONG', 'B', 'EM', 'SPAN', 'SMALL', 'DFN', 'CAPTION']);

/** Containers of prose. A preceding paragraph describes itself, not its neighbour. */
const PROSE_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'TABLE', 'FORM', 'BLOCKQUOTE', 'PRE', 'MAIN', 'NAV']);

/**
 * Whether the previous sibling is really a label for what follows.
 *
 * Getting this wrong is expensive in both directions. Too strict and
 * `<dt>Date of birth</dt><dd>14/03/2001</dd>` never fires. Too loose and a
 * paragraph mentioning "one-time password" lends OTP context to the *next*
 * paragraph, turning an unrelated 4-digit number into a false detection — which
 * is exactly what happened before this check existed.
 */
function looksLikeALabel(el: Element): boolean {
  const length = (el.textContent ?? '').trim().length;
  if (length === 0 || length > 60) return false;
  if (LABEL_TAGS.has(el.tagName)) return true;
  // A short non-prose element (a styled <span>-like wrapper) can still be a label.
  return !PROSE_TAGS.has(el.tagName) && length <= 40;
}

/**
 * Pixel rects for a `[start, end)` span of a block's concatenated text.
 * Returns one rect per rendered line.
 */
export function rectsForSpan(block: TextBlock, start: number, end: number): Rect[] {
  const first = block.pieces.find((p) => start < p.end && p.start <= start);
  const last = [...block.pieces].reverse().find((p) => end > p.start && p.end >= end);
  if (!first || !last) return [];

  const range = document.createRange();
  try {
    range.setStart(first.node, clamp(start - first.start, first.node.data.length));
    range.setEnd(last.node, clamp(end - last.start, last.node.data.length));
  } catch {
    // Offsets can go stale if the page mutated mid-scan; skip rather than throw.
    return [];
  }

  const rects = [...range.getClientRects()]
    .filter((r) => r.width >= 1 && r.height >= 1)
    // Into the top-level viewport, exactly once. `getClientRects` is relative to the
    // scope the text lives in, which is not the one the screenshot was taken of.
    .map((r) => ({ x: r.left + block.dx, y: r.top + block.dy, w: r.width, h: r.height }));
  range.detach?.();
  return rects;
}

function clamp(offset: number, max: number): number {
  return Math.max(0, Math.min(offset, max));
}
