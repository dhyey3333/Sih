/**
 * DOM-layer sensitivity detection (§3.1 of docs/PLAN.md).
 *
 * This is the cheapest and most reliable layer in the whole system: the page has
 * already told us what each field holds, through `type`, `autocomplete`, the
 * `<label>`, the placeholder and the `name`/`id`. Reading that costs microseconds
 * and gives pixel-exact boxes, where the vision layer costs tens of milliseconds
 * and gives approximate ones. The vision layer exists for what the DOM *can't*
 * say — images, canvas, video, PDFs — not as a replacement for this.
 *
 * `classifyField` deliberately takes a plain descriptor rather than an Element, so
 * it is unit-testable without a DOM and reusable from the offline data generator.
 */

import type { PiiType } from '../protocol';

export interface FieldDescriptor {
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  autocomplete?: string;
  title?: string;
  inputMode?: string;
  /**
   * True for a `contenteditable` or `role="textbox"` element. Rich-text editors and
   * most design-system "inputs" are `<div>`s, and treating them as decoration means
   * the address someone typed into one is never classified as an address.
   */
  editable?: boolean;
}

export interface FieldClassification {
  type: PiiType;
  /** Rule name for the UI and logs. Never contains a value. */
  reason: string;
  confidence: number;
}

/**
 * `autocomplete` is a declaration by the page author about what the field holds.
 * It is the strongest signal available and needs no guessing.
 */
const AUTOCOMPLETE_TYPES: Record<string, PiiType> = {
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  'one-time-code': 'OTP',
  'cc-number': 'CARD',
  'cc-csc': 'CVV',
  'cc-exp': 'CARD',
  'cc-exp-month': 'CARD',
  'cc-exp-year': 'CARD',
  'cc-name': 'NAME',
  'cc-given-name': 'NAME',
  'cc-family-name': 'NAME',
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'tel-local': 'PHONE',
  'tel-country-code': 'PHONE',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'address-line3': 'ADDRESS',
  'address-level1': 'ADDRESS',
  'address-level2': 'ADDRESS',
  'postal-code': 'PINCODE',
  name: 'NAME',
  'given-name': 'NAME',
  'family-name': 'NAME',
  'additional-name': 'NAME',
  'honorific-prefix': 'NAME',
  'honorific-suffix': 'NAME',
};

interface KeywordRule {
  type: PiiType;
  name: string;
  /** Matched against the field's combined label text. */
  pattern: RegExp;
  confidence: number;
}

/**
 * Ordered most-specific first; the first rule that matches wins. Short words
 * ("pan", "pin") are anchored with \b so they don't fire on "panel" or "shipping".
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
  { type: 'PASSWORD', name: 'kw:password', pattern: /\b(password|passwd|pwd|passphrase)\b/, confidence: 0.97 },
  { type: 'AADHAAR', name: 'kw:aadhaar', pattern: /\b(aadhaar|aadhar|adhaar|uidai|uid\s*number)\b/, confidence: 0.97 },
  { type: 'PAN', name: 'kw:pan', pattern: /\b(pan)\b(?!\s*(card\s*)?(image|photo|upload))|\bpermanent\s+account\s+number\b/, confidence: 0.95 },
  { type: 'PASSPORT', name: 'kw:passport', pattern: /\bpassport\b/, confidence: 0.95 },
  { type: 'CVV', name: 'kw:cvv', pattern: /\b(cvv|cvc|csc|card\s*(security|verification)\s*(code|value))\b/, confidence: 0.96 },
  { type: 'CARD', name: 'kw:card', pattern: /\b((credit|debit|atm)\s*card|card\s*(number|no\.?)|cardnumber)\b/, confidence: 0.95 },
  { type: 'IFSC', name: 'kw:ifsc', pattern: /\b(ifsc|swift\s*code|micr)\b/, confidence: 0.95 },
  { type: 'UPI', name: 'kw:upi', pattern: /\b(upi|vpa|virtual\s+payment\s+address)\b/, confidence: 0.94 },
  // `acc`/`acct`/`a/c` are how real portals abbreviate this — `BANK_ACC_NO` is a
  // verbatim field name from a live government form. A suffix is still required, so
  // "Account name" (a username) does not match.
  { type: 'ACCOUNT', name: 'kw:account', pattern: /\b(?:a\/c|acct?|account)\s*(?:number|no\.?|#)\b|\bbank\s*acc(?:oun)?t?\b/, confidence: 0.94 },
  { type: 'OTP', name: 'kw:otp', pattern: /\b(otp|one[\s-]?time\s*(code|password|pin)|verification\s*code|auth\s*code)\b/, confidence: 0.94 },
  { type: 'EMAIL', name: 'kw:email', pattern: /\b(e[\s-]?mail|email\s*(id|address)?)\b/, confidence: 0.95 },
  { type: 'PHONE', name: 'kw:phone', pattern: /\b(mob(?:ile)?|phone|contact\s*(number|no\.?)|whatsapp|telephone|msisdn)\b/, confidence: 0.94 },
  { type: 'DOB', name: 'kw:dob', pattern: /\b(dob|date\s*of\s*birth|birth\s*date|birthday)\b/, confidence: 0.94 },
  { type: 'PINCODE', name: 'kw:pincode', pattern: /\b(pin\s*code|pincode|postal\s*code|post\s*code|zip\s*code|\bzip\b)\b/, confidence: 0.92 },
  { type: 'ADDRESS', name: 'kw:address', pattern: /\b(address|street|locality|landmark|house\s*no|flat\s*no|city|district|residence)\b/, confidence: 0.88 },
  {
    type: 'NAME',
    name: 'kw:name',
    // Only person-name phrasings. A bare "name" is left alone because it is far
    // more often "Company name", "Product name" or "File name" than a person.
    //
    // Both word orders: Indian forms write "Name of the candidate" and "Candidate
    // name" about equally often, and the holdout caught us accepting only the first.
    pattern: /\b((full|first|last|middle|given|legal|holder'?s?|applicant'?s?|candidate'?s?|student'?s?|member'?s?|beneficiary'?s?|employee'?s?|passenger'?s?|father'?s?|mother'?s?|spouse'?s?|guardian'?s?|nominee'?s?|your)\s*name|surname|name\s*of\s*(the\s*)?(applicant|candidate|student|holder|nominee))\b/,
    confidence: 0.9,
  },
  { type: 'GENERIC', name: 'kw:sensitive', pattern: /\b(salary|income|ssn|social\s*security|tax\s*id|gstin|voter\s*id|driving\s*licen[sc]e|licence\s*number|nominee|blood\s*group|pin\b)\b/, confidence: 0.8 },
];

/** Field types that never hold PII, whatever the label says. */
const INERT_INPUT_TYPES = new Set([
  'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'checkbox', 'radio',
]);

/**
 * Everything the page told us about the field, normalised into words.
 *
 * `name` and `id` attributes are `snake_case`, `kebab-case` or `camelCase` far more
 * often than they are prose — `aadhaar_no`, `panNumber`, `date-of-birth`. `_` is a
 * word character in JS regex, so `\baadhaar\b` would never match `aadhaar_no`;
 * splitting on separators and case transitions first is what makes the \b-anchored
 * rules work on real markup instead of only on labels.
 */
export function fieldContext(f: FieldDescriptor): string {
  return [f.label, f.ariaLabel, f.placeholder, f.name, f.id, f.title]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase();
}

/**
 * Decide whether a form field holds sensitive data.
 * Returns null when the field looks safe to send in the clear.
 */
export function classifyField(f: FieldDescriptor): FieldClassification | null {
  const tag = f.tag.toLowerCase();
  const type = (f.type ?? '').toLowerCase();

  // A password input is sensitive by definition — no label needed, no exceptions.
  if (tag === 'input' && type === 'password') {
    return { type: 'PASSWORD', reason: 'input[type=password]', confidence: 1 };
  }

  if (tag === 'input' && INERT_INPUT_TYPES.has(type)) return null;
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !f.editable) return null;

  // The page author's own declaration beats any heuristic of ours.
  const autocomplete = (f.autocomplete ?? '').toLowerCase().trim();
  for (const part of autocomplete.split(/\s+/)) {
    const declared = AUTOCOMPLETE_TYPES[part];
    if (declared) {
      return { type: declared, reason: `autocomplete=${part}`, confidence: 0.98 };
    }
  }

  const context = fieldContext(f);
  if (!context) return null;

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(context)) {
      return { type: rule.type, reason: rule.name, confidence: rule.confidence };
    }
  }

  return null;
}

/**
 * Images worth sending to the face / document detector.
 * We look at alt text, class names and the filename part of the src — never the
 * query string, which can itself carry PII.
 */
const IMAGE_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(avatar|profile|headshot|selfie|portrait|user[-_]?pic|photo|dp)\b/, 'avatar-like'],
  [/\b(aadhaar|aadhar|pan|passport|licen[sc]e|id[-_]?card|kyc|document|scan)\b/, 'document-like'],
  [/\b(signature|sign)\b/, 'signature-like'],
  [/\b(qr|barcode)\b/, 'code-like'],
];

export function imageHint(alt: string, className: string, src: string): string | null {
  // Strip the query string before matching: it may contain a token or an email.
  const path = src.split('?')[0] ?? '';
  const haystack = `${alt} ${className} ${path}`.toLowerCase();
  for (const [pattern, hint] of IMAGE_HINTS) {
    if (pattern.test(haystack)) return hint;
  }
  return null;
}
