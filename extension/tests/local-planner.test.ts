import { beforeEach, describe, expect, it } from 'vitest';
import { planLocally } from '../lib/local-planner';
import type { PageElement } from '../lib/protocol';
import { Vault } from '../lib/pii/vault';
import { DEMO_PROFILE } from '../lib/demo-profile';
import type { ProfileKey } from '../lib/pii/vault';

let vault: Vault;

beforeEach(() => {
  vault = new Vault();
  for (const [key, value] of Object.entries(DEMO_PROFILE)) {
    vault.setProfile(key as ProfileKey, value);
  }
});

const field = (partial: Partial<PageElement>): PageElement => ({
  id: 1,
  role: 'textbox',
  tag: 'input',
  bbox: { x: 0, y: 0, w: 200, h: 32 },
  ...partial,
});

const plan = (elements: PageElement[], task = 'Fill this form with my profile', attempted = new Set<number>()) =>
  planLocally({ task, elements, vault, attempted });

describe('scroll instructions', () => {
  it.each([
    ['scroll down', 'down'],
    ['please scroll down a bit', 'down'],
    ['go to the next page', 'down'],
    ['scroll up', 'up'],
    ['move back up', 'up'],
  ])('handles "%s" locally', (task, direction) => {
    const decision = plan([], task);
    expect(decision?.response.action).toBe('scroll');
    expect(decision?.response.direction).toBe(direction);
    expect(decision?.response.planner).toBe('local');
  });

  it('does not treat an ordinary task as a scroll', () => {
    expect(plan([], 'Fill this form with my profile')).toBeNull();
  });
});

describe('fields the page itself declared', () => {
  it('fills an empty autocomplete field from the vault, with no server', () => {
    const decision = plan([
      field({ id: 4, sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email' }),
    ]);
    expect(decision?.response).toMatchObject({
      action: 'type',
      element_id: 4,
      text: '⟦PROFILE.EMAIL⟧',
      planner: 'local',
    });
  });

  it('sends a token, never a value', () => {
    const decision = plan([field({ sensitive: 'PHONE', sensitiveReason: 'autocomplete=tel' })]);
    expect(decision!.response.text).toBe('⟦PROFILE.PHONE⟧');
    expect(decision!.response.text).not.toContain(DEMO_PROFILE.PHONE);
  });

  it('explains itself, for the activity log', () => {
    const decision = plan([field({ id: 9, sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email' })]);
    expect(decision?.because).toContain('field 9');
    expect(decision?.because).toContain('autocomplete=email');
  });

  it('has no autocomplete route to an Indian ID, so those escalate', () => {
    // HTML's autocomplete vocabulary has no token for Aadhaar, PAN or passport, so
    // those fields only ever carry a `kw:` reason — and are refused here by design.
    const decision = plan([field({ sensitive: 'AADHAAR', sensitiveReason: 'kw:aadhaar' })]);
    expect(decision).toBeNull();
  });

  it.each([
    ['EMAIL', 'autocomplete=email'],
    ['PHONE', 'autocomplete=tel'],
    ['NAME', 'autocomplete=name'],
    ['DOB', 'autocomplete=bday'],
    ['ADDRESS', 'autocomplete=street-address'],
    ['PINCODE', 'autocomplete=postal-code'],
  ])('handles a declared %s field', (sensitive, reason) => {
    const decision = plan([field({ sensitive: sensitive as PageElement['sensitive'], sensitiveReason: reason })]);
    expect(decision?.response.action).toBe('type');
  });
});

describe('what it refuses to do — the point of the layer', () => {
  it('never acts on our own keyword heuristics, only on the page’s declaration', () => {
    // `kw:` rules are good enough to redact on (over-redacting is safe) and not
    // good enough to type on (typing into the wrong box is not).
    expect(plan([field({ sensitive: 'EMAIL', sensitiveReason: 'kw:email' })])).toBeNull();
  });

  it('never types a password', () => {
    expect(
      plan([field({ sensitive: 'PASSWORD', sensitiveReason: 'autocomplete=current-password' })]),
    ).toBeNull();
  });

  it('never clicks anything', () => {
    const elements = [
      field({ id: 2, role: 'button', tag: 'button', text: 'Submit application' }),
      field({ id: 3, role: 'button', tag: 'button', text: 'Continue' }),
    ];
    expect(plan(elements)).toBeNull();
  });

  it('skips a field that already has a value', () => {
    expect(
      plan([field({ sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email', value: 'x@y.com' })]),
    ).toBeNull();
  });

  it('skips a disabled field', () => {
    expect(
      plan([field({ sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email', disabled: true })]),
    ).toBeNull();
  });

  it('skips a field it has already acted on, so it cannot loop', () => {
    const elements = [field({ id: 7, sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email' })];
    expect(plan(elements)).not.toBeNull();
    expect(plan(elements, 'Fill this form', new Set([7]))).toBeNull();
  });

  it('escalates when the vault has no matching value', () => {
    const empty = new Vault();
    expect(
      planLocally({
        task: 'Fill this form',
        elements: [field({ sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email' })],
        vault: empty,
        attempted: new Set(),
      }),
    ).toBeNull();
  });

  it('escalates on a page with nothing declared', () => {
    expect(plan([field({ role: 'textbox', label: 'Search' })])).toBeNull();
  });
});

describe('ordering', () => {
  it('takes the first declared, unfilled field in document order', () => {
    const decision = plan([
      field({ id: 1, sensitive: 'EMAIL', sensitiveReason: 'autocomplete=email', value: 'done@x.com' }),
      field({ id: 2, sensitive: 'PHONE', sensitiveReason: 'autocomplete=tel' }),
      field({ id: 3, sensitive: 'NAME', sensitiveReason: 'autocomplete=name' }),
    ]);
    expect(decision?.response.element_id).toBe(2);
  });
});
