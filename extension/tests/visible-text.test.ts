import { beforeEach, describe, expect, it } from 'vitest';
import type { Detection, VisibleTextBlock } from '../lib/protocol';
import { guardPayload } from '../lib/pii/egress';
import { Vault } from '../lib/pii/vault';
import { buildVisibleText } from '../lib/pii/visible-text';
import { FAKE } from './fixtures';

let vault: Vault;

beforeEach(() => {
  vault = new Vault();
});

function block(text: string, extra: Partial<VisibleTextBlock> = {}): VisibleTextBlock {
  return { text, bbox: { x: 0, y: 0, w: 300, h: 20 }, spans: [], context: '', ...extra };
}

function span(text: string, value: string, type: VisibleTextBlock['spans'][number]['type']) {
  const start = text.indexOf(value);
  return { start, end: start + value.length, type, value };
}

function detection(overrides: Partial<Detection>): Detection {
  return {
    id: 'd',
    type: 'GENERIC',
    bbox: { x: 0, y: 0, w: 300, h: 20 },
    confidence: 0.9,
    source: 'vision',
    token: '⟦GENERIC_1⟧',
    ...overrides,
  };
}

describe('buildVisibleText', () => {
  it('swaps each marked span for the token its box carries', () => {
    const text = `Contact: ${FAKE.email}`;
    const boxToken = vault.tokenize('EMAIL', FAKE.email); // what detectionsFromText assigns
    const out = buildVisibleText([block(text, { spans: [span(text, FAKE.email, 'EMAIL')] })], [], vault);
    expect(out).toBe(`Contact: ${boxToken}`);
    expect(out).not.toContain(FAKE.email);
  });

  it('tokenizes a context-dependent value using the words around the block', () => {
    // A bare six-digit number is only an OTP because the label beside it says so.
    const out = buildVisibleText([block(FAKE.otp, { context: 'Enter the OTP sent to your phone' })], [], vault);
    expect(out).not.toContain(FAKE.otp);
    expect(out).toMatch(/^⟦OTP_\d+⟧$/);
  });

  it('catches what the span pass missed with a second sanitizer pass', () => {
    const out = buildVisibleText([block(`Write to ${FAKE.emailAlt}`)], [], vault);
    expect(out).not.toContain(FAKE.emailAlt);
    expect(out).toContain('⟦EMAIL_');
  });

  it('withholds a block a pixel detector covered, even when the text rules found nothing', () => {
    // The name is invisible to every pattern; only vision flagged the region.
    const out = buildVisibleText(
      [block('Beneficiary Raghunath Kulkarni'), block('Status: Approved', { bbox: { x: 0, y: 40, w: 300, h: 20 } })],
      [detection({ bbox: { x: 90, y: 2, w: 150, h: 16 }, token: '⟦GENERIC_4⟧' })],
      vault,
    );
    expect(out).toBe('⟦GENERIC_4⟧\nStatus: Approved');
    expect(out).not.toContain('Raghunath');
  });

  it('does the same for OCR boxes', () => {
    const out = buildVisibleText([block('Card on file')], [detection({ source: 'ocr', type: 'CARD', token: '⟦CARD_2⟧' })], vault);
    expect(out).toBe('⟦CARD_2⟧');
  });

  it('does not let a face withhold the caption beside it', () => {
    const out = buildVisibleText([block('Profile photo')], [detection({ type: 'FACE', token: '⟦FACE_1⟧' })], vault);
    expect(out).toBe('Profile photo');
  });

  it('ignores a pixel box that merely grazes the block', () => {
    const out = buildVisibleText(
      [block('Next steps')],
      [detection({ bbox: { x: 295, y: 18, w: 200, h: 200 } })],
      vault,
    );
    expect(out).toBe('Next steps');
  });

  it('collapses whitespace and drops a repeated line', () => {
    const covered = [detection({ token: '⟦GENERIC_1⟧' })];
    const out = buildVisibleText([block('  Line \n one  '), block('a'), block('b')], covered, vault);
    // All three blocks share the box's position, so each reads as the same token once.
    expect(out).toBe('⟦GENERIC_1⟧');
    expect(buildVisibleText([block('  Line \n one  ')], [], vault)).toBe('Line one');
  });

  it('stops at the budget, at a line boundary', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => block(`Line number ${i} of the page`));
    const out = buildVisibleText(blocks, [], vault, 200);
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out.endsWith('\n…')).toBe(true);
  });

  it('never cuts a token in half when a block is clamped', () => {
    // No space to cut at, and the 400-character limit falls inside the token.
    const long = `${'a'.repeat(395)}${FAKE.email}`;
    const out = buildVisibleText([block(long, { spans: [span(long, FAKE.email, 'EMAIL')] })], [], vault);
    expect(out).toBe(`${'a'.repeat(395)}…`);
  });

  it('produces text the egress guard accepts', () => {
    vault.setProfile('FULL_NAME', FAKE.fullName);
    vault.setProfile('EMAIL', FAKE.email);
    const text = `Welcome back, ${FAKE.fullName}. We sent a receipt to ${FAKE.email} and ${FAKE.phone}.`;
    const out = buildVisibleText([block(text, { spans: [span(text, FAKE.fullName, 'NAME')] })], [], vault);
    expect(out).toContain('⟦PROFILE.FULL_NAME⟧');
    expect(out).toContain('⟦PROFILE.EMAIL⟧');
    const report = guardPayload({ visible_text: out }, { secrets: vault.secrets() });
    expect(report.incidents).toEqual([]);
  });
});
