/**
 * Gate 4 — the prompt-injection defence. A page can talk a model into asking for
 * the user's Aadhaar in a search box; the value's type (known only locally) must
 * match the type the DOM layer detected for the field, or the user decides.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { checkInventedValue, checkRetype, checkValueTarget } from '../lib/type-gate';
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

describe('a value the planner made up', () => {
  it('is asked about when it looks like personal data', () => {
    // What a 3B model actually sent: an address it could not have been told.
    const verdict = checkInventedValue('ananya.ier@example.com', el({ label: 'Email address', sensitive: 'EMAIL' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.valueType).toBe('EMAIL');
      expect(verdict.question).toContain('an email address it made up');
    }
  });

  it('uses the field label as context, so an invented date of birth is caught', () => {
    expect(checkInventedValue('14/03/2001', el({ label: 'Date of birth', sensitive: 'DOB' })).ok).toBe(false);
  });

  it('lets ordinary text through', () => {
    expect(checkInventedValue('Mumbai', el({ label: 'City', sensitive: 'ADDRESS' })).ok).toBe(true);
    expect(checkInventedValue('post-matric scholarships', el({ role: 'searchbox' })).ok).toBe(true);
  });

  it('lets a token through — that is how a real value arrives', () => {
    expect(checkInventedValue('⟦PROFILE.EMAIL⟧', el({ sensitive: 'EMAIL' })).ok).toBe(true);
  });
});

describe('a value from one site, bound for another', () => {
  const emailField = el({ label: 'Email', sensitive: 'EMAIL' });

  it('is asked about even when the field type matches', () => {
    // The attack gate 4's type check alone lets through: an email into an email field.
    vault.setPage('https://site-a.example');
    const seen = vault.tokenize('EMAIL', 'r.mehta@mailinator.example');
    const verdict = checkValueTarget(seen, emailField, vault, 'https://site-b.example');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.question).toContain('site-a.example');
      expect(verdict.question).toContain('site-b.example');
    }
  });

  it('goes through on the site it came from', () => {
    vault.setPage('https://site-a.example');
    const seen = vault.tokenize('EMAIL', 'r.mehta@mailinator.example');
    expect(checkValueTarget(seen, emailField, vault, 'https://site-a.example').ok).toBe(true);
  });

  it('never applies to the user’s own profile', () => {
    vault.setPage('https://site-a.example');
    expect(checkValueTarget('⟦PROFILE.EMAIL⟧', emailField, vault, 'https://site-b.example').ok).toBe(true);
  });
});

describe('overwriting one of your values', () => {
  it('is asked about when the replacement is the planner’s own text', () => {
    // What a 3B model did: a name filled from the profile, replaced with "John Doe".
    const filled = el({ label: 'Candidate name', sensitive: 'NAME', value: '⟦PROFILE.FULL_NAME⟧' });
    const verdict = checkInventedValue('John Doe', filled);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.question).toContain('replace');
  });

  it('is fine when the replacement is itself a token, or the field is empty', () => {
    const filled = el({ label: 'Candidate name', sensitive: 'NAME', value: '⟦PROFILE.FULL_NAME⟧' });
    expect(checkInventedValue('⟦PROFILE.FULL_NAME⟧', filled).ok).toBe(true);
    expect(checkInventedValue('Suresh', el({ label: 'Nickname' })).ok).toBe(true);
  });
});

describe('typing over what this run already typed', () => {
  const search = el({ role: 'searchbox', label: 'Search' });

  it('is asked about — whatever it is replaced with', () => {
    // What a 3B model did on the injection page: a made-up number over the user's query.
    const verdict = checkRetype('12345678901234567890', search, 'scholarships for engineering students');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.question).toContain('already typed');
      expect(verdict.refused).not.toContain('12345678901234567890'); // the log line carries no value
    }
  });

  it('is fine when nothing was typed there yet, or the same text again', () => {
    expect(checkRetype('anything', search, undefined).ok).toBe(true);
    expect(checkRetype('⟦PROFILE.EMAIL⟧', search, '⟦PROFILE.EMAIL⟧').ok).toBe(true);
  });

  it('words each refusal for what it refused', () => {
    const invented = checkInventedValue('ananya.ier@example.com', el({ label: 'Email address', sensitive: 'EMAIL' }));
    expect(!invented.ok && invented.refused).toBe('An email address the planner made up was not typed.');
  });
});
