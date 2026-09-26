/**
 * Gate 4 — the prompt-injection defence. A page can talk a model into asking for
 * the user's Aadhaar in a search box; the value's type (known only locally) must
 * match the type the DOM layer detected for the field, or the user decides.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { checkValueTarget } from '../lib/type-gate';
import { Vault, type ProfileKey } from '../lib/pii/vault';
import { DEMO_PROFILE } from '../lib/demo-profile';
import type { WireElement } from '../lib/protocol';

let vault: Vault;
beforeEach(() => {
  vault = new Vault();
  for (const [k, v] of Object.entries(DEMO_PROFILE)) vault.setProfile(k as ProfileKey, v);
});

const el = (partial: Partial<WireElement>): WireElement => ({
  id: 2, role: 'textbox', bbox: [0, 0, 200, 30], ...partial,
});

describe('the injection this exists to stop', () => {
  it('refuses to put an Aadhaar number into a search box', () => {
    const verdict = checkValueTarget('⟦PROFILE.AADHAAR⟧', el({ label: 'Search Wikipedia' }), vault);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.valueType).toBe('AADHAAR');
      expect(verdict.question).toContain('Aadhaar number');
      expect(verdict.question).toContain('Search Wikipedia');
    }
  });

  it('refuses an email going into a field detected as a phone number', () => {
    const verdict = checkValueTarget('⟦PROFILE.EMAIL⟧', el({ label: 'Mobile', sensitive: 'PHONE' }), vault);
    expect(verdict.ok).toBe(false);
  });

  it('catches a value wrapped in prose, e.g. for a chat box', () => {
    const verdict = checkValueTarget('My Aadhaar is ⟦PROFILE.AADHAAR⟧', el({ label: 'Message' }), vault);
    expect(verdict.ok).toBe(false);
  });

  it('always asks for a control found in pixels, which has no DOM classification', () => {
    expect(checkValueTarget('⟦PROFILE.PAN⟧', undefined, vault).ok).toBe(false);
  });
});

describe('what it lets through', () => {
  it.each([
    ['⟦PROFILE.AADHAAR⟧', 'AADHAAR'],
    ['⟦PROFILE.EMAIL⟧', 'EMAIL'],
    ['⟦PROFILE.PHONE⟧', 'PHONE'],
    ['⟦PROFILE.FULL_NAME⟧', 'NAME'],
  ] as const)('%s into a field detected as %s', (text, sensitive) => {
    expect(checkValueTarget(text, el({ sensitive }), vault).ok).toBe(true);
  });

  it('plain text, which carries no value from the vault', () => {
    expect(checkValueTarget('Mumbai', el({ label: 'City' }), vault).ok).toBe(true);
  });

  it('an unknown token, which gate 1 refuses on its own', () => {
    expect(checkValueTarget('⟦AADHAAR_9⟧', el({ label: 'Search' }), vault).ok).toBe(true);
  });
});
