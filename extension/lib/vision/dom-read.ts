/**
 * Detector boxes over what the DOM has already read (D38).
 *
 * The UI detector exists for what the DOM cannot see: a canvas-rendered form, a PDF
 * page, text inside an image (D1). On an ordinary page it also fires on text the DOM
 * layer has already read in full — and there it can only be wrong in one direction.
 * Measured on real screenshots of our own pages, every one of its `pii_text` boxes
 * that covered no personal data sat on text or a form control the DOM had read and
 * found clean: "Details fetched from your Aadhaar-linked record", a Gender dropdown,
 * a table header. On the demo site those boxes added no recall at all, and cost
 * twelve points of precision.
 *
 * So a detector box is dropped when all of this holds:
 *   - most of it is text or a control the DOM read (text blocks, element rects);
 *   - it is not over an image, canvas, video or SVG — pixels only it can read;
 *   - the DOM found nothing there itself (if it did, the box stays and fusion uses it
 *     to *widen* that redaction — never less covered);
 *   - the text under it has no long unlabelled number. The validators will not name
 *     eight-plus digits without a context word nearby, because most such numbers are
 *     order ids; a detector box over one is that context, and the box stays.
 *
 * What this gives up, said plainly: a person's name in running prose that neither the
 * vault nor a rule knows (no NER, D4) used to be covered when the detector happened to
 * box it. It is not now. Faces, ID cards, OCR findings and everything on a canvas are
 * untouched — this only ever looks at the detector's own boxes.
 */

import type { Detection, ImageCandidate, PageElement, Rect, VisibleTextBlock } from '../protocol';

/** Share of a box that must be DOM-read text or controls before the DOM speaks for it. */
const READ_SHARE = 0.5;

/** Eight or more digits, allowing the spaces and dashes numbers are written with. */
const LONG_NUMBER = /\d(?:[\s-]?\d){7,}/;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Of the box `a`, the share that lies inside `b`. */
function shareInside(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || a.w <= 0 || a.h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

/**
 * Of the box, the share covered by any of `rects`. Sampled on a grid rather than
 * summed, because text blocks and the controls around them overlap one another.
 */
export function coveredShare(box: Rect, rects: Rect[], samples = 16): number {
  const near = rects.filter((r) => overlaps(box, r));
  if (near.length === 0 || box.w <= 0 || box.h <= 0) return 0;
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const x = box.x + ((i + 0.5) / samples) * box.w;
      const y = box.y + ((j + 0.5) / samples) * box.h;
      if (near.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) inside++;
    }
  }
  return inside / (samples * samples);
}

export interface DomRead {
  elements: Pick<PageElement, 'bbox'>[];
  visibleText?: Pick<VisibleTextBlock, 'bbox' | 'text'>[];
  imageCandidates: Pick<ImageCandidate, 'bbox'>[];
}

export function dismissBoxesTheDomRead(
  detections: Detection[],
  snapshot: DomRead,
  domDetections: Pick<Detection, 'bbox'>[],
): Detection[] {
  const blocks = snapshot.visibleText ?? [];
  const read = [...blocks.map((b) => b.bbox), ...snapshot.elements.map((e) => e.bbox)];

  return detections.filter((d) => {
    // Only the UI detector's own boxes: faces, OCR findings and image hints stand.
    if (d.source !== 'vision' || !d.detail?.startsWith('ui-detector')) return true;
    if (snapshot.imageCandidates.some((c) => shareInside(d.bbox, c.bbox) > 0.2)) return true;
    if (domDetections.some((x) => overlaps(d.bbox, x.bbox))) return true;
    if (coveredShare(d.bbox, read) < READ_SHARE) return true;
    if (blocks.some((b) => overlaps(d.bbox, b.bbox) && LONG_NUMBER.test(b.text))) return true;
    return false;
  });
}
