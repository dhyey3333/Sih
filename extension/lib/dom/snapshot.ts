/**
 * Building a DomSnapshot from the live page.
 *
 * Kept out of the content-script entrypoint so the same code can run in a plain
 * page for scoring (lib/eval/score-page.ts) — the snapshot is the input to every
 * accuracy metric we report, so it must be the *same* code that runs in the demo,
 * not a reimplementation that drifts.
 */

import type { DomSnapshot, ImageCandidate, PageElement, PiiType, Rect, TextFinding } from '../protocol';
import { accessibleName, interactiveSelector, isVisibleInViewport, roleOf } from './accessibility';
import { collectTextBlocks, rectsForSpan } from './text-blocks';
import { classifyField, imageHint, type FieldDescriptor } from '../pii/dom-heuristics';
import { scanText } from '../pii/validators';

export interface KnownValue {
  value: string;
  type: PiiType;
}

export interface SnapshotOptions {
  maxElements?: number;
  maxImages?: number;
  /** Populated with id → element so actions can be executed against it later. */
  registry?: Map<number, Element>;
  /**
   * Values the vault already holds — the user's profile. Located by literal match
   * so that a name or a street address, which no pattern can recognise, still gets
   * a redaction box rather than only a token in the JSON.
   */
  knownValues?: KnownValue[];
}

export function buildSnapshot(options: SnapshotOptions = {}): DomSnapshot {
  const startedAt = performance.now();
  const { maxElements = 160, maxImages = 40, registry, knownValues = [] } = options;
  registry?.clear();

  const viewport = { w: window.innerWidth, h: window.innerHeight };

  return {
    url: location.href,
    title: document.title,
    dpr: window.devicePixelRatio || 1,
    viewport,
    scroll: { x: window.scrollX, y: window.scrollY },
    elements: collectElements(viewport, maxElements, registry),
    textFindings: collectTextFindings(viewport, knownValues),
    imageCandidates: collectImageCandidates(viewport, maxImages),
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

export function toRect(domRect: DOMRect): Rect {
  return {
    x: Math.round(domRect.left * 10) / 10,
    y: Math.round(domRect.top * 10) / 10,
    w: Math.round(domRect.width * 10) / 10,
    h: Math.round(domRect.height * 10) / 10,
  };
}

function descriptorFor(el: Element, label: string): FieldDescriptor {
  const input = el as HTMLInputElement;
  return {
    tag: el.tagName,
    type: input.type,
    name: input.name,
    id: el.id,
    label,
    placeholder: input.placeholder,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    title: el.getAttribute('title') ?? undefined,
    inputMode: el.getAttribute('inputmode') ?? undefined,
  };
}

function collectElements(
  viewport: { w: number; h: number },
  maxElements: number,
  registry?: Map<number, Element>,
): PageElement[] {
  const out: PageElement[] = [];
  let nextId = 1;

  for (const el of document.querySelectorAll(interactiveSelector())) {
    if (out.length >= maxElements) break;
    if (!isVisibleInViewport(el, viewport)) continue;

    const id = nextId++;
    const label = accessibleName(el);
    const role = roleOf(el);

    // A structural view of the form properties we read. The concrete element types
    // disagree about `type` (a <select> reports "select-one"), so widen rather than
    // intersect them.
    const input = el as Element & {
      type?: string;
      placeholder?: string;
      disabled?: boolean;
      required?: boolean;
      checked?: boolean;
    };
    const classification = classifyField(descriptorFor(el, label));

    const element: PageElement = {
      id,
      role,
      tag: el.tagName.toLowerCase(),
      bbox: toRect(el.getBoundingClientRect()),
    };

    if (label) element.label = label;
    if (input.type) element.type = input.type;
    if (input.placeholder) element.placeholder = input.placeholder;
    if (input.disabled) element.disabled = true;
    if (input.required) element.required = true;
    if (typeof input.checked === 'boolean' && (input.type === 'checkbox' || input.type === 'radio')) {
      element.checked = input.checked;
    }

    const autocomplete = el.getAttribute('autocomplete');
    if (autocomplete) element.autocomplete = autocomplete;

    if (role === 'button' || role === 'link') {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) element.text = text.slice(0, 120);
    }

    if (el instanceof HTMLSelectElement) {
      element.options = [...el.options].slice(0, 40).map((o) => o.text.trim());
      if (el.value) element.value = el.value;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // A password is never copied out of the page, not even inside the extension.
      // The agent only needs to know whether the field is already filled.
      if (el instanceof HTMLInputElement && el.type === 'password') {
        element.value = el.value ? '••••••••' : '';
      } else if (el.value) {
        element.value = el.value.slice(0, 500);
      }
    } else if (el.getAttribute('contenteditable') !== null) {
      const text = (el.textContent ?? '').trim();
      if (text) element.value = text.slice(0, 500);
    }

    if (classification) {
      element.sensitive = classification.type;
      element.sensitiveReason = classification.reason;
    }

    registry?.set(id, el);
    out.push(element);
  }

  return out;
}

/**
 * PII in the page's own text — a profile page showing an email, a statement showing
 * an account number. Read-only, but exactly what leaks through a screenshot.
 */
function collectTextFindings(
  viewport: { w: number; h: number },
  knownValues: KnownValue[],
): TextFinding[] {
  const findings: TextFinding[] = [];

  for (const block of collectTextBlocks(document.body, { viewport })) {
    // Context comes from the block's own text *and* from the label beside it, so
    // "Date of birth" in a <dt> can qualify the digits in the following <dd>.
    const context = `${block.container.textContent?.slice(0, 300) ?? ''} ${block.labelContext}`;

    const spans: Array<{ type: TextFinding['type']; value: string; start: number; end: number; confidence: number }> =
      findKnownValueSpans(block.text, knownValues);

    for (const match of scanText(block.text, { context })) {
      // A literal match on a vault value is certain; never let a pattern override it.
      if (spans.some((s) => match.start < s.end && s.start < match.end)) continue;
      spans.push({ ...match });
    }

    for (const span of spans) {
      const rects = rectsForSpan(block, span.start, span.end).filter(
        (r) => r.w >= 2 && r.h >= 2 && r.y + r.h > 0 && r.y < viewport.h,
      );
      if (rects.length === 0) continue;
      findings.push({ type: span.type, value: span.value, rects, confidence: span.confidence });
    }
  }

  return findings;
}

/**
 * Literal, case-insensitive occurrences of vault values. Longest match wins, and
 * spans never overlap, so "Ananya Iyer" inside a longer stored address resolves to
 * the address rather than producing two boxes.
 */
function findKnownValueSpans(
  text: string,
  knownValues: KnownValue[],
): Array<{ type: PiiType; value: string; start: number; end: number; confidence: number }> {
  if (knownValues.length === 0 || !text) return [];
  const haystack = text.toLowerCase();

  const found: Array<{ type: PiiType; value: string; start: number; end: number; confidence: number }> = [];
  for (const known of knownValues) {
    const needle = known.value.toLowerCase();
    for (let from = 0; ; ) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      found.push({
        type: known.type,
        value: text.slice(at, at + needle.length),
        start: at,
        end: at + needle.length,
        confidence: 1,
      });
      from = at + needle.length;
    }
  }

  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: typeof found = [];
  for (const span of found) {
    if (!kept.some((k) => span.start < k.end && k.start < span.end)) kept.push(span);
  }
  return kept;
}

/** Regions the DOM cannot read into — handed to the vision layer in M4. */
function collectImageCandidates(viewport: { w: number; h: number }, maxImages: number): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  let id = -1;

  for (const el of document.querySelectorAll('img, canvas, video, svg')) {
    if (out.length >= maxImages) break;
    if (!isVisibleInViewport(el, viewport)) continue;

    const bbox = toRect(el.getBoundingClientRect());
    // Icons and tracking pixels are not worth a model pass.
    if (bbox.w < 24 || bbox.h < 24) continue;

    const kind = el.tagName.toLowerCase() as ImageCandidate['kind'];
    const hint =
      el instanceof HTMLImageElement
        ? imageHint(el.alt ?? '', el.className ?? '', el.currentSrc || el.src || '')
        : imageHint('', typeof el.className === 'string' ? el.className : '', '');

    out.push({ elementId: id--, bbox, kind, hint: hint ?? undefined });
  }

  return out;
}
