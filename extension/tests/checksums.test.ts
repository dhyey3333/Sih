import { describe, expect, it } from 'vitest';
import {
  isLuhnValid,
  isPanStructureValid,
  isVerhoeffValid,
  verhoeffCheckDigit,
} from '../lib/pii/checksums';
import { FAKE } from './fixtures';

describe('Verhoeff (Aadhaar)', () => {
  it('accepts a checksum-valid number', () => {
    expect(isVerhoeffValid(FAKE.aadhaar)).toBe(true);
  });

  it('rejects a number with a bad check digit', () => {
    expect(isVerhoeffValid(FAKE.aadhaarBadChecksum)).toBe(false);
  });

  it('ignores separators', () => {
    expect(isVerhoeffValid(FAKE.aadhaarSpaced)).toBe(true);
    expect(isVerhoeffValid('2234-5678-9018')).toBe(true);
  });

  it('rejects anything that is not 12 digits', () => {
    expect(isVerhoeffValid('22345678901')).toBe(false);
    expect(isVerhoeffValid('2234567890188')).toBe(false);
    expect(isVerhoeffValid('')).toBe(false);
  });

  it('catches single-digit typos, which is the point of the checksum', () => {
    const digits = FAKE.aadhaar.split('');
    for (let i = 0; i < digits.length; i++) {
      const wrong = [...digits];
      wrong[i] = String((Number(digits[i]) + 1) % 10);
      expect(isVerhoeffValid(wrong.join('')), `typo at index ${i}`).toBe(false);
    }
  });

  it('generates check digits that validate', () => {
    for (const body of ['22345678901', '39876543210', '78901234567']) {
      expect(isVerhoeffValid(body + verhoeffCheckDigit(body))).toBe(true);
    }
  });
});

describe('Luhn (payment cards)', () => {
  it('accepts a valid test card', () => {
    expect(isLuhnValid(FAKE.card)).toBe(true);
  });

  it('rejects an invalid one', () => {
    expect(isLuhnValid(FAKE.cardBadChecksum)).toBe(false);
  });

  it('rejects lengths outside the card range', () => {
    expect(isLuhnValid('4111')).toBe(false);
    expect(isLuhnValid('41111111111111111111')).toBe(false);
  });
});

describe('PAN structure', () => {
  it('accepts a valid holder type', () => {
    expect(isPanStructureValid(FAKE.pan)).toBe(true);
  });

  it('rejects an invalid holder-type letter', () => {
    expect(isPanStructureValid(FAKE.panBadHolder)).toBe(false);
  });

  it('rejects the wrong shape', () => {
    expect(isPanStructureValid('ABCP1234K')).toBe(false);
    expect(isPanStructureValid('ABCPI1234')).toBe(false);
  });
});
