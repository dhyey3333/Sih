import { beforeEach, describe, expect, it } from 'vitest';
import { isToken, Vault } from '../lib/pii/vault';
import { FAKE } from './fixtures';

let vault: Vault;

beforeEach(() => {
  vault = new Vault();
});

describe('tokenization', () => {
  it('produces a token, not the value', () => {
    const token = vault.tokenize('EMAIL', FAKE.email);
    expect(token).toBe('⟦EMAIL_1⟧');
    expect(token).not.toContain(FAKE.email);
    expect(isToken(token)).toBe(true);
  });

  it('is stable: the same value always gets the same token', () => {
    expect(vault.tokenize('EMAIL', FAKE.email)).toBe(vault.tokenize('EMAIL', FAKE.email));
    expect(vault.size).toBe(1);
  });

  it('treats separator variants as the same value', () => {
    const a = vault.tokenize('CARD', FAKE.card);
    const b = vault.tokenize('CARD', FAKE.cardSpaced);
    expect(b).toBe(a);
  });

  it('numbers distinct values of the same type', () => {
    expect(vault.tokenize('EMAIL', FAKE.email)).toBe('⟦EMAIL_1⟧');
    expect(vault.tokenize('EMAIL', FAKE.emailAlt)).toBe('⟦EMAIL_2⟧');
  });
});

describe('mintToken — labels for things with no text behind them', () => {
  it('numbers from the same counter as tokenize', () => {
    expect(vault.mintToken('FACE')).toBe('⟦FACE_1⟧');
    expect(vault.mintToken('FACE')).toBe('⟦FACE_2⟧');
  });

  it('stores nothing, so resolve correctly refuses to substitute it', () => {
    const token = vault.mintToken('FACE');
    expect(vault.size).toBe(0);
    expect(vault.resolve(token)).toBe(token);
    expect(vault.hasUnresolvedTokens(token)).toBe(true);
  });

  it('does not collide with a real tokenized value of the same type', () => {
    vault.tokenize('ID_DOCUMENT', 'scan-of-something');
    expect(vault.mintToken('ID_DOCUMENT')).toBe('⟦ID_DOCUMENT_2⟧');
  });
});

describe('profile', () => {
  it('exposes keys but never values', () => {
    vault.setProfile('EMAIL', FAKE.email);
    vault.setProfile('PHONE', FAKE.phone);
    expect(vault.profileKeys()).toEqual(['EMAIL', 'PHONE']);
  });

  it('gives profile values a PROFILE token', () => {
    vault.setProfile('EMAIL', FAKE.email);
    expect(vault.tokenize('EMAIL', FAKE.email)).toBe('⟦PROFILE.EMAIL⟧');
  });

  it('resolves a profile token back to the real value', () => {
    vault.setProfile('EMAIL', FAKE.email);
    expect(vault.resolve('⟦PROFILE.EMAIL⟧')).toBe(FAKE.email);
  });

  it('forgets a value when the key is cleared', () => {
    vault.setProfile('EMAIL', FAKE.email);
    vault.setProfile('EMAIL', '');
    expect(vault.profileKeys()).toEqual([]);
    expect(vault.resolve('⟦PROFILE.EMAIL⟧')).toBe('⟦PROFILE.EMAIL⟧');
  });
});

describe('resolve', () => {
  it('substitutes tokens inside a sentence', () => {
    const token = vault.tokenize('PHONE', FAKE.phone);
    expect(vault.resolve(`call ${token} now`)).toBe(`call ${FAKE.phone} now`);
  });

  it('leaves an unknown token untouched so it is visible, not silently dropped', () => {
    expect(vault.resolve('⟦AADHAAR_9⟧')).toBe('⟦AADHAAR_9⟧');
    expect(vault.hasUnresolvedTokens('⟦AADHAAR_9⟧')).toBe(true);
  });

  it('reports resolvable text as fully resolved', () => {
    const token = vault.tokenize('EMAIL', FAKE.email);
    expect(vault.hasUnresolvedTokens(token)).toBe(false);
  });
});

describe('findKnownValues', () => {
  it('locates a profile name that no regex could match', () => {
    vault.setProfile('FULL_NAME', FAKE.fullName);
    const found = vault.findKnownValues(`Welcome back, ${FAKE.fullName}!`);
    expect(found).toHaveLength(1);
    expect(found[0]!.token).toBe('⟦PROFILE.FULL_NAME⟧');
    expect(found[0]!.type).toBe('NAME');
  });

  it('is case-insensitive', () => {
    vault.setProfile('FULL_NAME', FAKE.fullName);
    expect(vault.findKnownValues(FAKE.fullName.toUpperCase())).toHaveLength(1);
  });

  it('returns non-overlapping ranges, longest first', () => {
    vault.setProfile('FULL_NAME', 'Ananya Iyer');
    vault.setProfile('ADDRESS', 'Ananya Iyer House, Mumbai');
    const found = vault.findKnownValues('Ananya Iyer House, Mumbai');
    expect(found).toHaveLength(1);
    expect(found[0]!.token).toBe('⟦PROFILE.ADDRESS⟧');
  });

  it('ignores values too short to match safely', () => {
    vault.setProfile('PINCODE', '400');
    expect(vault.findKnownValues('item 400 of 900')).toEqual([]);
  });
});

describe('session lifetime', () => {
  it('clearSession drops scanned values but keeps the profile', () => {
    vault.setProfile('EMAIL', FAKE.email);
    vault.tokenize('PHONE', FAKE.phone);
    vault.clearSession();
    expect(vault.profileKeys()).toEqual(['EMAIL']);
    expect(vault.resolve('⟦PHONE_1⟧')).toBe('⟦PHONE_1⟧');
  });

  it('clearAll drops everything', () => {
    vault.setProfile('EMAIL', FAKE.email);
    vault.clearAll();
    expect(vault.size).toBe(0);
    expect(vault.profileKeys()).toEqual([]);
  });
});
