import { describe, expect, it } from 'vitest';
import { MAX_DOM_ID, StableIds } from '../lib/dom/snapshot';
import { VISION_ID_BASE } from '../lib/vision/ui-detector';

describe('element ids that stay put', () => {
  it('gives an element the same id every time it is seen', () => {
    const ids = new StableIds();
    const a = {};
    const b = {};
    expect(ids.idFor(a)).toBe(1);
    expect(ids.idFor(b)).toBe(2);
    expect(ids.idFor(a)).toBe(1);
  });

  it('never re-issues an id to a new element — the wizard bug', () => {
    // Step 1's fields got 1 and 2; step 2's fields used to inherit those numbers
    // when step 1 was hidden, and were skipped as "already filled".
    const ids = new StableIds();
    const step1 = [{}, {}];
    step1.forEach((el) => ids.idFor(el));
    const step2 = [{}, {}];
    expect(step2.map((el) => ids.idFor(el))).toEqual([3, 4]);
  });

  it('stays clear of the ids reserved for controls found in pixels', () => {
    expect(MAX_DOM_ID).toBeLessThan(VISION_ID_BASE);
    const ids = new StableIds();
    let last = 0;
    for (let i = 0; i < MAX_DOM_ID + 5; i++) last = ids.idFor({});
    expect(last).toBeLessThan(VISION_ID_BASE);
  });
});
