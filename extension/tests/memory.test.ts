/**
 * The vault fills itself (D35): an answer is learned the first time it is given,
 * filed under the right profile key or remembered by its label, and never asked
 * for again. FAKE DATA ONLY (CLAUDE.md).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { planLocally } from '../lib/local-planner';
import {
  documentSuggestions,
  maskValue,
  memoSlug,
  normalizeLabel,
  profileKeyForField,
  questionLabel,
} from '../lib/pii/memory';
import { checkValueTarget } from '../lib/type-gate';
import type { PageElement, WireElement } from '../lib/protocol';
import { Vault } from '../lib/pii/vault';

describe('normalizeLabel', () => {
  it.each([
    ['State of domicile *', 'Domicile state'],
    ["Father's name", 'Father name'],
    ['Please enter your mobile number (10 digits)', 'Mobile number'],
    ['Category (as per certificate)', 'category'],
  ])('treats “%s” and “%s” as the same question', (a, b) => {
    expect(normalizeLabel(a)).toBe(normalizeLabel(b));
  });

  it('keeps different questions apart', () => {
    expect(normalizeLabel("Father's name")).not.toBe(normalizeLabel("Mother's name"));
    expect(normalizeLabel('Mobile number')).not.toBe(normalizeLabel('Alternate mobile number'));
  });

  it('reads Devanagari labels', () => {
    expect(normalizeLabel('पिता का नाम')).toBe(normalizeLabel('पिता नाम'));
    expect(normalizeLabel('पिता का नाम')).not.toBe('');
  });

  it('gives nothing for a label with no words left', () => {
    expect(normalizeLabel('*')).toBe('');
    expect(normalizeLabel(undefined)).toBe('');
  });
});

describe('profileKeyForField', () => {
  it.each([
    ['NAME', 'Full name', 'FULL_NAME'],
    ['NAME', 'Name of the applicant', 'FULL_NAME'],
    ['PHONE', 'Mobile number', 'PHONE'],
    ['EMAIL', 'Email ID', 'EMAIL'],
    ['DOB', 'Date of birth', 'DOB'],
    ['ADDRESS', 'Permanent address', 'ADDRESS'],
    ['AADHAAR', 'Aadhaar number', 'AADHAAR'],
  ] as const)('%s field “%s” fills %s', (type, label, key) => {
    expect(profileKeyForField(type, label)).toBe(key);
  });

  it.each([
    ['NAME', "Father's name"],
    ['NAME', 'पिता का नाम'],
    ['NAME', 'First name'],
    ['NAME', 'Surname'],
    ['PHONE', "Father's mobile number"],
    ['PHONE', 'Alternate mobile'],
    ['PHONE', 'Emergency contact number'],
    ['ADDRESS', 'City'],
    ['ADDRESS', 'Office address'],
    ['AADHAAR', "Mother's Aadhaar number"],
  ] as const)('%s field “%s” is not the user’s own profile key', (type, label) => {
    expect(profileKeyForField(type, label)).toBeNull();
  });

  it('never maps a field with no sensitive type', () => {
    expect(profileKeyForField(undefined, 'Full name')).toBeNull();
  });
});

describe('memoSlug and maskValue', () => {
  it('builds an ASCII key from the label', () => {
    expect(memoSlug("Father's name", 1, new Set())).toBe('FATHER_NAME');
    expect(memoSlug('State of domicile *', 1, new Set())).toBe('STATE_DOMICILE');
  });

  it('numbers a label with no ASCII letters, and never collides', () => {
    expect(memoSlug('पिता का नाम', 3, new Set())).toBe('ANSWER_3');
    expect(memoSlug('Phone', 1, new Set(['PHONE']))).toBe('PHONE_2');
  });

  it('masks a value enough for a projector', () => {
    expect(maskValue('ananya.iyer@example.com')).toBe('a••••••@example.com');
    expect(maskValue('9812345678')).toBe('9•••••••78');
    expect(maskValue('abc')).toBe('•••');
  });
});

describe('Vault.learn', () => {
  let vault: Vault;
  beforeEach(() => {
    vault = new Vault();
    vault.setPage('https://portal.example.gov.in');
  });

  it('files an answer for one of the profile keys into the profile', () => {
    const learned = vault.learn('Full name *', 'Ananya Iyer', 'NAME');
    expect(learned).toEqual({ text: '⟦PROFILE.FULL_NAME⟧', profileKey: 'FULL_NAME', remembered: true });
    expect(vault.getProfile('FULL_NAME')).toBe('Ananya Iyer');
    expect(vault.profileKeys()).toContain('FULL_NAME');
  });

  it("remembers someone else's name by its label, with a token of its own", () => {
    const learned = vault.learn("Father's name *", 'Suresh Iyer', 'NAME');
    expect(learned.text).toBe('⟦PROFILE.FATHER_NAME⟧');
    expect(vault.getProfile('FULL_NAME')).toBeUndefined();
    expect(vault.valueOf('⟦PROFILE.FATHER_NAME⟧')).toBe('Suresh Iyer');
    expect(vault.memoKeys()).toEqual(['FATHER_NAME']);
    // A sensitive answer is a secret: the egress guard and the tokenizer know it.
    expect(vault.secrets()).toContain('Suresh Iyer');
    expect(vault.tokenize('NAME', 'Suresh Iyer')).toBe('⟦PROFILE.FATHER_NAME⟧');
  });

  it('remembers a plain answer as it is, and keeps it out of the secrets', () => {
    const learned = vault.learn('State of domicile *', 'Maharashtra');
    expect(learned).toEqual({ text: 'Maharashtra', remembered: true });
    expect(vault.secrets()).not.toContain('Maharashtra');
    expect(vault.memoKeys()).toEqual([]);
  });

  it('recalls an answer when the same question is asked another way', () => {
    vault.learn('State of domicile *', 'Maharashtra');
    vault.learn("Father's name", 'Suresh Iyer', 'NAME');
    vault.learn('Mobile number', '9812345678', 'PHONE');
    expect(vault.recall('Domicile state')?.text).toBe('Maharashtra');
    expect(vault.recall('Father Name')?.text).toBe('⟦PROFILE.FATHER_NAME⟧');
    expect(vault.recall('Please enter your mobile number')?.text).toBe('⟦PROFILE.PHONE⟧');
    expect(vault.recall('Occupation')).toBeUndefined();
  });

  it('never keeps a password, an OTP or a card', () => {
    for (const [label, type] of [['OTP', 'OTP'], ['Card number', 'CARD'], ['CVV', 'CVV']] as const) {
      const learned = vault.learn(label, '4111111111111111', type);
      expect(learned.remembered).toBe(false);
      expect(vault.recall(label)).toBeUndefined();
    }
    expect(vault.backup().memos).toEqual([]);
  });

  it('does not overwrite a profile key with a second, different value', () => {
    vault.setProfile('PHONE', '9812345678');
    const learned = vault.learn('Mobile', '9876500000', 'PHONE');
    expect(vault.getProfile('PHONE')).toBe('9812345678');
    expect(learned.profileKey).toBeUndefined();
    expect(vault.valueOf(learned.text)).toBe('9876500000');
  });

  it('makes a learned value the user’s own, so the cross-site gate lets it travel', () => {
    const learned = vault.learn("Father's name", 'Suresh Iyer', 'NAME');
    expect(vault.originOf(learned.text)).toBeUndefined();
    const field: WireElement = { id: 3, role: 'textbox', label: "Father's name", sensitive: 'NAME', bbox: [0, 0, 1, 1] };
    expect(checkValueTarget(learned.text, field, vault, 'https://another.example.gov.in').ok).toBe(true);
  });

  it('forgets an answer, token and all', () => {
    const learned = vault.learn("Father's name", 'Suresh Iyer', 'NAME');
    vault.forgetMemo("Father's name");
    expect(vault.recall("Father's name")).toBeUndefined();
    expect(vault.valueOf(learned.text)).toBeUndefined();
    expect(vault.secrets()).not.toContain('Suresh Iyer');
  });
});

describe('backup and restore', () => {
  it('round-trips the profile and learned answers, and nothing seen on a page', () => {
    const vault = new Vault();
    vault.setProfile('EMAIL', 'ananya.iyer@example.com');
    vault.learn("Father's name", 'Suresh Iyer', 'NAME');
    vault.learn('State of domicile', 'Maharashtra');
    vault.setPage('https://portal.example.gov.in');
    vault.tokenize('EMAIL', 'someone.else@example.com'); // seen on a page: never saved

    const backup = JSON.parse(JSON.stringify(vault.backup()));
    expect(JSON.stringify(backup)).not.toContain('someone.else');

    const restored = new Vault();
    restored.restore(backup);
    expect(restored.getProfile('EMAIL')).toBe('ananya.iyer@example.com');
    expect(restored.recall('Father name')?.text).toBe('⟦PROFILE.FATHER_NAME⟧');
    expect(restored.valueOf('⟦PROFILE.FATHER_NAME⟧')).toBe('Suresh Iyer');
    expect(restored.recall('Domicile state')?.text).toBe('Maharashtra');
  });

  it('keeps learned answers when the session is cleared', () => {
    const vault = new Vault();
    vault.learn('State of domicile', 'Maharashtra');
    vault.clearSession();
    expect(vault.recall('State of domicile')?.text).toBe('Maharashtra');
    vault.clearAll();
    expect(vault.recall('State of domicile')).toBeUndefined();
  });

  it('skips a malformed backup rather than trusting it', () => {
    const vault = new Vault();
    vault.restore({ v: 1, profile: { EMAIL: 42 as unknown as string }, memos: [{ label: '', value: 'x' }] });
    vault.restore({ v: 2 } as never);
    expect(vault.profileKeys()).toEqual([]);
    expect(vault.memoEntries()).toEqual([]);
  });
});

describe('documentSuggestions — what a scanned ID card can put in the vault', () => {
  const card = [
    { type: 'AADHAAR' as const, value: '2234 5678 9018' },
    { type: 'DOB' as const, value: '14/03/2001' },
    { type: 'DOB' as const, value: '01/01/2030' }, // a second date: only the first is taken
    { type: 'CARD' as const, value: '4111 1111 1111 1111' }, // never kept
    { type: 'NAME' as const, value: 'Ananya Iyer' }, // no profile key without a label to judge by
  ];

  it('offers one value per profile key, and nothing it must not keep', () => {
    const offer = documentSuggestions(card, () => false);
    expect(offer.map((s) => [s.key, s.value])).toEqual([
      ['AADHAAR', '2234 5678 9018'],
      ['DOB', '14/03/2001'],
    ]);
  });

  it('skips what the vault already holds', () => {
    expect(documentSuggestions(card, (key) => key === 'AADHAAR').map((s) => s.key)).toEqual(['DOB']);
  });

  it('files a saved value under its profile key', () => {
    const vault = new Vault();
    for (const s of documentSuggestions(card, () => false)) vault.learn(s.label, s.value, s.type);
    expect(vault.getProfile('AADHAAR')).toBe('2234 5678 9018');
    expect(vault.getProfile('DOB')).toBe('14/03/2001');
  });
});

describe('questionLabel', () => {
  it('asks about a radio group by its name', () => {
    expect(questionLabel({ role: 'radio', label: 'Female', group: 'marital_status' })).toBe('marital status');
    expect(questionLabel({ role: 'textbox', placeholder: 'Occupation' })).toBe('Occupation');
  });
});

describe('the local planner fills what it has learned', () => {
  let vault: Vault;
  beforeEach(() => {
    vault = new Vault();
  });

  const el = (partial: Partial<PageElement>): PageElement => ({
    id: 1,
    role: 'textbox',
    tag: 'input',
    bbox: { x: 0, y: 0, w: 200, h: 32 },
    ...partial,
  });
  const plan = (elements: PageElement[], attempted = new Set<number>()) =>
    planLocally({ task: 'Fill this form', elements, vault, attempted });

  it('types a remembered answer into an empty field that asks the same question', () => {
    vault.learn('State of domicile *', 'Maharashtra');
    const decision = plan([el({ id: 4, label: 'Domicile state' })]);
    expect(decision?.response).toMatchObject({ action: 'type', element_id: 4, text: 'Maharashtra', planner: 'local' });
    // The user's own words stay off the wire, as they do from the question sheet.
    expect(decision?.historyText).toBe('(remembered answer)');
  });

  it('types a sensitive answer as its token', () => {
    vault.learn("Father's name", 'Suresh Iyer', 'NAME');
    const decision = plan([el({ id: 2, label: "Father's Name *", sensitive: 'NAME' })]);
    expect(decision?.response).toMatchObject({ action: 'type', text: '⟦PROFILE.FATHER_NAME⟧' });
    expect(decision?.historyText).toBeUndefined();
  });

  it('picks a remembered choice, but only one that is on offer', () => {
    vault.learn('Category', 'OBC');
    const offered = el({ id: 5, role: 'combobox', tag: 'select', label: 'Category', options: ['Select', 'General', 'OBC'], value: '' });
    expect(plan([offered])?.response).toMatchObject({ action: 'select', option: 'OBC' });
    const notOffered = { ...offered, options: ['Select', 'General', 'SC'] };
    expect(plan([notOffered])).toBeNull();
  });

  it('answers a radio group once, and not when it is already answered', () => {
    vault.learn('gender', 'Female');
    const radios = [
      el({ id: 7, role: 'radio', type: 'radio', label: 'Male', group: 'gender', checked: false }),
      el({ id: 8, role: 'radio', type: 'radio', label: 'Female', group: 'gender', checked: false }),
    ];
    expect(plan(radios)?.response).toMatchObject({ action: 'select', element_id: 7, option: 'Female' });
    radios[1]!.checked = true;
    expect(plan(radios)).toBeNull();
  });

  it('leaves a filled field, an attempted field and a password alone', () => {
    vault.learn('State of domicile', 'Maharashtra');
    vault.learn('Secret word', 'hunter22');
    expect(plan([el({ label: 'State of domicile', value: 'Goa' })])).toBeNull();
    expect(plan([el({ id: 9, label: 'State of domicile' })], new Set([9]))).toBeNull();
    expect(plan([el({ label: 'Secret word', type: 'password', sensitive: 'PASSWORD' })])).toBeNull();
  });

  it('does nothing for a question, even on a form it could fill', () => {
    vault.learn('State of domicile', 'Maharashtra');
    expect(planLocally({ task: 'What is my state?', elements: [el({ label: 'State of domicile' })], vault, attempted: new Set() })).toBeNull();
  });
});
