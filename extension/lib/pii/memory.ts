/**
 * Learning the user's details, so the agent never asks for the same thing twice.
 *
 * The vault used to be a form the user filled in by hand, and every other value
 * a form wanted — a father's name, a state, a category — was asked for on every
 * page, every time. Now an answer is learned the first time it is given:
 *
 *   - An answer that *is* one of the profile's own keys ("Full name *", "Mobile
 *     number") goes into the profile, so every planner can use it as
 *     ⟦PROFILE.FULL_NAME⟧ from then on.
 *   - Anything else is remembered against the field's label ("Father's name",
 *     "State of domicile") and filled again wherever a field says the same thing.
 *
 * Both stay on the device. What the server learns is the same as for the profile:
 * which keys exist, never their values (docs/DECISIONS.md D35).
 *
 * Pure: no DOM, no storage. Unit-tested in tests/memory.test.ts.
 */

import type { PiiType } from '../protocol';
import type { ProfileKey } from './vault';

/**
 * Words that dress a label up without saying what it asks for. Filtered as whole
 * tokens rather than with `\b`, which does not see a Devanagari word's edge.
 */
const NOISE = new Set([
  'please', 'kindly', 'enter', 'type', 'select', 'choose', 'provide', 'your', 'the', 'a', 'an',
  'of', 'here', 'below', 'optional', 'required', 'mandatory',
  'कृपया', 'अपना', 'अपनी', 'अपने', 'का', 'की', 'के', 'दर्ज', 'करें',
]);

/**
 * A label reduced to the words that identify it, in a fixed order.
 *
 * "State of domicile *", "Domicile state" and "Please enter your state of
 * domicile (as per certificate)" all become "domicile state": the same question
 * asked three ways is still one question. Returns "" for a label with nothing
 * left, which is never remembered — a field with no name cannot be recognised
 * again.
 */
export function normalizeLabel(label: string | undefined): string {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(optional)", "(as per Aadhaar)", "(dd/mm/yyyy)"
    .replace(/['’]s\b/g, '') // father's → father
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w && !NOISE.has(w))
    .sort()
    .join(' ');
}

/**
 * The words a field is asked about by. A radio group is asked about as one
 * question, by its group name ("marital_status" → "marital status"); anything else
 * by its label, or its placeholder when it has none. The agent's question sheet and
 * the local planner both use this, so an answer given to one is found by the other.
 */
export function questionLabel(el: { role: string; label?: string; placeholder?: string; group?: string }): string | undefined {
  if (el.role === 'radio') return el.group?.replace(/_/g, ' ');
  return el.label || el.placeholder;
}

/**
 * A field about someone other than the user. Mirrors `_SOMEONE_ELSE` in
 * server/app/planner.py, widened to the other fields a form asks about a second
 * person or an institution for: an alternate mobile, an office address.
 */
const SOMEONE_ELSE =
  /\b(father|mother|guardian|spouse|husband|wife|nominee|parent|son|daughter|brother|sister|relative|emergency|referee|reference|witness|co-?applicant|alternate|alternative|secondary|office|employer|company|institute|institution|college|school|university)\b|पिता|माता|पति|पत्नी|अभिभावक|नामांकित/i;

/** Part of a name, or not a person's name at all: never the whole of FULL_NAME. */
const NOT_FULL_NAME = /\b(first|last|middle|given|family|sur|nick|user|display|login|account|pet)\s*name\b|\bsurname\b|\busername\b/i;

/** Types the profile holds under a key of the same meaning, whatever the label says. */
const DIRECT: Partial<Record<PiiType, ProfileKey>> = {
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  DOB: 'DOB',
  PINCODE: 'PINCODE',
  AADHAAR: 'AADHAAR',
  PAN: 'PAN',
  PASSPORT: 'PASSPORT',
  UPI: 'UPI',
};

/**
 * Which profile key an answer to this field belongs in, or null.
 *
 * Conservative on purpose. A wrong key is worse than no key: the user's own mobile
 * number filed as their father's would be typed into every "Mobile" field after it.
 * When in doubt the answer is remembered against its label instead, which can only
 * ever be reused for a field asking the same question.
 */
export function profileKeyForField(type: PiiType | undefined, label: string | undefined): ProfileKey | null {
  if (!type) return null;
  const text = (label ?? '').toLowerCase();
  if (SOMEONE_ELSE.test(text)) return null;
  if (type === 'NAME') return NOT_FULL_NAME.test(text) ? null : 'FULL_NAME';
  // "City", "District" and "Landmark" are classified ADDRESS too, and are parts of
  // one. Only a field that asks for the address itself gets the whole of it.
  if (type === 'ADDRESS') return /address|पता/.test(text) ? 'ADDRESS' : null;
  return DIRECT[type] ?? null;
}

/**
 * Secrets that are never remembered. A password is never read or typed by the agent
 * at all; an OTP is single-use; a card number and its CVV are the one thing a
 * leaked vault would be worth stealing for. Each is used for the session it was
 * given in, and gone when the panel closes.
 */
export const NEVER_REMEMBERED: ReadonlySet<PiiType> = new Set(['PASSWORD', 'OTP', 'CVV', 'CARD']);

/**
 * The key a remembered sensitive answer is addressed by: ⟦PROFILE.FATHER_NAME⟧.
 * ASCII letters, digits and underscores only, as TOKEN_PATTERN requires. A label
 * with none of those (a Hindi-only label) gets a numbered key instead.
 */
export function memoSlug(label: string, fallbackIndex: number, taken: ReadonlySet<string>): string {
  const words = label
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));
  let slug = words.join('_').toUpperCase().slice(0, 40).replace(/_+$/, '');
  if (!/^[A-Z]/.test(slug)) slug = `ANSWER_${fallbackIndex}`;
  // Never shadow a real profile key, and never collide with another answer.
  let unique = slug;
  for (let n = 2; taken.has(unique); n++) unique = `${slug}_${n}`;
  return unique;
}

/** What a value read off an ID card is called in the save card. */
const DOCUMENT_LABEL: Partial<Record<PiiType, string>> = {
  AADHAAR: 'Aadhaar number',
  PAN: 'PAN',
  DOB: 'Date of birth',
  PASSPORT: 'Passport number',
  PHONE: 'Mobile number',
  EMAIL: 'Email',
  PINCODE: 'PIN code',
  UPI: 'UPI ID',
};

export interface DocumentSuggestion {
  label: string;
  value: string;
  type: PiiType;
  key: ProfileKey;
}

/**
 * What an ID card the user scanned can put in the profile: one value per key, only
 * keys the profile does not hold yet, never a secret it must not keep. A card is the
 * user's own, so its Aadhaar number is theirs — but a card can carry a second date
 * (issue, expiry) that the validators take for a birth date only beside a DOB label,
 * which is why DOB is taken from the first match and no other.
 */
export function documentSuggestions(
  findings: ReadonlyArray<{ type: PiiType; value: string }>,
  held: (key: ProfileKey) => boolean,
): DocumentSuggestion[] {
  const out: DocumentSuggestion[] = [];
  for (const f of findings) {
    const key = DIRECT[f.type];
    const label = DOCUMENT_LABEL[f.type];
    if (!key || !label || NEVER_REMEMBERED.has(f.type) || held(key)) continue;
    if (out.some((s) => s.key === key)) continue;
    out.push({ label, value: f.value.trim(), type: f.type, key });
  }
  return out;
}

/**
 * How a value is shown in the panel: enough to recognise, not enough to read off a
 * screen share. The vault is on the device, but a demo is on a projector.
 */
export function maskValue(value: string): string {
  const v = value.trim();
  const at = v.indexOf('@');
  if (at > 0) return `${v[0]}${'•'.repeat(Math.min(at - 1, 6))}${v.slice(at)}`;
  if (v.length <= 4) return '•'.repeat(v.length);
  return `${v.slice(0, 1)}${'•'.repeat(Math.min(v.length - 3, 8))}${v.slice(-2)}`;
}
