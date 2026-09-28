/**
 * D38: a detector box over text or a control the DOM read and found clean is
 * dropped; everything the DOM cannot read stays. FAKE DATA ONLY (CLAUDE.md).
 */

import { describe, expect, it } from 'vitest';
import { coveredShare, dismissBoxesTheDomRead, type DomRead } from '../lib/vision/dom-read';
import type { Detection, PiiType, Rect } from '../lib/protocol';

const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

const det = (type: PiiType, bbox: Rect, source: Detection['source'], detail?: string): Detection => ({
  id: `${type}:${bbox.x},${bbox.y}`,
  type,
  bbox,
  confidence: 0.6,
  source,
  token: `⟦${type}_1⟧`,
  ...(detail ? { detail } : {}),
});

const sentence = { bbox: box(100, 100, 400, 20), text: 'Details fetched from your Aadhaar-linked record.' };
const onSentence = det('GENERIC', box(110, 98, 300, 24), 'vision', 'ui-detector:pii_text');

const page = (partial: Partial<DomRead> = {}): DomRead => ({
  elements: [],
  visibleText: [sentence],
  imageCandidates: [],
  ...partial,
});

describe('dismissBoxesTheDomRead', () => {
  it('drops a detector box over a sentence the DOM read and found clean', () => {
    expect(dismissBoxesTheDomRead([onSentence], page(), [])).toEqual([]);
  });

  it('drops a detector box over a form control the DOM read', () => {
    const gender = { bbox: box(100, 200, 300, 36) };
    const onSelect = det('GENERIC', box(104, 204, 120, 28), 'vision', 'ui-detector:pii_text');
    const password = det('PASSWORD', box(100, 200, 300, 36), 'vision', 'ui-detector:password_field');
    expect(dismissBoxesTheDomRead([onSelect, password], page({ elements: [gender] }), [])).toEqual([]);
  });

  it('keeps it where the DOM found something itself, so fusion can widen that box', () => {
    const email = det('EMAIL', box(120, 100, 200, 20), 'dom-text');
    expect(dismissBoxesTheDomRead([onSentence], page(), [email])).toEqual([onSentence]);
  });

  it('keeps it over pixels the DOM cannot read — an image, a canvas', () => {
    const canvas = { bbox: box(90, 90, 500, 300) };
    expect(dismissBoxesTheDomRead([onSentence], page({ imageCandidates: [canvas] }), [])).toEqual([onSentence]);
    const blank = det('GENERIC', box(700, 500, 200, 30), 'vision', 'ui-detector:pii_text');
    expect(dismissBoxesTheDomRead([blank], page(), [])).toEqual([blank]);
  });

  it('keeps it over a long number the rules would not name without context', () => {
    const numbered = page({ visibleText: [{ bbox: sentence.bbox, text: 'Ref 5012 3456 7890 credited' }] });
    expect(dismissBoxesTheDomRead([onSentence], numbered, [])).toEqual([onSentence]);
    const date = page({ visibleText: [{ bbox: sentence.bbox, text: 'Updated 31/10/2026' }] });
    expect(dismissBoxesTheDomRead([onSentence], date, [])).toEqual([]);
  });

  it('never touches a face, an OCR finding or an image hint', () => {
    const face = det('FACE', box(110, 98, 300, 24), 'vision', 'yunet');
    const ocr = det('AADHAAR', box(110, 98, 300, 24), 'ocr', 'tesseract');
    const hint = det('ID_DOCUMENT', box(110, 98, 300, 24), 'dom-image', 'document-like');
    expect(dismissBoxesTheDomRead([face, ocr, hint], page(), [])).toEqual([face, ocr, hint]);
  });
});

describe('coveredShare', () => {
  it('measures how much of a box lies under other boxes, without double counting', () => {
    const b = box(0, 0, 100, 100);
    expect(coveredShare(b, [])).toBe(0);
    expect(coveredShare(b, [box(0, 0, 100, 100)])).toBe(1);
    expect(coveredShare(b, [box(0, 0, 50, 100), box(0, 0, 50, 100)])).toBeCloseTo(0.5, 1);
  });
});
