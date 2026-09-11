/**
 * The side panel resolves every element by id at module load and throws if one is
 * missing, so a rename in the markup takes the whole panel down — blank, on the one
 * surface anybody looks at, and only at runtime.
 *
 * This reads both files as text and checks they still agree. It is not a DOM test;
 * it is a spelling test, which is the failure that actually happens.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = join(__dirname, '..', 'entrypoints', 'sidepanel');
const html = readFileSync(join(panel, 'index.html'), 'utf8');
const main = readFileSync(join(panel, 'main.ts'), 'utf8');
const css = readFileSync(join(panel, 'style.css'), 'utf8');

const markupIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
const requestedIds = [...main.matchAll(/\$(?:<[^>]+>)?\('([^']+)'\)/g)].map((m) => m[1]!);

describe('markup and script agree', () => {
  it('requests at least the handles the panel is built from', () => {
    expect(requestedIds.length).toBeGreaterThan(20);
  });

  it.each([...new Set(requestedIds)])('#%s exists in the markup', (id) => {
    expect(markupIds.has(id)).toBe(true);
  });
});

describe('the privacy claims in the markup are the ones the code can keep', () => {
  it('never ships a real-looking value in the placeholder copy', () => {
    // Fixtures, demos and screenshots use fake data only (CLAUDE.md). A stray
    // realistic-looking number in static copy would be indistinguishable from one.
    expect(html).not.toMatch(/\b\d{12}\b/);
    expect(html).not.toMatch(/\b[2-9]\d{3}\s\d{4}\s\d{4}\b/);
  });

  it('labels the comparison so neither half can be mistaken for the other', () => {
    expect(html).toContain('id="stage-badge-left"');
    expect(html).toContain('id="stage-badge-right"');
  });
});

describe('style discipline', () => {
  it('keeps `hidden` working even on flex and grid elements', () => {
    // Several of these elements are display:flex, which overrides the UA rule for
    // [hidden]; without this the confirmation sheet is permanently on screen.
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('does not let a section shrink out of the scroller', () => {
    // `.scroll` is a flex column; flex children shrink by default, and a group with
    // overflow:hidden then clips its own rows instead of scrolling.
    expect(css).toMatch(/\.scroll\s*>\s*\*\s*\{\s*flex:\s*none/);
  });

  it('respects prefers-reduced-motion', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('defines the dark palette for both an explicit choice and the system default', () => {
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});
