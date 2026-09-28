/**
 * The vault: the only place a real PII value is allowed to live.
 *
 * Everything the server sees is a token (`⟦EMAIL_1⟧`, `⟦PROFILE.PHONE⟧`). The
 * extension swaps a token back for its value locally, immediately before typing
 * it into the page. The server never learns anything but which *kinds* of values
 * exist and which ones repeat.
 *
 * In memory, scoped to the side panel session (see docs/DECISIONS.md). The user's
 * own data — the profile and the answers it has learned — can be saved to the
 * device encrypted when the user turns that on (lib/pii/vault-store.ts); values
 * merely seen on a page never are.
 */

import type { PiiType } from '../protocol';
import { memoSlug, NEVER_REMEMBERED, normalizeLabel, profileKeyForField } from './memory';
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
  /** The site a page value was first seen on. Absent for the user's own profile. */
  origin?: string;
}

export interface KnownValueRange {
  start: number;
  end: number;
  token: string;
  type: PiiType;
}

/**
 * An answer the user gave once, remembered against the field that asked for it.
 * Exactly one of `profileKey` (the answer went into the profile; this label is an
 * alias for it) and `value` is set.
 */
export interface Memo {
  /** The field's label as the page wrote it, for the panel. */
  label: string;
  value?: string;
  /** Set for a sensitive answer: its value is then a vault secret with a token. */
  type?: PiiType;
  /** ⟦PROFILE.<slug>⟧ for a sensitive answer. */
  slug?: string;
  profileKey?: ProfileKey;
}

/** The user's own data, and nothing else: what may be saved to the device. */
export interface VaultBackup {
  v: 1;
  profile: Partial<Record<ProfileKey, string>>;
  memos: Memo[];
}

/** What learning an answer did, so the caller can say so. */
export interface Learned {
  /** What to type: a token for anything sensitive, the value itself otherwise. */
  text: string;
  /** Set when the answer filled a profile key. */
  profileKey?: ProfileKey;
  /** False for a secret that is never kept (a password, an OTP, a card). */
  remembered: boolean;
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
  /** normalized label -> an answer the user gave for a field with that label */
  private readonly memos = new Map<string, Memo>();
  /** The site being read now; new page values are recorded as seen there. */
  private page = '';

  /** Set by the pipeline before it tokenizes a page (origin only, never a path). */
  setPage(origin: string): void {
    this.page = origin;
  }

  /**
   * Where a value was first seen, for a value that came from a page. Undefined for a
   * profile token — the user's own data, theirs to use on any site.
   */
  originOf(token: string): string | undefined {
    return this.entries.get(token)?.origin;
  }

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

  /* ---------------- learned answers ---------------- */

  /**
   * Learn the user's answer for a field, and return what to type into it.
   *
   * The answer goes into the profile when the field plainly asks for one of its
   * keys, and is remembered against the field's label otherwise (lib/pii/memory.ts).
   * Either way it is the user's own data from here on: no site of origin, so the
   * cross-site gate (D32) lets it be used anywhere, like the rest of the profile.
   */
  learn(label: string | undefined, answer: string, type?: PiiType): Learned {
    const value = answer.trim();
    if (!value) return { text: '', remembered: false };

    // Never kept. Tokenized for this session, exactly as before.
    if (type && NEVER_REMEMBERED.has(type)) {
      return { text: this.tokenize(type, value), remembered: false };
    }

    const normalized = normalizeLabel(label);
    const key = profileKeyForField(type, label);
    if (key) {
      const held = this.profile.get(key);
      if (held === undefined || normalizeForCompare(held) === normalizeForCompare(value)) {
        if (held === undefined) this.setProfile(key, value);
        if (normalized) this.memos.set(normalized, { label: label!.trim(), profileKey: key });
        return { text: `⟦PROFILE.${key}⟧`, profileKey: key, remembered: true };
      }
      // A different value for a key the profile already holds ("Mobile" answered with
      // a second number): keep the profile as it is, and remember this one by label.
    }

    if (!normalized) {
      return { text: type ? this.tokenize(type, value) : value, remembered: false };
    }

    if (!type) {
      this.memos.set(normalized, { label: label!.trim(), value });
      return { text: value, remembered: true };
    }

    const existing = this.memos.get(normalized);
    const slug = existing?.slug ?? memoSlug(label!, this.memos.size + 1, this.takenSlugs());
    const token = `⟦PROFILE.${slug}⟧`;
    if (existing?.value) this.normalizedToToken.delete(normalizeForCompare(existing.value));
    this.entries.set(token, { value, type });
    this.normalizedToToken.set(normalizeForCompare(value), token);
    this.memos.set(normalized, { label: label!.trim(), value, type, slug });
    return { text: token, remembered: true };
  }

  /**
   * What the user said last time a field asked this question: a token for a
   * sensitive answer or a profile alias, the value itself for a plain one.
   * Undefined when nothing is remembered, or the profile key it pointed at is gone.
   */
  recall(label: string | undefined): { text: string; memo: Memo } | undefined {
    const memo = this.memos.get(normalizeLabel(label));
    if (!memo) return undefined;
    if (memo.profileKey) {
      return this.profile.has(memo.profileKey) ? { text: `⟦PROFILE.${memo.profileKey}⟧`, memo } : undefined;
    }
    if (memo.slug) return { text: `⟦PROFILE.${memo.slug}⟧`, memo };
    return memo.value !== undefined ? { text: memo.value, memo } : undefined;
  }

  /** Remembered answers for the panel — everything except the profile aliases. */
  memoEntries(): Memo[] {
    return [...this.memos.values()].filter((m) => !m.profileKey);
  }

  forgetMemo(label: string): void {
    const normalized = normalizeLabel(label);
    const memo = this.memos.get(normalized);
    if (!memo) return;
    this.memos.delete(normalized);
    if (memo.slug) {
      this.entries.delete(`⟦PROFILE.${memo.slug}⟧`);
      if (memo.value) this.normalizedToToken.delete(normalizeForCompare(memo.value));
    }
  }

  /** Keys of remembered sensitive answers: sent like profile keys, never with values. */
  memoKeys(): string[] {
    return [...this.memos.values()].flatMap((m) => (m.slug ? [m.slug] : []));
  }

  private takenSlugs(): Set<string> {
    return new Set<string>([...PROFILE_KEYS, ...this.memoKeys()]);
  }

  /* ---------------- saving and restoring ---------------- */

  /**
   * The user's own data: the profile and the answers it has learned. Never a value
   * that was only seen on a page — those belong to the session they were seen in.
   */
  backup(): VaultBackup {
    return {
      v: 1,
      profile: Object.fromEntries(this.profile) as Partial<Record<ProfileKey, string>>,
      memos: [...this.memos.values()].map((m) => ({ ...m })),
    };
  }

  /** Load a backup over what is held. Anything malformed is skipped, not trusted. */
  restore(backup: VaultBackup | undefined): void {
    if (!backup || backup.v !== 1) return;
    for (const key of PROFILE_KEYS) {
      const value = backup.profile?.[key];
      if (typeof value === 'string' && value.trim()) this.setProfile(key, value);
    }
    for (const memo of backup.memos ?? []) {
      const normalized = normalizeLabel(memo?.label);
      if (!normalized) continue;
      if (memo.profileKey && (PROFILE_KEYS as readonly string[]).includes(memo.profileKey)) {
        this.memos.set(normalized, { label: memo.label, profileKey: memo.profileKey });
      } else if (typeof memo.value === 'string' && memo.value.trim()) {
        if (memo.type && memo.slug && /^[A-Z][A-Z0-9_]*$/.test(memo.slug)) {
          const token = `⟦PROFILE.${memo.slug}⟧`;
          this.entries.set(token, { value: memo.value, type: memo.type });
          this.normalizedToToken.set(normalizeForCompare(memo.value), token);
          this.memos.set(normalized, { label: memo.label, value: memo.value, type: memo.type, slug: memo.slug });
        } else {
          this.memos.set(normalized, { label: memo.label, value: memo.value });
        }
      }
    }
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

    this.entries.set(token, { value, type, ...(this.page ? { origin: this.page } : {}) });
    this.normalizedToToken.set(normalized, token);
    return token;
  }

  /**
   * A token for something with no text value behind it — a detected face, an ID
   * card scan. Numbered from the same counters as `tokenize`, so the redaction
   * legend reads consistently, but nothing is stored: there is nothing to
   * rehydrate, and `resolve` will correctly refuse to substitute it.
   */
  mintToken(type: PiiType): string {
    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    return `⟦${type}_${next}⟧`;
  }

  /** Look up a single token. Returns undefined for an unknown token. */
  valueOf(token: string): string | undefined {
    return this.entries.get(token)?.value;
  }

  /**
   * The kind of value a token stands for. Known only here, on the device — the
   * server chooses tokens but cannot lie about what they are, which is what lets
   * lib/type-gate.ts refuse to put an Aadhaar number into a search box.
   */
  typeOf(token: string): PiiType | undefined {
    return this.entries.get(token)?.type;
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

  /** Drop everything except the user's own data: the profile and learned answers. */
  clearSession(): void {
    const own = this.backup();
    this.clearAll();
    this.restore(own);
  }

  clearAll(): void {
    this.entries.clear();
    this.normalizedToToken.clear();
    this.counters.clear();
    this.profile.clear();
    this.memos.clear();
  }
}
