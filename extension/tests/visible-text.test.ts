import { beforeEach, describe, expect, it } from 'vitest';
import type { Detection, VisibleTextBlock } from '../lib/protocol';
import { guardPayload } from '../lib/pii/egress';
import { Vault } from '../lib/pii/vault';
import { buildVisibleText, dismissFutureDateBoxes, parseDate } from '../lib/pii/visible-text';
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

  it('lets a vague pixel box over a value the text layer tokenized use that token', () => {
    const text = `Registered email ${FAKE.email}`;
    const out = buildVisibleText(
      [block(text, { spans: [span(text, FAKE.email, 'EMAIL')] })],
      [
        detection({ source: 'dom-text', type: 'EMAIL', bbox: { x: 120, y: 2, w: 170, h: 16 }, token: '⟦EMAIL_1⟧' }),
        detection({ bbox: { x: 118, y: 0, w: 176, h: 20 }, token: '⟦GENERIC_9⟧' }),
      ],
      vault,
    );
    expect(out).toMatch(/^Registered email ⟦EMAIL_\d+⟧$/);
    expect(out).not.toContain('GENERIC');
  });

  it('still withholds a block when the vague box is over something the text layer found clean', () => {
    const out = buildVisibleText(
      [block('Last date to apply 31 October 2026')],
      [
        detection({ source: 'dom-text', type: 'EMAIL', bbox: { x: 0, y: 200, w: 50, h: 16 } }), // elsewhere
        detection({ bbox: { x: 150, y: 2, w: 120, h: 16 }, token: '⟦GENERIC_3⟧' }),
      ],
      vault,
    );
    expect(out).toBe('⟦GENERIC_3⟧');
  });

  it('is not fooled by one known value inside a large vague box', () => {
    const text = `Beneficiary Raghunath Kulkarni, contact ${FAKE.email}`;
    const out = buildVisibleText(
      [block(text, { spans: [span(text, FAKE.email, 'EMAIL')] })],
      [
        detection({ source: 'dom-text', type: 'EMAIL', bbox: { x: 200, y: 2, w: 90, h: 16 } }),
        detection({ bbox: { x: 0, y: 0, w: 300, h: 20 }, token: '⟦GENERIC_5⟧' }), // the whole line
      ],
      vault,
    );
    expect(out).toBe('⟦GENERIC_5⟧');
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

describe('a label and its value read as one line', () => {
  it('joins a value to the label written just before it', () => {
    const text = FAKE.email;
    const out = buildVisibleText(
      [block('Registered email'), block(text, { label: 'Registered email', spans: [span(text, FAKE.email, 'EMAIL')] })],
      [],
      vault,
    );
    expect(out).toMatch(/^Registered email: ⟦EMAIL_\d+⟧$/);
  });

  it('leaves lines apart when the label is someone else\'s', () => {
    expect(buildVisibleText([block('Next steps'), block('Approved', { label: 'Status' })], [], vault))
      .toBe('Next steps\nApproved');
  });
});

describe('dismissFutureDateBoxes — a deadline is nobody\'s date of birth', () => {
  const today = new Date(2026, 8, 26);
  const vague = detection({ bbox: { x: 150, y: 2, w: 120, h: 16 }, token: '⟦GENERIC_3⟧' });

  it('drops a vague box over a future date the text layer found clean', () => {
    expect(dismissFutureDateBoxes([vague], [block('31 October 2026')], today)).toEqual([]);
    expect(dismissFutureDateBoxes([vague], [block('Until 15 November 2026')], today)).toEqual([]);
    expect(dismissFutureDateBoxes([vague], [block('Last date: 31/10/2026')], today)).toEqual([]);
  });

  it('keeps it over a past date — that one could be a birth date', () => {
    expect(dismissFutureDateBoxes([vague], [block('14 March 2001')], today)).toHaveLength(1);
  });

  it('keeps it over anything that is not only a date', () => {
    expect(dismissFutureDateBoxes([vague], [block('Raghunath Kulkarni, 31 October 2026')], today)).toHaveLength(1);
    expect(dismissFutureDateBoxes([vague], [block('Mayor 12 2030')], today)).toHaveLength(1);
  });

  it('keeps it where the text layer found something', () => {
    const text = '31 October 2026';
    expect(dismissFutureDateBoxes([vague], [block(text, { spans: [span(text, text, 'DOB')] })], today)).toHaveLength(1);
  });

  it('never touches a specific class, or anything but vision', () => {
    const card = detection({ type: 'CARD', bbox: vague.bbox });
    const ocr = detection({ source: 'ocr', bbox: vague.bbox });
    expect(dismissFutureDateBoxes([card, ocr], [block('31 October 2026')], today)).toHaveLength(2);
  });

  it('parses the forms Indian portals use', () => {
    expect(parseDate('31 October 2026')?.getMonth()).toBe(9);
    expect(parseDate('October 31, 2026')?.getDate()).toBe(31);
    expect(parseDate('1st Sept 2026')?.getMonth()).toBe(8);
    expect(parseDate('31/10/2026')?.getMonth()).toBe(9); // day first
    expect(parseDate('2026-10-31')?.getDate()).toBe(31);
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('Approved')).toBeNull();
  });
});
