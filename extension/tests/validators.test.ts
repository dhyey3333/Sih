import { describe, expect, it } from 'vitest';
import { classifyValue, normalizeForCompare, scanText } from '../lib/pii/validators';
import type { PiiType } from '../lib/protocol';
import { FAKE, NOT_PII } from './fixtures';

const typesIn = (text: string, context?: string): PiiType[] =>
  scanText(text, { context }).map((m) => m.type);

describe('recall — every supported type is found', () => {
  it.each([
    ['email', `Contact ${FAKE.email} for details`, 'EMAIL'],
    ['Indian mobile', `Call ${FAKE.phone} today`, 'PHONE'],
    ['mobile with country code', `Call ${FAKE.phoneWithCode}`, 'PHONE'],
    ['Aadhaar', `Aadhaar ${FAKE.aadhaarSpaced}`, 'AADHAAR'],
    ['PAN', `PAN ${FAKE.pan}`, 'PAN'],
    ['card', `Card ${FAKE.cardSpaced}`, 'CARD'],
    ['IFSC', `IFSC ${FAKE.ifsc}`, 'IFSC'],
    ['UPI', `Pay ${FAKE.upi}`, 'UPI'],
  ])('finds %s', (_name, text, expected) => {
    expect(typesIn(text)).toContain(expected);
  });

  it('finds PII inside a realistic block of page text', () => {
    const text =
      `Welcome back. Email: ${FAKE.email}. Mobile: ${FAKE.phone}. ` +
      `Aadhaar: ${FAKE.aadhaarSpaced}. PAN: ${FAKE.pan}. IFSC: ${FAKE.ifsc}.`;
    const found = new Set(typesIn(text));
    expect(found).toEqual(new Set(['EMAIL', 'PHONE', 'AADHAAR', 'PAN', 'IFSC']));
  });
});

describe('precision — ordinary page text is left alone', () => {
  it.each(Object.entries(NOT_PII))('does not fire on %s', (_name, text) => {
    expect(scanText(text)).toEqual([]);
  });

  it('rejects a checksum-invalid Aadhaar', () => {
    expect(typesIn(`Aadhaar ${FAKE.aadhaarBadChecksum}`)).not.toContain('AADHAAR');
  });

  it('rejects a checksum-invalid card', () => {
    expect(typesIn(`Card ${FAKE.cardBadChecksum}`)).not.toContain('CARD');
  });

  it('rejects a PAN with an impossible holder-type letter', () => {
    expect(typesIn(`PAN ${FAKE.panBadHolder}`)).not.toContain('PAN');
  });
});

describe('context-dependent rules', () => {
  it('ignores a bare 6-digit number', () => {
    expect(scanText('482913')).toEqual([]);
  });

  it('reads it as an OTP when the surrounding text says so', () => {
    expect(typesIn(`Your OTP is ${FAKE.otp}`)).toContain('OTP');
  });

  it('accepts context supplied from the field label', () => {
    expect(typesIn(FAKE.otp, 'Enter the OTP we sent you')).toContain('OTP');
  });

  it('reads a PIN code only with a postal context', () => {
    expect(scanText(FAKE.pincode)).toEqual([]);
    expect(typesIn(`PIN code ${FAKE.pincode}`)).toContain('PINCODE');
  });

  it('reads a date as DOB only with a birth context', () => {
    expect(typesIn(`Invoice date ${FAKE.dob}`)).not.toContain('DOB');
    expect(typesIn(`Date of birth ${FAKE.dob}`)).toContain('DOB');
  });

  it('requires a passport context for the passport pattern', () => {
    expect(typesIn(`Model ${FAKE.passport} in stock`)).not.toContain('PASSPORT');
    expect(typesIn(`Passport number ${FAKE.passport}`)).toContain('PASSPORT');
  });
});

describe('UPI vs email', () => {
  it('classifies a dotted domain as an email, never a UPI id', () => {
    const types = typesIn(FAKE.email);
    expect(types).toContain('EMAIL');
    expect(types).not.toContain('UPI');
  });

  it('classifies a known bank handle as UPI', () => {
    expect(typesIn(FAKE.upi)).toContain('UPI');
  });

  it('ignores a social mention with an unknown handle', () => {
    expect(typesIn('ping @someuser about it')).not.toContain('UPI');
  });

  it('accepts an unknown handle when the context says UPI', () => {
    expect(typesIn('UPI ID: rahul@newbank')).toContain('UPI');
  });
});

describe('overlap resolution', () => {
  it('keeps the card, not the phone-shaped digits inside it', () => {
    const matches = scanText(`Card ${FAKE.card}`);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.type).toBe('CARD');
  });

  it('returns matches in document order with non-overlapping spans', () => {
    const text = `${FAKE.email} then ${FAKE.phone} then ${FAKE.pan}`;
    const matches = scanText(text);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.end);
    }
  });

  it('reports spans that map back to the original string', () => {
    const text = `Email: ${FAKE.email}!`;
    const match = scanText(text)[0]!;
    expect(text.slice(match.start, match.end)).toBe(FAKE.email);
  });
});

describe('classifyValue', () => {
  it('classifies a whole field value', () => {
    expect(classifyValue(FAKE.email)?.type).toBe('EMAIL');
    expect(classifyValue(`  ${FAKE.aadhaarSpaced}  `)?.type).toBe('AADHAAR');
  });

  it('returns null for an empty or harmless value', () => {
    expect(classifyValue('')).toBeNull();
    expect(classifyValue('Mumbai')).toBeNull();
  });
});

describe('normalizeForCompare', () => {
  it('makes separator variants of the same value compare equal', () => {
    expect(normalizeForCompare('4111 1111 1111 1111')).toBe(normalizeForCompare('4111-1111-1111-1111'));
    expect(normalizeForCompare('+91 (98) 1234-5678')).toBe('+919812345678');
  });
});
