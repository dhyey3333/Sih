/**
 * Learning on submit: what the user typed into a form, offered for the vault (D40).
 *
 * The vault used to be filled by hand. Now, when the user — not the agent, not a
 * script — submits a form they typed into, the page shows one prompt: "Remember what
 * you typed?" A yes files each value the way an answer to the agent is filed
 * (lib/pii/memory.ts): under a profile key when the field plainly asks for one, by
 * its label otherwise. Chrome's own "Save address?" is the model, and the reason it
 * is a prompt and not silent: it is the user's data, and they say yes to keeping it.
 *
 * Pure: the content script reads the DOM, this decides what is worth offering.
 */

import type { PiiType } from '../protocol';
import { NEVER_REMEMBERED, normalizeLabel, profileKeyForField, questionLabel } from './memory';
import type { Vault } from './vault';

/** One field as the content script read it, after a trusted keystroke touched it. */
export interface FieldReading {
  role: string;
  label?: string;
  placeholder?: string;
  /** A radio group's name; a radio is offered as its group's answer. */
  group?: string;
  /** The `type` attribute, for inputs. */
  inputType?: string;
  /** What the DOM layer classified the field as, if anything. */
  sensitive?: PiiType;
  value: string;
}

export interface LearnItem {
  label: string;
  value: string;
  type?: PiiType;
}

/**
 * Longer than this is prose — a statement of purpose, a message — and not something
 * a later form will ask for again word for word.
 */
const MAX_VALUE = 120;

/** Inputs that never hold something worth filling again. */
const SKIPPED_TYPES = new Set(['password', 'search', 'hidden', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);

export function offerFromFields(readings: ReadonlyArray<FieldReading>): LearnItem[] {
  const byLabel = new Map<string, LearnItem>();
  for (const r of readings) {
    const value = r.value.trim();
    if (!value || value.length > MAX_VALUE) continue;
    if (r.role === 'searchbox' || SKIPPED_TYPES.has((r.inputType ?? '').toLowerCase())) continue;
    // Never a password, an OTP, a card or its CVV — however the field is labelled.
    if (r.sensitive && NEVER_REMEMBERED.has(r.sensitive)) continue;
    const label = questionLabel(r)?.trim();
    const key = normalizeLabel(label);
    if (!label || !key) continue; // a field with no name cannot be recognised again
    byLabel.set(key, { label, value, ...(r.sensitive ? { type: r.sensitive } : {}) });
  }
  return [...byLabel.values()];
}

/** The items the vault would learn something from: new, or different from what it holds. */
export function newToVault(items: ReadonlyArray<LearnItem>, vault: Vault): LearnItem[] {
  return items.filter((item) => {
    const key = profileKeyForField(item.type, item.label);
    if (key && vault.getProfile(key) === item.value) return false;
    const recalled = vault.recall(item.label);
    return !recalled || vault.resolve(recalled.text) !== item.value;
  });
}

const FRIENDLY: Partial<Record<PiiType, string>> = {
  NAME: 'name',
  EMAIL: 'email',
  PHONE: 'mobile number',
  DOB: 'date of birth',
  ADDRESS: 'address',
  PINCODE: 'PIN code',
  AADHAAR: 'Aadhaar number',
  PAN: 'PAN',
  PASSPORT: 'passport number',
  UPI: 'UPI ID',
  IFSC: 'IFSC',
  ACCOUNT: 'account number',
};

/**
 * What the prompt says it will remember: the fields' names, never their values — the
 * prompt is drawn inside someone else's page. "name, email, Aadhaar number and 3 more".
 */
export function describeOffer(items: ReadonlyArray<LearnItem>, shown = 3): string {
  const names = items.map((item) => {
    const key = profileKeyForField(item.type, item.label);
    return key && item.type ? FRIENDLY[item.type] ?? item.label : item.label.replace(/[*:]+\s*$/, '').trim();
  });
  const unique = [...new Set(names)];
  if (unique.length <= shown) return joinWords(unique);
  return `${unique.slice(0, shown).join(', ')} and ${unique.length - shown} more`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
