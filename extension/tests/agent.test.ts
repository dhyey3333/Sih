import { describe, expect, it } from 'vitest';
import { describeAction, isIrreversible } from '../lib/agent';
import type { StepResponse, WireElement } from '../lib/protocol';
import { Vault } from '../lib/pii/vault';
import { FAKE } from './fixtures';

const button = (partial: Partial<WireElement>): WireElement => ({
  id: 1,
  role: 'button',
  bbox: [0, 0, 100, 40],
  ...partial,
});

describe('isIrreversible — the gate that stops the agent pressing Submit', () => {
  it.each([
    'Submit application',
    'Pay now',
    'Send message',
    'Delete account',
    'Confirm booking',
    'Place order',
    'Transfer ₹25,000',
    'Withdraw application',
    'Checkout',
  ])('flags "%s"', (text) => {
    expect(isIrreversible(button({ text }))).toBe(true);
  });

  it('flags any input[type=submit], whatever its label says', () => {
    expect(isIrreversible(button({ type: 'submit', text: 'Continue' }))).toBe(true);
  });

  it.each(['Save draft', 'Cancel', 'Back', 'Next', 'Show more', 'Add another'])(
    'leaves "%s" alone',
    (text) => {
      expect(isIrreversible(button({ text }))).toBe(false);
    },
  );

  it('reads the accessible label when there is no text', () => {
    expect(isIrreversible(button({ label: 'Submit the form' }))).toBe(true);
  });

  it('is false for an element the server named but we cannot find', () => {
    expect(isIrreversible(undefined)).toBe(false);
  });
});

describe('describeAction — what goes in the activity log', () => {
  it('shows the token, which is safe, and never a resolved value', () => {
    const response: StepResponse = { action: 'type', element_id: 5, text: '⟦PROFILE.EMAIL⟧' };
    const described = describeAction(response);
    expect(described).toContain('⟦PROFILE.EMAIL⟧');
    expect(described).not.toContain(FAKE.email);
  });

  it.each([
    [{ action: 'click', element_id: 3 }, 'click element 3'],
    [{ action: 'scroll', direction: 'down' }, 'scroll down'],
    [{ action: 'key', key: 'Enter' }, 'press Enter'],
    [{ action: 'click_xy', x: 10, y: 20 }, 'click at (10, 20)'],
    [{ action: 'done' }, 'done'],
  ] as Array<[StepResponse, string]>)('describes %o', (response, expected) => {
    expect(describeAction(response)).toBe(expected);
  });
});

/**
 * The token-resolution gate lives inside Agent, which needs the extension APIs.
 * These cover the vault behaviour it depends on — the part that decides whether an
 * action is safe to execute.
 */
describe('token resolution before typing', () => {
  it('resolves a profile token to the real value, locally', () => {
    const vault = new Vault();
    vault.setProfile('EMAIL', FAKE.email);
    expect(vault.hasUnresolvedTokens('⟦PROFILE.EMAIL⟧')).toBe(false);
    expect(vault.resolve('⟦PROFILE.EMAIL⟧')).toBe(FAKE.email);
  });

  it('flags a token we never issued, so the agent refuses instead of typing junk', () => {
    const vault = new Vault();
    expect(vault.hasUnresolvedTokens('⟦AADHAAR_9⟧')).toBe(true);
  });

  it('flags a hallucinated token mixed into otherwise valid text', () => {
    const vault = new Vault();
    vault.setProfile('FULL_NAME', FAKE.fullName);
    expect(vault.hasUnresolvedTokens('⟦PROFILE.FULL_NAME⟧ ⟦PROFILE.SALARY⟧')).toBe(true);
  });

  it('leaves plain text alone', () => {
    expect(new Vault().hasUnresolvedTokens('Mumbai')).toBe(false);
  });
});
