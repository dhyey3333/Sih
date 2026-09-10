import { describe, expect, it } from 'vitest';
import { decodeFaces, nonMaxSuppression, YUNET_INPUT_SIZE } from '../lib/vision/yunet';
import type { FaceBox } from '../lib/vision/yunet';

/**
 * These cover the part of the vision layer that has no excuse for being wrong: the
 * coordinate math. A model that detects perfectly but reports boxes in the wrong
 * space redacts the wrong pixels, which is worse than not detecting at all — the UI
 * would show a confident black rectangle over empty background while the face stays
 * visible. `letterbox` itself needs a real canvas, so it is exercised in the browser.
 */

const STRIDE_CELLS = { 8: 6400, 16: 1600, 32: 400 } as const;

/** Zero-filled YuNet outputs, with one anchor optionally lit up. */
function outputs(
  peak?: { stride: 8 | 16 | 32; col: number; row: number; dx: number; dy: number; logW: number; logH: number; score: number },
) {
  const out: Record<string, { data: Float32Array }> = {};
  for (const stride of [8, 16, 32] as const) {
    const cells = STRIDE_CELLS[stride];
    out[`cls_${stride}`] = { data: new Float32Array(cells) };
    out[`obj_${stride}`] = { data: new Float32Array(cells) };
    out[`bbox_${stride}`] = { data: new Float32Array(cells * 4) };
    out[`kps_${stride}`] = { data: new Float32Array(cells * 10) };
  }

  if (peak) {
    const gridWidth = YUNET_INPUT_SIZE / peak.stride;
    const i = peak.row * gridWidth + peak.col;
    // score = sqrt(cls * obj), so setting both to the score squared is exact.
    out[`cls_${peak.stride}`]!.data[i] = peak.score;
    out[`obj_${peak.stride}`]!.data[i] = peak.score;
    const b = out[`bbox_${peak.stride}`]!.data;
    b[i * 4] = peak.dx;
    b[i * 4 + 1] = peak.dy;
    b[i * 4 + 2] = peak.logW;
    b[i * 4 + 3] = peak.logH;
  }
  return out;
}

/** Centre of cell (10, 20) at stride 8, an 8×8 box: model-space x=80, y=160, w=8, h=8. */
const PEAK = { stride: 8, col: 10, row: 20, dx: 0.5, dy: 0.5, logW: 0, logH: 0, score: 1 } as const;

describe('decodeFaces', () => {
  it('finds nothing in an empty output', () => {
    expect(decodeFaces(outputs(), { letterboxScale: 1, dpr: 1 })).toEqual([]);
  });

  it('places a box correctly with no scaling at all', () => {
    const [face] = decodeFaces(outputs(PEAK), { letterboxScale: 1, dpr: 1 });
    expect(face!.rect).toEqual({ x: 80, y: 160, w: 8, h: 8 });
    expect(face!.score).toBeCloseTo(1, 5);
  });

  it('undoes the letterbox downscale', () => {
    // The frame was halved to fit 640×640, so every coordinate doubles on the way back.
    const [face] = decodeFaces(outputs(PEAK), { letterboxScale: 0.5, dpr: 1 });
    expect(face!.rect).toEqual({ x: 160, y: 320, w: 16, h: 16 });
  });

  it('converts device pixels to CSS pixels', () => {
    const [face] = decodeFaces(outputs(PEAK), { letterboxScale: 1, dpr: 2 });
    expect(face!.rect).toEqual({ x: 40, y: 80, w: 4, h: 4 });
  });

  it('applies the crop offset in device space, before the dpr divide', () => {
    // This ordering is the whole point: the offset is where the crop sat in the
    // capture, which is device pixels; dividing it by dpr afterwards is what makes
    // a close-up detection land back on the right part of the page.
    const [face] = decodeFaces(outputs(PEAK), {
      letterboxScale: 0.5,
      offsetX: 100,
      offsetY: 50,
      dpr: 2,
    });
    expect(face!.rect).toEqual({ x: 130, y: 185, w: 8, h: 8 });
  });

  it('respects the score threshold', () => {
    const weak = { ...PEAK, score: 0.4 };
    expect(decodeFaces(outputs(weak), { letterboxScale: 1, dpr: 1, scoreThreshold: 0.6 })).toEqual([]);
    expect(
      decodeFaces(outputs(weak), { letterboxScale: 1, dpr: 1, scoreThreshold: 0.3 }),
    ).toHaveLength(1);
  });

  it('reads every stride, not just the first', () => {
    for (const stride of [8, 16, 32] as const) {
      const found = decodeFaces(outputs({ ...PEAK, stride, col: 2, row: 3 }), {
        letterboxScale: 1,
        dpr: 1,
      });
      expect(found, `stride ${stride}`).toHaveLength(1);
    }
  });

  it('scales the box with the stride it came from', () => {
    // Cell (2, 3) exists in every grid; stride 32's is only 20×20, so PEAK's
    // row 20 would fall off the end of it.
    const cell = { col: 2, row: 3 };
    const at8 = decodeFaces(outputs({ ...PEAK, ...cell, stride: 8 }), { letterboxScale: 1, dpr: 1 })[0]!;
    const at32 = decodeFaces(outputs({ ...PEAK, ...cell, stride: 32 }), { letterboxScale: 1, dpr: 1 })[0]!;
    expect(at32.rect.w).toBe(at8.rect.w * 4);
    expect(at32.rect.x).toBe(at8.rect.x * 4);
  });

  it('caps the number of faces returned', () => {
    const many = outputs();
    const cls = many.cls_8!.data;
    const obj = many.obj_8!.data;
    // Spread them out so NMS does not merge them away.
    for (let i = 0; i < 100; i++) {
      cls[i * 9] = 1;
      obj[i * 9] = 1;
    }
    expect(decodeFaces(many, { letterboxScale: 1, dpr: 1, maxFaces: 5 })).toHaveLength(5);
  });
});

describe('nonMaxSuppression', () => {
  const box = (x: number, y: number, size: number, score: number): FaceBox => ({
    rect: { x, y, w: size, h: size },
    score,
  });

  it('keeps the higher-scoring of two overlapping boxes', () => {
    const kept = nonMaxSuppression([box(0, 0, 100, 0.7), box(5, 5, 100, 0.9)], 0.3);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.score).toBe(0.9);
  });

  it('keeps boxes that do not overlap', () => {
    expect(nonMaxSuppression([box(0, 0, 50, 0.9), box(500, 500, 50, 0.8)], 0.3)).toHaveLength(2);
  });

  it('keeps two faces that merely sit close together', () => {
    // Adjacent portraits in a row must not collapse into one box.
    expect(nonMaxSuppression([box(0, 0, 100, 0.9), box(90, 0, 100, 0.9)], 0.3)).toHaveLength(2);
  });

  it('returns results highest score first', () => {
    const kept = nonMaxSuppression([box(0, 0, 40, 0.5), box(300, 0, 40, 0.95), box(600, 0, 40, 0.7)], 0.3);
    expect(kept.map((k) => k.score)).toEqual([0.95, 0.7, 0.5]);
  });

  it('handles an empty list', () => {
    expect(nonMaxSuppression([], 0.3)).toEqual([]);
  });
});
