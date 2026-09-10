/**
 * Text-level PII validators. India-aware, plus the global types.
 *
 * Design rule: a pattern that would fire on ordinary page text (6 digits, 4 digits,
 * a capital letter followed by 7 digits) is only allowed to produce a detection when
 * a context word sits next to it. Everything else is either checksum-verified or
 * structurally unambiguous. That is what keeps precision high on real pages, where
 * most of the screen is prices, dates, counts and IDs that are not PII.
 *
 * Nothing here logs or throws with a value in it — see CLAUDE.md, "never log raw PII".
 */

import type { PiiType } from '../protocol';
import { PII_PRIORITY } from '../protocol';
import { isLuhnValid, isPanStructureValid, isVerhoeffValid } from './checksums';

export interface Match {
  type: PiiType;
  value: string;
  /** Index into the scanned string. */
  start: number;
  end: number;
  confidence: number;
  /** Rule name, for the UI and for debugging. Safe to log. */
  rule: string;
}

interface Rule {
  type: PiiType;
  name: string;
  pattern: RegExp;
  /** Extra check on the raw match; the deciding factor for precision. */
  validate?: (value: string) => boolean;
  /** When set, the match only counts if one of these words is nearby. */
  context?: readonly string[];
  confidence: number;
}

/** How far around a match we look for a context word, in characters. */
const CONTEXT_RADIUS = 48;

/**
 * Known UPI handles. An unknown handle still matches, but only with a nearby
 * context word, because `something@word` is also how people write social handles.
 */
const UPI_HANDLES = new Set([
  'okhdfcbank', 'okicici', 'oksbi', 'okaxis', 'ybl', 'ibl', 'axl', 'apl',
  'paytm', 'upi', 'sbi', 'hdfcbank', 'icici', 'axisbank', 'kotak', 'pnb',
  'barodampay', 'fbl', 'idfcbank', 'yesg', 'abfspay', 'airtel', 'freecharge',
  'jio', 'jupiteraxis', 'naviaxis', 'superyes', 'timecosmos', 'waaxis',
  'wasbi', 'waicici', 'rmhdfc', 'indus', 'cnrb', 'uco', 'unionbank',
]);

const UPI_CONTEXT = ['upi', 'vpa', 'virtual payment', 'pay to', 'payment address'] as const;

const RULES: readonly Rule[] = [
  {
    type: 'EMAIL',
    name: 'email',
    // Unambiguous: a dot-bearing domain after @ is not a UPI handle.
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    confidence: 0.97,
  },
  {
    type: 'AADHAAR',
    name: 'aadhaar-verhoeff',
    // Aadhaar never starts with 0 or 1.
    pattern: /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
    validate: (v) => isVerhoeffValid(v),
    confidence: 0.99,
  },
  {
    type: 'CARD',
    name: 'card-luhn',
    pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    validate: (v) => {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits);
    },
    confidence: 0.98,
  },
  {
    type: 'PAN',
    name: 'pan-structure',
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    validate: (v) => isPanStructureValid(v),
    confidence: 0.98,
  },
  {
    type: 'IFSC',
    name: 'ifsc',
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    confidence: 0.95,
  },
  {
    type: 'UPI',
    name: 'upi-vpa',
    // No dot after @, so this can never collide with the email rule.
    pattern: /\b[A-Za-z0-9._-]{2,60}@[A-Za-z]{2,20}\b/g,
    confidence: 0.92,
  },
  {
    type: 'PHONE',
    name: 'phone-in',
    pattern: /(?<![\d-])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\d-])/g,
    confidence: 0.94,
  },
  {
    type: 'ACCOUNT',
    name: 'account-context',
    // Bank account numbers have no checksum and no fixed length, so context is the
    // only thing separating them from order ids and reference numbers.
    pattern: /(?<![\d-])\d{9,18}(?![\d-])/g,
    context: ['account number', 'account no', 'a/c', 'bank account', 'acct'],
    confidence: 0.9,
  },
  {
    type: 'PASSPORT',
    name: 'passport-in',
    // Q, X and Z are not issued as the first letter of an Indian passport number.
    pattern: /\b[A-PR-WY][0-9]{7}\b/g,
    context: ['passport'],
    confidence: 0.9,
  },
  {
    type: 'DOB',
    name: 'dob-dmy',
    pattern: /(?<!\d)(?:0?[1-9]|[12]\d|3[01])[/\-.](?:0?[1-9]|1[0-2])[/\-.](?:19|20)\d{2}(?!\d)/g,
    context: ['dob', 'date of birth', 'birth', 'born', 'birthday'],
    confidence: 0.9,
  },
  {
    type: 'DOB',
    name: 'dob-iso',
    pattern: /(?<!\d)(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/g,
    context: ['dob', 'date of birth', 'birth', 'born', 'birthday'],
    confidence: 0.9,
  },
  {
    type: 'CVV',
    name: 'cvv-context',
    pattern: /(?<!\d)\d{3,4}(?!\d)/g,
    context: ['cvv', 'cvc', 'csc', 'security code', 'card code'],
    confidence: 0.88,
  },
  {
    type: 'OTP',
    name: 'otp-context',
    pattern: /(?<!\d)\d{4,8}(?!\d)/g,
    context: ['otp', 'one-time', 'one time', 'verification code', 'auth code', 'passcode'],
    confidence: 0.85,
  },
  {
    type: 'PINCODE',
    name: 'pincode-context',
    pattern: /(?<!\d)[1-9]\d{5}(?!\d)/g,
    context: ['pin code', 'pincode', 'pin', 'postal', 'zip'],
    confidence: 0.85,
  },
];

function hasContextWord(haystack: string, words: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return words.some((w) => lower.includes(w));
}

/** Text immediately around a match, used for the context check. */
function contextWindow(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - CONTEXT_RADIUS), Math.min(text.length, end + CONTEXT_RADIUS));
}

/**
 * A UPI handle needs either a known provider or a nearby context word, otherwise
 * every `@mention` on a social page would be redacted.
 */
function upiAccepted(value: string, context: string): boolean {
  const provider = value.slice(value.indexOf('@') + 1).toLowerCase();
  if (UPI_HANDLES.has(provider)) return true;
  return hasContextWord(context, UPI_CONTEXT);
}

export interface ScanOptions {
  /**
   * Extra context that isn't part of `text` — typically the field's label,
   * placeholder or aria-label. Lets a bare "123456" in an input be recognised
   * as an OTP because the label next to it says "Enter OTP".
   */
  context?: string;
  /** Restrict the scan to these types. Used by the egress guard's fast path. */
  only?: readonly PiiType[];
}

/**
 * Find every PII match in `text`.
 *
 * Overlaps are resolved by priority first, then by length: a Luhn-valid card
 * number wins over the phone-shaped run of digits inside it, and `⟦PASSWORD⟧`
 * always wins over anything that happens to look like an email inside it.
 */
export function scanText(text: string, options: ScanOptions = {}): Match[] {
  if (!text) return [];

  const extraContext = options.context ?? '';
  const allowed = options.only ? new Set(options.only) : null;
  const candidates: Match[] = [];

  for (const rule of RULES) {
    if (allowed && !allowed.has(rule.type)) continue;

    // Rules are module-level and `g`-flagged, so reset before each use.
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const value = m[0];
      // Zero-length matches would spin forever; no rule can produce one, but be safe.
      if (value.length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }

      const start = m.index;
      const end = start + value.length;

      if (rule.validate && !rule.validate(value)) continue;

      const context = `${contextWindow(text, start, end)} ${extraContext}`;
      if (rule.context && !hasContextWord(context, rule.context)) continue;
      if (rule.type === 'UPI' && !upiAccepted(value, context)) continue;

      candidates.push({
        type: rule.type,
        value,
        start,
        end,
        confidence: rule.confidence,
        rule: rule.name,
      });
    }
  }

  return resolveOverlaps(candidates);
}

/** Greedy: highest priority wins, then longest, then leftmost. */
function resolveOverlaps(matches: Match[]): Match[] {
  matches.sort((a, b) => {
    const p = PII_PRIORITY[b.type] - PII_PRIORITY[a.type];
    if (p !== 0) return p;
    const len = b.end - b.start - (a.end - a.start);
    if (len !== 0) return len;
    return a.start - b.start;
  });

  const kept: Match[] = [];
  for (const m of matches) {
    const overlaps = kept.some((k) => m.start < k.end && k.start < m.end);
    if (!overlaps) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** True if the whole string is a single PII value (used for input values). */
export function classifyValue(value: string, context?: string): Match | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const matches = scanText(trimmed, { context });
  const whole = matches.find((m) => m.start === 0 && m.end === trimmed.length);
  return whole ?? matches[0] ?? null;
}

/**
 * Canonical form for comparing a candidate string against a known vault value.
 * Strips the separators humans sprinkle into numbers so that "4111 1111 1111 1111"
 * and "4111-1111-1111-1111" both match the stored "4111111111111111".
 */
export function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[\s\-().]/g, '');
}
