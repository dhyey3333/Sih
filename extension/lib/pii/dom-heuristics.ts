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

/**
 * A whole Devanagari word or phrase. `\b` is useless here: JS regex word
 * characters are ASCII, so `\b` sees a boundary between every Hindi letter and its
 * vowel sign. Lookarounds on the Devanagari block do what `\b` does for English.
 */
const hi = (alternatives: string): RegExp =>
  new RegExp(`(?<![\\u0900-\\u097F])(?:${alternatives})(?![\\u0900-\\u097F])`);

/**
 * Hindi labels, for the forms of a country whose government portals are bilingual
 * and whose state portals are often Hindi only. Checked after the English rules, so
 * "Email / ईमेल" resolves the same way either half would.
 *
 * Order matters as it does above: OTP before password ("एक बार का पासवर्ड" is an
 * OTP), email before address ("ईमेल पता" is an email address, not a postal one).
 */
const HINDI_RULES: readonly KeywordRule[] = [
  { type: 'OTP', name: 'kw:otp-hi', pattern: hi('ओटीपी|एक बार का पासवर्ड|सत्यापन कोड'), confidence: 0.94 },
  { type: 'PASSWORD', name: 'kw:password-hi', pattern: hi('पासवर्ड|कूटशब्द'), confidence: 0.97 },
  { type: 'AADHAAR', name: 'kw:aadhaar-hi', pattern: hi('आधार'), confidence: 0.95 },
  { type: 'PAN', name: 'kw:pan-hi', pattern: hi('पैन|स्थायी खाता संख्या'), confidence: 0.94 },
  { type: 'PASSPORT', name: 'kw:passport-hi', pattern: hi('पासपोर्ट'), confidence: 0.95 },
  { type: 'CVV', name: 'kw:cvv-hi', pattern: hi('सीवीवी'), confidence: 0.96 },
  { type: 'CARD', name: 'kw:card-hi', pattern: hi('(?:क्रेडिट|डेबिट|एटीएम)\\s*कार्ड|कार्ड\\s*(?:संख्या|नंबर|नम्बर)'), confidence: 0.94 },
  { type: 'IFSC', name: 'kw:ifsc-hi', pattern: hi('आईएफएससी'), confidence: 0.95 },
  { type: 'UPI', name: 'kw:upi-hi', pattern: hi('यूपीआई'), confidence: 0.94 },
  { type: 'ACCOUNT', name: 'kw:account-hi', pattern: hi('(?:बैंक\\s*)?खाता\\s*(?:संख्या|नंबर|नम्बर|क्रमांक)|बैंक खाता'), confidence: 0.94 },
  { type: 'EMAIL', name: 'kw:email-hi', pattern: hi('ई\\s*मेल'), confidence: 0.95 },
  { type: 'PHONE', name: 'kw:phone-hi', pattern: hi('मोबाइल|मोबाईल|फ़ोन|फोन|दूरभाष|संपर्क\\s*(?:नंबर|संख्या|सूत्र)'), confidence: 0.94 },
  { type: 'DOB', name: 'kw:dob-hi', pattern: hi('जन्म\\s*(?:तिथि|तारीख|दिनांक)|जन्मतिथि|जन्म की तारीख'), confidence: 0.94 },
  { type: 'PINCODE', name: 'kw:pincode-hi', pattern: hi('पिन\\s*कोड|पिनकोड|डाक\\s*सूचकांक'), confidence: 0.92 },
  { type: 'ADDRESS', name: 'kw:address-hi', pattern: hi('पता|गली|मोहल्ला|शहर|जिला|ज़िला|गाँव|गांव|निवास'), confidence: 0.88 },
  {
    type: 'NAME',
    name: 'kw:name-hi',
    // A person's name, however the form phrases it. "कंपनी का नाम" (company name)
    // and "विद्यालय का नाम" (school name) are not, which is why a bare "X का नाम"
    // only counts when X is a person — see `isPersonName`.
    pattern: hi('नाम|उपनाम'),
    confidence: 0.88,
  },
  { type: 'GENERIC', name: 'kw:sensitive-hi', pattern: hi('वेतन|आय|मतदाता पहचान पत्र|ड्राइविंग लाइसेंस|रक्त समूह|नामांकित'), confidence: 0.8 },
];

/** Who "X का नाम" can be about and still be a person's name. */
const HINDI_PERSON = hi(
  '(?:आवेदक|उम्मीदवार|अभ्यर्थी|छात्र|छात्रा|विद्यार्थी|पिता|माता|पति|पत्नी|अभिभावक|नामांकित व्यक्ति|लाभार्थी|कर्मचारी|यात्री|सदस्य|धारक)\\s*(?:का|की|के)\\s*नाम',
);

function isPersonName(context: string): boolean {
  if (HINDI_PERSON.test(context)) return true;
  // Bare "नाम", "पूरा नाम", "प्रथम नाम" — anything but "<thing> का नाम".
  const at = context.search(hi('नाम'));
  return at >= 0 && !/(?:का|की|के)\s*$/.test(context.slice(0, at));
}

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

  for (const rule of HINDI_RULES) {
    if (!rule.pattern.test(context)) continue;
    if (rule.type === 'NAME' && !isPersonName(context)) continue;
    return { type: rule.type, reason: rule.name, confidence: rule.confidence };
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
