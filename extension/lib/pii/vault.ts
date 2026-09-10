/**
 * The vault: the only place a real PII value is allowed to live.
 *
 * Everything the server sees is a token (`⟦EMAIL_1⟧`, `⟦PROFILE.PHONE⟧`). The
 * extension swaps a token back for its value locally, immediately before typing
 * it into the page. The server never learns anything but which *kinds* of values
 * exist and which ones repeat.
 *
 * In-memory only, and scoped to the side panel session (see docs/DECISIONS.md).
 * When the panel closes, the values are gone.
 */

import type { PiiType } from '../protocol';
import { normalizeForCompare } from './validators';

/** Keys the user can fill in on the side panel's profile form. */
export const PROFILE_KEYS = [
  'FULL_NAME',
  'EMAIL',
  'PHONE',
  'DOB',
  'ADDRESS',
  'PINCODE',
  'AADHAAR',
  'PAN',
  'PASSPORT',
  'UPI',
] as const;

export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Which PII type a profile key represents, so a scanned value can be linked to it. */
export const PROFILE_KEY_TYPE: Record<ProfileKey, PiiType> = {
  FULL_NAME: 'NAME',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  DOB: 'DOB',
  ADDRESS: 'ADDRESS',
  PINCODE: 'PINCODE',
  AADHAAR: 'AADHAAR',
  PAN: 'PAN',
  PASSPORT: 'PASSPORT',
  UPI: 'UPI',
};

export const TOKEN_PATTERN = /⟦[A-Z][A-Z0-9_.]*⟧/g;

export function isToken(value: string): boolean {
  return /^⟦[A-Z][A-Z0-9_.]*⟧$/.test(value.trim());
}

interface VaultEntry {
  value: string;
  type: PiiType;
}

export interface KnownValueRange {
  start: number;
  end: number;
  token: string;
  type: PiiType;
}

/**
 * Values shorter than this are never used for substring matching. A 3-character
 * name or a 3-digit CVV appears inside unrelated words and numbers constantly,
 * and would make the egress guard block every request.
 */
const MIN_MATCHABLE_LENGTH = 4;

export class Vault {
  /** token -> real value + type */
  private readonly entries = new Map<string, VaultEntry>();
  /** normalized value -> token, so the same value always gets the same token */
  private readonly normalizedToToken = new Map<string, string>();
  /** per-type counter for `⟦EMAIL_1⟧`, `⟦EMAIL_2⟧`, ... */
  private readonly counters = new Map<PiiType, number>();
  private readonly profile = new Map<ProfileKey, string>();

  /* ---------------- profile ---------------- */

  setProfile(key: ProfileKey, value: string): void {
    const trimmed = value.trim();
    const token = `⟦PROFILE.${key}⟧`;

    if (!trimmed) {
      const previous = this.profile.get(key);
      if (previous) this.normalizedToToken.delete(normalizeForCompare(previous));
      this.profile.delete(key);
      this.entries.delete(token);
      return;
    }

    this.profile.set(key, trimmed);
    // A profile value is addressable as ⟦PROFILE.KEY⟧ from the moment it's set,
    // so the server can ask us to type it without ever having seen it on screen.
    this.entries.set(token, { value: trimmed, type: PROFILE_KEY_TYPE[key] });
    this.normalizedToToken.set(normalizeForCompare(trimmed), token);
  }

  getProfile(key: ProfileKey): string | undefined {
    return this.profile.get(key);
  }

  /** The only profile information that ever goes on the wire. */
  profileKeys(): ProfileKey[] {
    return [...this.profile.keys()];
  }

  /** Present the profile to the UI. Never send this anywhere. */
  profileEntries(): Array<[ProfileKey, string]> {
    return [...this.profile.entries()];
  }

  /* ---------------- tokenization ---------------- */

  /**
   * Return a stable token for `value`. If the value is already known — including
   * as a profile entry — the existing token wins, so the server can tell that the
   * email in the header and the email in the form are the same person, and so a
   * profile value carries the more meaningful `⟦PROFILE.EMAIL⟧`.
   */
  tokenize(type: PiiType, value: string): string {
    const normalized = normalizeForCompare(value);
    const existing = this.normalizedToToken.get(normalized);
    if (existing) return existing;

    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    const token = `⟦${type}_${next}⟧`;

    this.entries.set(token, { value, type });
    this.normalizedToToken.set(normalized, token);
    return token;
  }

  /** Look up a single token. Returns undefined for an unknown token. */
  valueOf(token: string): string | undefined {
    return this.entries.get(token)?.value;
  }

  /**
   * Swap every known token in `text` for its real value. Called on the action the
   * server returned, in the extension, right before the content script types it.
   *
   * An unknown token is left as-is rather than silently dropped, so a hallucinated
   * `⟦AADHAAR_9⟧` shows up visibly in the field instead of typing something
   * arbitrary — and `hasUnresolvedTokens` lets the caller refuse the action.
   */
  resolve(text: string): string {
    return text.replace(TOKEN_PATTERN, (token) => this.entries.get(token)?.value ?? token);
  }

  /** True if the text still contains a token we could not resolve. */
  hasUnresolvedTokens(text: string): boolean {
    return [...text.matchAll(TOKEN_PATTERN)].some((m) => !this.entries.has(m[0]!));
  }

  /**
   * Find occurrences of values we already hold inside arbitrary text.
   *
   * This is how names and addresses get redacted without an NER model: the user's
   * own profile seeds the matcher, so "Welcome back, Rahul Sharma" is tokenized
   * even though no regex can tell a name from any other pair of capitalised words.
   * See docs/DECISIONS.md.
   *
   * Longest match wins, and ranges never overlap.
   */
  findKnownValues(text: string): KnownValueRange[] {
    if (!text) return [];
    const haystack = text.toLowerCase();

    const candidates: KnownValueRange[] = [];
    for (const [token, entry] of this.entries) {
      if (entry.value.length < MIN_MATCHABLE_LENGTH) continue;
      const needle = entry.value.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        candidates.push({ start: at, end: at + needle.length, token, type: entry.type });
        from = at + needle.length;
      }
    }

    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const kept: KnownValueRange[] = [];
    for (const c of candidates) {
      if (!kept.some((k) => c.start < k.end && k.start < c.end)) kept.push(c);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  /**
   * Values to search the page for, with their types.
   *
   * Handed to the content script so a profile name or address can be located and
   * *redacted in the screenshot*, not merely tokenized in the JSON. See
   * docs/DECISIONS.md on why sending these into the isolated content-script world
   * is safe: if the value is on screen the page already has it, and if it isn't,
   * page JavaScript cannot read the content script's world anyway.
   */
  needles(): Array<{ value: string; type: PiiType }> {
    return [...this.entries.values()]
      .filter((e) => e.value.length >= MIN_MATCHABLE_LENGTH)
      .map((e) => ({ value: e.value, type: e.type }));
  }

  /* ---------------- egress support ---------------- */

  /**
   * Every real value we know about, for the egress guard to search for.
   * Short values are excluded for the reason in MIN_MATCHABLE_LENGTH.
   */
  secrets(): string[] {
    return [...this.entries.values()]
      .map((e) => e.value)
      .filter((v) => v.length >= MIN_MATCHABLE_LENGTH);
  }

  /** Which profile key a value corresponds to, if any. */
  profileKeyFor(value: string): ProfileKey | null {
    const normalized = normalizeForCompare(value);
    for (const [key, stored] of this.profile) {
      if (normalizeForCompare(stored) === normalized) return key;
    }
    return null;
  }

  /** Number of distinct values held. Safe to display. */
  get size(): number {
    return this.entries.size;
  }

  /** Drop everything except the profile, which the user typed deliberately. */
  clearSession(): void {
    const profile = [...this.profile.entries()];
    this.clearAll();
    for (const [key, value] of profile) this.setProfile(key, value);
  }

  clearAll(): void {
    this.entries.clear();
    this.normalizedToToken.clear();
    this.counters.clear();
    this.profile.clear();
  }
}
