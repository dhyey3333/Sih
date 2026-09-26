/**
 * The screen's text, made safe to send.
 *
 * A 3B vision model asked "what is the status of my application?" answered
 * "Application status confirmed." — it could not read the word on the screenshot.
 * Text is how small models read. So at disclosure level 2, where the redacted
 * screenshot already goes, the same screen goes as text too.
 *
 * "The same screen" is the whole privacy argument, and three things make it true:
 *
 *  1. Every value the text layer found is replaced by the token its box carries,
 *     by offset, from the same scan that painted the boxes (lib/dom/snapshot.ts).
 *     The two can't disagree about what was sensitive.
 *  2. A block that a pixel detector covered — vision or OCR saw something there
 *     that the text rules did not — is sent as that box's token and nothing else.
 *     The text never says what the image hides.
 *  3. The result goes through the text sanitizer again, with the block's context,
 *     and then through the egress guard like every other string.
 *
 * Faces don't count for (2): a face beside a caption says nothing about the caption.
 * Nor does a vague pixel box ("this looks like personal text", GENERIC) that sits on a
 * value the text layer already found: the text layer read those exact characters and
 * tokenized them, so the block goes with that token — `⟦PROFILE.EMAIL⟧`, not an
 * anonymous `⟦GENERIC_1⟧`. A vague box over text the text layer found clean still
 * withholds it: that is the case of a third party's name, which only pixels caught.
 */

import type { Detection, Rect, VisibleTextBlock } from '../protocol';
import { sanitizeText } from './sanitize';
import type { Vault } from './vault';

/** Enough for a form or a status page. A small model's context is the constraint. */
export const MAX_VISIBLE_TEXT = 4000;
const MAX_BLOCK_CHARS = 400;

/** How much of either box must overlap before a pixel detection withholds a block. */
const COVER_RATIO = 0.3;

export function buildVisibleText(
  blocks: VisibleTextBlock[],
  detections: Detection[],
  vault: Vault,
  maxChars = MAX_VISIBLE_TEXT,
): string {
  const fromText = detections.filter((d) => d.source === 'dom-text' || d.source === 'dom-field');
  const pixelOnly = detections.filter(
    (d) =>
      (d.source === 'vision' || d.source === 'ocr') &&
      d.type !== 'FACE' &&
      !(d.type === 'GENERIC' && d.source === 'vision' && fromText.some((t) => explains(t.bbox, d.bbox))),
  );

  const lines: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const covering = pixelOnly.filter((d) => covers(d.bbox, block.bbox));
    const line = clampAtWord(
      covering.length > 0
        ? [...new Set(covering.map((d) => d.token))].join(' ')
        : sanitizeText(collapse(replaceSpans(block, vault)), vault, block.context).text,
      MAX_BLOCK_CHARS,
    );
    if (!line || line === lines.at(-1)) continue;
    if (used + line.length + 1 > maxChars) {
      lines.push('…');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

/** The block's text with each marked span swapped for its token, by offset. */
function replaceSpans(block: VisibleTextBlock, vault: Vault): string {
  const spans = [...block.spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // overlapping match; the earlier one already covers it
    out += block.text.slice(cursor, span.start) + vault.tokenize(span.type, span.value);
    cursor = span.end;
  }
  return out + block.text.slice(cursor);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cut at a word boundary, and never inside a token — half a token is noise. */
function clampAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf(' ', max - 1);
  if (cut < max / 2) cut = max - 1;
  const open = text.lastIndexOf('⟦', cut);
  if (open !== -1 && text.indexOf('⟧', open) >= cut) cut = open;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function covers(detection: Rect, block: Rect): boolean {
  const w = Math.min(detection.x + detection.w, block.x + block.w) - Math.max(detection.x, block.x);
  const h = Math.min(detection.y + detection.h, block.y + block.h) - Math.max(detection.y, block.y);
  if (w <= 0 || h <= 0) return false;
  const overlap = w * h;
  const smaller = Math.min(detection.w * detection.h, block.w * block.h);
  return smaller > 0 && overlap / smaller >= COVER_RATIO;
}

/**
 * A text-layer finding that accounts for a vague pixel box: it fills most of it.
 * One-directional on purpose — a large box over a paragraph is not explained by the
 * one email inside it, because the rest of what it covers may be a name.
 */
function explains(finding: Rect, pixel: Rect): boolean {
  const w = Math.min(finding.x + finding.w, pixel.x + pixel.w) - Math.max(finding.x, pixel.x);
  const h = Math.min(finding.y + finding.h, pixel.y + pixel.h) - Math.max(finding.y, pixel.y);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (pixel.w * pixel.h) >= 0.5;
}
