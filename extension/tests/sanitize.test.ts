import { beforeEach, describe, expect, it } from 'vitest';
import { clampLabel, sanitizeText, sanitizeUrl } from '../lib/pii/sanitize';
import { Vault } from '../lib/pii/vault';
import { FAKE } from './fixtures';

let vault: Vault;

beforeEach(() => {
  vault = new Vault();
});

describe('sanitizeText', () => {
  it('replaces PII with tokens and keeps the rest of the sentence', () => {
    const { text } = sanitizeText(`Email us at ${FAKE.email} today`, vault);
    expect(text).toBe('Email us at ⟦EMAIL_1⟧ today');
    expect(text).not.toContain(FAKE.email);
  });

  it('handles several values in one string', () => {
    const { text, replaced } = sanitizeText(
      `${FAKE.email} / ${FAKE.phone} / ${FAKE.pan}`,
      vault,
    );
    expect(replaced.map((r) => r.type)).toEqual(['EMAIL', 'PHONE', 'PAN']);
    expect(text).toBe('⟦EMAIL_1⟧ / ⟦PHONE_1⟧ / ⟦PAN_1⟧');
  });

  it('reuses one token for a value that appears twice', () => {
    const { text } = sanitizeText(`${FAKE.email} and again ${FAKE.email}`, vault);
    expect(text).toBe('⟦EMAIL_1⟧ and again ⟦EMAIL_1⟧');
  });

  it('leaves clean text untouched', () => {
    const input = 'Continue to the next step';
    expect(sanitizeText(input, vault).text).toBe(input);
  });

  it('uses the vault to catch a name no pattern could find', () => {
    vault.setProfile('FULL_NAME', FAKE.fullName);
    const { text } = sanitizeText(`Signed in as ${FAKE.fullName}`, vault);
    expect(text).toBe('Signed in as ⟦PROFILE.FULL_NAME⟧');
  });

  it('prefers the known profile value over a pattern match on the same span', () => {
    vault.setProfile('EMAIL', FAKE.email);
    const { text } = sanitizeText(`Account: ${FAKE.email}`, vault);
    expect(text).toBe('Account: ⟦PROFILE.EMAIL⟧');
  });

  it('applies label context to a context-dependent rule', () => {
    const { text } = sanitizeText(FAKE.otp, vault, 'Enter OTP');
    expect(text).toBe('⟦OTP_1⟧');
  });

  it('is idempotent: sanitizing twice does not double-tokenize', () => {
    const once = sanitizeText(`Email ${FAKE.email}`, vault).text;
    expect(sanitizeText(once, vault).text).toBe(once);
  });
});

describe('sanitizeUrl', () => {
  it('keeps origin and path, drops query and fragment', () => {
    expect(sanitizeUrl('https://bank.example/apply/kyc?email=a@b.com&sid=xyz#step2')).toEqual({
      origin: 'https://bank.example',
      path: '/apply/kyc',
    });
  });

  it('survives a malformed URL', () => {
    expect(sanitizeUrl('not a url')).toEqual({ origin: 'unknown', path: '/' });
  });
});

describe('clampLabel', () => {
  it('collapses whitespace', () => {
    expect(clampLabel('  Aadhaar \n number ')).toBe('Aadhaar number');
  });

  it('truncates a paragraph masquerading as a label', () => {
    const long = 'x'.repeat(400);
    expect(clampLabel(long)!.length).toBe(120);
  });

  it('returns undefined for nothing useful', () => {
    expect(clampLabel('   ')).toBeUndefined();
    expect(clampLabel(undefined)).toBeUndefined();
  });
});
