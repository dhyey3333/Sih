/**
 * Box fusion (§1.3 of docs/PLAN.md).
 *
 * The DOM layer, the vision layer and OCR all describe the same screen, so they
 * routinely produce two boxes over one secret. Sending both would double-count in
 * the redaction-precision metric and draw ugly overlapping rectangles; keeping
 * only one would risk keeping the *smaller* one and leaking the edge of a value.
 * So: merge to the union, and inherit the higher-priority type.
 */

import type { Detection, Rect } from '../protocol';
import { PII_PRIORITY } from '../protocol';

/**
 * Which detection names a merged box.
 *
 * A `GENERIC` box from the vision layer means "the detector saw something
 * text-like it could not name" — the least specific claim anything in the pipeline
 * makes. It still widens the redaction (the union keeps every pixel it saw covered),
 * but it must not *name* the result. At its table priority it outranked EMAIL, PHONE,
 * DOB, ADDRESS and NAME, so an email field the DOM had identified exactly went out
 * as ⟦GENERIC_7⟧ instead of ⟦PROFILE.EMAIL⟧ — hiding from the server the one fact
 * the token scheme exists to tell it.
 *
 * It ranks just above FACE, not at the bottom: a text box merged with a face must
 * still be blocked, because a FACE result is pixelated and text is never pixelated.
 * A DOM `GENERIC` ("voter ID", "salary") is a deliberate classification of a named
 * field and keeps its table priority.
 */
function fusionRank(d: Detection): number {
  if (d.type === 'GENERIC' && d.source === 'vision') return PII_PRIORITY.FACE + 0.5;
  return PII_PRIORITY[d.type];
}

/** Grow a box slightly. Anti-aliased glyph edges bleed a pixel or two past the rect. */
export function padRect(rect: Rect, pad: number, bounds?: { w: number; h: number }): Rect {
  let x = rect.x - pad;
  let y = rect.y - pad;
  let w = rect.w + pad * 2;
  let h = rect.h + pad * 2;

  if (bounds) {
    const x2 = Math.min(x + w, bounds.w);
    const y2 = Math.min(y + h, bounds.h);
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.max(0, x2 - x);
    h = Math.max(0, y2 - y);
  }
  return { x, y, w, h };
}

export function area(rect: Rect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

export function iou(a: Rect, b: Rect): number {
  const inter = area(intersection(a, b));
  if (inter === 0) return 0;
  return inter / (area(a) + area(b) - inter);
}

/**
 * Intersection over the *smaller* box. Unlike IoU this stays near 1 when a small
 * box sits fully inside a large one — exactly the "OCR line inside a detected ID
 * card" case we need to collapse.
 */
export function containment(a: Rect, b: Rect): number {
  const inter = area(intersection(a, b));
  if (inter === 0) return 0;
  const smaller = Math.min(area(a), area(b));
  return smaller === 0 ? 0 : inter / smaller;
}

export interface FuseOptions {
  /** Padding applied to every surviving box, in the same units as the boxes. */
  pad?: number;
  /** Clamp boxes to the viewport. */
  bounds?: { w: number; h: number };
  /** Containment above which two boxes are considered the same thing. */
  mergeThreshold?: number;
  /** Drop boxes smaller than this many square units — usually stray OCR noise. */
  minArea?: number;
}

/**
 * Merge overlapping detections. O(n²) by design: n is the number of secrets on
 * one screen, which is tens, not thousands, and a spatial index would cost more
 * to maintain than it saves.
 */
export function fuseDetections(detections: Detection[], options: FuseOptions = {}): Detection[] {
  const { pad = 3, bounds, mergeThreshold = 0.6, minArea = 16 } = options;

  const working = detections
    .filter((d) => area(d.bbox) >= minArea)
    // Highest priority first, so a merged group inherits the right type and token.
    .sort((a, b) => fusionRank(b) - fusionRank(a) || area(b.bbox) - area(a.bbox))
    .map((d) => ({ ...d, bbox: { ...d.bbox } }));

  const merged: Detection[] = [];
  for (const candidate of working) {
    const host = merged.find(
      (m) => containment(m.bbox, candidate.bbox) >= mergeThreshold,
    );

    if (!host) {
      merged.push(candidate);
      continue;
    }

    // Grow the surviving box to cover both. The host already has the higher
    // priority because of the sort, so its type and token are the ones to keep —
    // with one exception, below.
    host.bbox = union(host.bbox, candidate.bbox);
    host.confidence = Math.max(host.confidence, candidate.confidence);
    if (host.source !== candidate.source) host.detail = `${host.detail ?? host.source}+${candidate.source}`;

    // The DOM read what the page itself says a field is; the detector guessed from
    // pixels. When both describe one box, the DOM names it. The same mistake as the
    // GENERIC case above, with a confident class: the detector called an email field
    // `payment_card` at 98% on our own KYC page, and it went out as ⟦CARD_1⟧ instead
    // of ⟦PROFILE.EMAIL⟧. The detector's box still widens the redaction.
    if (host.source === 'vision' && candidate.source.startsWith('dom') && candidate.type !== 'FACE') {
      host.type = candidate.type;
      host.token = candidate.token;
      host.id = candidate.id;
      host.source = candidate.source;
      if (candidate.value !== undefined) host.value = candidate.value;
    }
  }

  return merged.map((d) => ({ ...d, bbox: padRect(d.bbox, pad, bounds) }));
}

/** Fraction of the viewport covered by redactions. Drives the disclosure level (§3.5). */
export function redactedAreaRatio(detections: Detection[], viewport: { w: number; h: number }): number {
  const total = viewport.w * viewport.h;
  if (total <= 0) return 0;
  // Boxes are already fused, so summing is close enough and much cheaper than
  // rasterising a coverage mask.
  const covered = detections.reduce((sum, d) => sum + area(d.bbox), 0);
  return Math.min(1, covered / total);
}
