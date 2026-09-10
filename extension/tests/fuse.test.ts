import { describe, expect, it } from 'vitest';
import { containment, fuseDetections, iou, padRect, redactedAreaRatio, union } from '../lib/redact/fuse';
import type { Detection, PiiType, Rect } from '../lib/protocol';

const det = (type: PiiType, bbox: Rect, source: Detection['source'] = 'dom-text'): Detection => ({
  id: `${type}:${bbox.x},${bbox.y}`,
  type,
  bbox,
  confidence: 0.9,
  source,
  token: `⟦${type}_1⟧`,
});

describe('geometry', () => {
  it('pads a rect on all sides', () => {
    expect(padRect({ x: 10, y: 10, w: 20, h: 8 }, 2)).toEqual({ x: 8, y: 8, w: 24, h: 12 });
  });

  it('clamps padding to the viewport so a box never leaves the image', () => {
    expect(padRect({ x: 1, y: 1, w: 10, h: 10 }, 5, { w: 12, h: 12 })).toEqual({
      x: 0,
      y: 0,
      w: 12,
      h: 12,
    });
  });

  it('computes IoU', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(0);
  });

  it('containment stays high for a small box inside a big one, where IoU collapses', () => {
    const big = { x: 0, y: 0, w: 100, h: 100 };
    const small = { x: 10, y: 10, w: 10, h: 10 };
    expect(iou(big, small)).toBeLessThan(0.05);
    expect(containment(big, small)).toBe(1);
  });

  it('unions two boxes', () => {
    expect(union({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
      x: 0,
      y: 0,
      w: 15,
      h: 15,
    });
  });
});

describe('fuseDetections', () => {
  it('keeps separate boxes apart', () => {
    const fused = fuseDetections([
      det('EMAIL', { x: 0, y: 0, w: 50, h: 16 }),
      det('PHONE', { x: 0, y: 100, w: 50, h: 16 }),
    ]);
    expect(fused).toHaveLength(2);
  });

  it('merges two boxes over the same value', () => {
    const fused = fuseDetections([
      det('EMAIL', { x: 10, y: 10, w: 100, h: 20 }, 'dom-text'),
      det('EMAIL', { x: 12, y: 11, w: 96, h: 18 }, 'ocr'),
    ]);
    expect(fused).toHaveLength(1);
  });

  it('keeps the higher-priority type when two types overlap', () => {
    const fused = fuseDetections([
      det('FACE', { x: 0, y: 0, w: 100, h: 100 }, 'vision'),
      det('ID_DOCUMENT', { x: 5, y: 5, w: 90, h: 90 }, 'vision'),
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.type).toBe('ID_DOCUMENT');
  });

  it('grows the surviving box to cover both, so no edge is left showing', () => {
    const fused = fuseDetections(
      [
        det('AADHAAR', { x: 10, y: 10, w: 100, h: 20 }),
        det('AADHAAR', { x: 60, y: 12, w: 100, h: 20 }),
      ],
      { pad: 0, mergeThreshold: 0.4 },
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]!.bbox.x).toBe(10);
    expect(fused[0]!.bbox.x + fused[0]!.bbox.w).toBe(160);
  });

  it('records that two sources agreed', () => {
    const fused = fuseDetections([
      det('EMAIL', { x: 10, y: 10, w: 100, h: 20 }, 'dom-text'),
      det('EMAIL', { x: 11, y: 11, w: 98, h: 18 }, 'vision'),
    ]);
    expect(fused[0]!.detail).toContain('vision');
  });

  it('drops sub-pixel noise from OCR', () => {
    expect(fuseDetections([det('EMAIL', { x: 0, y: 0, w: 2, h: 2 })])).toHaveLength(0);
  });

  it('pads every surviving box, because glyph edges bleed past their rect', () => {
    const fused = fuseDetections([det('EMAIL', { x: 20, y: 20, w: 50, h: 16 })], { pad: 3 });
    expect(fused[0]!.bbox).toEqual({ x: 17, y: 17, w: 56, h: 22 });
  });

  it('does not mutate the input', () => {
    const input = [det('EMAIL', { x: 20, y: 20, w: 50, h: 16 })];
    fuseDetections(input, { pad: 5 });
    expect(input[0]!.bbox).toEqual({ x: 20, y: 20, w: 50, h: 16 });
  });
});

describe('redactedAreaRatio', () => {
  it('is 0 with nothing redacted', () => {
    expect(redactedAreaRatio([], { w: 1000, h: 800 })).toBe(0);
  });

  it('measures the covered fraction, which drives the disclosure level', () => {
    const ratio = redactedAreaRatio([det('EMAIL', { x: 0, y: 0, w: 500, h: 800 })], { w: 1000, h: 800 });
    expect(ratio).toBeCloseTo(0.5, 5);
  });

  it('never exceeds 1', () => {
    const huge = [det('EMAIL', { x: 0, y: 0, w: 5000, h: 5000 })];
    expect(redactedAreaRatio(huge, { w: 100, h: 100 })).toBe(1);
  });
});
