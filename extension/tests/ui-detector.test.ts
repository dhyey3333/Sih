import { describe, expect, it } from 'vitest';
import { decodeYolo, DETECTOR_CLASSES, undeclaredControls, VISION_ID_BASE } from '../lib/vision/ui-detector';

/**
 * The decoder's job is to turn a channel-major tensor into boxes in CSS pixels.
 * Reading that layout as anchor-major produces plausible-looking garbage — boxes in
 * the right count and the wrong places — which is exactly the kind of bug that
 * survives a visual check and ruins every metric downstream.
 */

const NUM_CLASSES = DETECTOR_CLASSES.length;
const ANCHORS = 40;

/** A YOLO11 output tensor with one anchor lit up. */
function output(peak?: { anchor: number; cls: number; cx: number; cy: number; w: number; h: number; score: number }) {
  const channels = 4 + NUM_CLASSES;
  const data = new Float32Array(channels * ANCHORS);
  if (peak) {
    // Channel-major: field `c` of anchor `a` lives at `c * ANCHORS + a`.
    data[0 * ANCHORS + peak.anchor] = peak.cx;
    data[1 * ANCHORS + peak.anchor] = peak.cy;
    data[2 * ANCHORS + peak.anchor] = peak.w;
    data[3 * ANCHORS + peak.anchor] = peak.h;
    data[(4 + peak.cls) * ANCHORS + peak.anchor] = peak.score;
  }
  return { output0: { data, dims: [1, channels, ANCHORS] as const } };
}

const PEAK = { anchor: 7, cls: 0, cx: 200, cy: 100, w: 80, h: 40, score: 0.9 };

describe('decodeYolo', () => {
  it('returns nothing for an empty tensor', () => {
    expect(decodeYolo(output(), { letterboxScale: 1, dpr: 1 })).toEqual([]);
  });

  it('converts centre-form to corner-form', () => {
    const [box] = decodeYolo(output(PEAK), { letterboxScale: 1, dpr: 1 });
    expect(box!.rect).toEqual({ x: 160, y: 80, w: 80, h: 40 });
  });

  it('undoes the letterbox scale and the device pixel ratio', () => {
    const [box] = decodeYolo(output(PEAK), { letterboxScale: 0.5, dpr: 2 });
    // /0.5 doubles into source pixels, /2 halves into CSS pixels — a wash on size,
    // but both must be applied or the box lands in the wrong place.
    expect(box!.rect).toEqual({ x: 160, y: 80, w: 80, h: 40 });
  });

  it('scales position and size together', () => {
    const [box] = decodeYolo(output(PEAK), { letterboxScale: 0.25, dpr: 1 });
    expect(box!.rect).toEqual({ x: 640, y: 320, w: 320, h: 160 });
  });

  it('reports the winning class', () => {
    for (let cls = 0; cls < NUM_CLASSES; cls++) {
      const [box] = decodeYolo(output({ ...PEAK, cls }), { letterboxScale: 1, dpr: 1 });
      expect(box!.classIndex, DETECTOR_CLASSES[cls]).toBe(cls);
    }
  });

  it('picks the highest-scoring class when several fire', () => {
    const tensor = output({ ...PEAK, cls: 1, score: 0.5 });
    tensor.output0.data[(4 + 3) * ANCHORS + PEAK.anchor] = 0.8;
    const [box] = decodeYolo(tensor, { letterboxScale: 1, dpr: 1 });
    expect(box!.classIndex).toBe(3);
    expect(box!.score).toBeCloseTo(0.8, 5);
  });

  it('respects the score threshold', () => {
    const weak = output({ ...PEAK, score: 0.2 });
    expect(decodeYolo(weak, { letterboxScale: 1, dpr: 1, scoreThreshold: 0.35 })).toEqual([]);
    expect(decodeYolo(weak, { letterboxScale: 1, dpr: 1, scoreThreshold: 0.1 })).toHaveLength(1);
  });

  it('suppresses duplicates of the same class', () => {
    const tensor = output(PEAK);
    // A near-identical box on a neighbouring anchor, as a real model emits.
    tensor.output0.data[0 * ANCHORS + 8] = 202;
    tensor.output0.data[1 * ANCHORS + 8] = 101;
    tensor.output0.data[2 * ANCHORS + 8] = 80;
    tensor.output0.data[3 * ANCHORS + 8] = 40;
    tensor.output0.data[4 * ANCHORS + 8] = 0.7;
    expect(decodeYolo(tensor, { letterboxScale: 1, dpr: 1 })).toHaveLength(1);
  });

  it('keeps a button overlapping an input, because NMS is per class', () => {
    const tensor = output(PEAK); // class 0, text_input
    tensor.output0.data[0 * ANCHORS + 9] = 200;
    tensor.output0.data[1 * ANCHORS + 9] = 100;
    tensor.output0.data[2 * ANCHORS + 9] = 80;
    tensor.output0.data[3 * ANCHORS + 9] = 40;
    tensor.output0.data[(4 + 1) * ANCHORS + 9] = 0.8; // class 1, button
    const boxes = decodeYolo(tensor, { letterboxScale: 1, dpr: 1 });
    expect(boxes.map((b) => b.classIndex).sort()).toEqual([0, 1]);
  });

  it('falls back to the known class count when dims are missing', () => {
    // Some runtimes hand back a bare typed array. The channel count is fixed by our
    // own class list, so the anchor count follows from the length.
    const tensor = output(PEAK);
    const withoutDims = { output0: { data: tensor.output0.data } };
    const [box] = decodeYolo(withoutDims, { letterboxScale: 1, dpr: 1 });
    expect(box!.rect).toEqual({ x: 160, y: 80, w: 80, h: 40 });
  });

  it('returns highest score first', () => {
    const tensor = output({ ...PEAK, anchor: 1, cls: 0, score: 0.5 });
    tensor.output0.data[0 * ANCHORS + 20] = 900;
    tensor.output0.data[1 * ANCHORS + 20] = 900;
    tensor.output0.data[2 * ANCHORS + 20] = 40;
    tensor.output0.data[3 * ANCHORS + 20] = 40;
    tensor.output0.data[(4 + 2) * ANCHORS + 20] = 0.95;
    const boxes = decodeYolo(tensor, { letterboxScale: 1, dpr: 1 });
    expect(boxes[0]!.score).toBeCloseTo(0.95, 5);
  });
});

describe('class contract', () => {
  it('matches ml/synth/classes.py exactly', () => {
    // The label index *is* the contract between the trainer and the extension.
    // Reordering here silently mislabels every detection.
    expect([...DETECTOR_CLASSES]).toEqual([
      'text_input',
      'button',
      'password_field',
      'pii_text',
      'payment_card',
      'id_document',
      'qr_code',
      'signature',
    ]);
  });

  it('keeps vision element ids clear of DOM ids', () => {
    // DOM ids start at 1 and are capped at 160 by the snapshot builder.
    expect(VISION_ID_BASE).toBeGreaterThan(160);
  });
});

describe('undeclaredControls — one name per control', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const found = [
    { id: 1000, role: 'button', bbox: box(301, 294, 83, 36), confidence: 0.9 }, // the DOM's Sign in button
    { id: 1001, role: 'textbox', bbox: box(300, 152, 680, 34), confidence: 0.9 }, // the DOM's email field
    { id: 1002, role: 'button', bbox: box(900, 600, 90, 36), confidence: 0.8 }, // drawn on a canvas
  ];
  const declared = [{ bbox: box(301, 293, 83, 37) }, { bbox: box(301, 153, 677, 32) }];

  it('drops a pixel copy of a control the DOM declares', () => {
    expect(undeclaredControls(found, declared).map((e) => e.id)).toEqual([1002]);
  });

  it('drops a pixel box drawn around a small control and its label', () => {
    const aroundRadio = [{ id: 1003, role: 'button', bbox: box(300, 400, 120, 24), confidence: 0.7 }];
    expect(undeclaredControls(aroundRadio, [{ bbox: box(305, 406, 13, 13) }])).toEqual([]);
  });

  it('keeps everything on a canvas app, where the DOM declares nothing', () => {
    expect(undeclaredControls(found, [])).toHaveLength(3);
  });
});
