/**
 * D40: what a submitted form offers for the vault, and how the prompt names it.
 * FAKE DATA ONLY (CLAUDE.md).
 */

import { describe, expect, it } from 'vitest';
import { describeOffer, newToVault, offerFromFields, type FieldReading } from '../lib/pii/offer';
import { Vault } from '../lib/pii/vault';

const field = (partial: Partial<FieldReading> & { value: string }): FieldReading => ({ role: 'textbox', ...partial });

const submitted: FieldReading[] = [
  field({ label: 'Full name *', sensitive: 'NAME', value: 'Ananya Iyer' }),
  field({ label: 'Email address', sensitive: 'EMAIL', value: 'ananya.iyer@example.com' }),
  field({ label: "Father's name", sensitive: 'NAME', value: 'Suresh Iyer' }),
  field({ label: 'State', role: 'combobox', value: 'Maharashtra' }),
  field({ role: 'radio', group: 'gender', inputType: 'radio', value: 'Female' }),
  field({ label: 'Portal password', inputType: 'password', sensitive: 'PASSWORD', value: 'hunter22' }),
  field({ label: 'One-time code', sensitive: 'OTP', value: '482913' }),
  field({ label: 'Card number', sensitive: 'CARD', value: '4111 1111 1111 1111' }),
  field({ label: 'Search', role: 'searchbox', value: 'scholarships' }),
  field({ label: 'Statement of purpose', value: 'x'.repeat(200) }),
  field({ label: 'Remarks', value: '   ' }),
  field({ value: 'unlabelled' }),
];

describe('offerFromFields', () => {
  it('offers what a later form will ask for, and nothing it must not keep', () => {
    const offered = offerFromFields(submitted).map((i) => i.label);
    expect(offered).toEqual(['Full name *', 'Email address', "Father's name", 'State', 'gender']);
  });

  it('keeps the type the DOM layer read, so a sensitive value becomes a token', () => {
    const [name, , , state] = offerFromFields(submitted);
    expect(name).toMatchObject({ type: 'NAME', value: 'Ananya Iyer' });
    expect(state!.type).toBeUndefined();
  });

  it('asks about the same question once, with the last answer', () => {
    const twice = [field({ label: 'State', value: 'Goa' }), field({ label: 'State *', value: 'Kerala' })];
    expect(offerFromFields(twice)).toEqual([{ label: 'State *', value: 'Kerala' }]);
  });
});

describe('newToVault', () => {
  it('offers only what the vault does not already hold', () => {
    const vault = new Vault();
    vault.setProfile('EMAIL', 'ananya.iyer@example.com');
    vault.learn('State', 'Maharashtra');
    const fresh = newToVault(offerFromFields(submitted), vault).map((i) => i.label);
    expect(fresh).toEqual(['Full name *', "Father's name", 'gender']);
  });

  it('offers a changed value again', () => {
    const vault = new Vault();
    vault.learn('State', 'Goa');
    expect(newToVault([{ label: 'State', value: 'Maharashtra' }], vault)).toHaveLength(1);
  });

  it('a yes files each item the way an answer to the agent is filed', () => {
    const vault = new Vault();
    for (const item of offerFromFields(submitted)) vault.learn(item.label, item.value, item.type);
    expect(vault.getProfile('FULL_NAME')).toBe('Ananya Iyer');
    expect(vault.recall("Father's name")?.text).toBe('⟦PROFILE.FATHER_NAME⟧');
    expect(vault.recall('gender')?.text).toBe('Female');
    expect(vault.secrets()).not.toContain('hunter22');
  });
});

describe('describeOffer', () => {
  it('names fields, never values', () => {
    const text = describeOffer(offerFromFields(submitted));
    expect(text).toBe("name, email, Father's name and 2 more");
    for (const value of ['Ananya', 'example.com', 'Suresh', 'Maharashtra']) expect(text).not.toContain(value);
  });

  it('reads naturally for one, two and three', () => {
    expect(describeOffer([{ label: 'State', value: 'Goa' }])).toBe('State');
    expect(describeOffer([{ label: 'State', value: 'Goa' }, { label: 'Category', value: 'OBC' }])).toBe('State and Category');
  });
});
