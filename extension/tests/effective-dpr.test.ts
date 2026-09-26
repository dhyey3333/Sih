import { describe, expect, it } from 'vitest';
import { effectiveDpr } from '../lib/redact/render';

describe('effectiveDpr — the capture decides, not the page', () => {
  it('keeps the reported ratio when the capture agrees', () => {
    expect(effectiveDpr(2560, 1280, 2)).toBe(2);
    expect(effectiveDpr(1280, 1280, 1)).toBe(1);
  });

  it('corrects a page that claims 1 on a 2× screen (emulation, automation)', () => {
    // The case that left a typed email legible: every DOM box drawn at half its position.
    expect(effectiveDpr(2560, 1280, 1)).toBe(2);
  });

  it('follows browser zoom, which changes both sides together', () => {
    expect(effectiveDpr(1280, 1024, 1.25)).toBe(1.25);
  });

  it('ignores rounding between the two', () => {
    expect(effectiveDpr(2559, 1280, 2)).toBe(2);
  });

  it('falls back to the claim when there is nothing to measure', () => {
    expect(effectiveDpr(0, 1280, 2)).toBe(2);
    expect(effectiveDpr(2560, 0, 2)).toBe(2);
  });
});
