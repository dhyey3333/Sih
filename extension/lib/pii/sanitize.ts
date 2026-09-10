/**
 * The text sanitizer.
 *
 * Every string that goes on the wire passes through here: element labels, button
 * text, placeholders, field values, the page title. A screenshot with black boxes
 * on it is worthless if the element list beside it still says
 * `label: "Email (rahul@example.com)"`.
 *
 * Two sources feed it:
 *   1. the validators (§3.2 of docs/PLAN.md) — patterns plus checksums, and
 *   2. the vault's known values — the user's own profile, which catches names and
 *      addresses that no regex can recognise.
 */

import type { PiiType } from '../protocol';
import { scanText } from './validators';
import type { Vault } from './vault';

export interface SanitizeResult {
  text: string;
  /** What was replaced, for the detection list. Types and tokens only — never values. */
  replaced: Array<{ type: PiiType; token: string }>;
}

interface Range {
  start: number;
  end: number;
  token: string;
  type: PiiType;
}

/**
 * Replace every PII match in `text` with a stable token.
 *
 * `context` is extra text used only to satisfy context-dependent rules: a bare
 * "482913" is an OTP when the label beside it says "Enter OTP", and just a number
 * otherwise.
 */
export function sanitizeText(text: string, vault: Vault, context?: string): SanitizeResult {
  if (!text) return { text, replaced: [] };

  // Known values win over pattern matches: we are certain about them, and their
  // token is the more informative ⟦PROFILE.*⟧ form.
  const ranges: Range[] = vault.findKnownValues(text);

  for (const m of scanText(text, { context })) {
    if (ranges.some((r) => m.start < r.end && r.start < m.end)) continue;
    ranges.push({
      start: m.start,
      end: m.end,
      token: vault.tokenize(m.type, m.value),
      type: m.type,
    });
  }

  if (ranges.length === 0) return { text, replaced: [] };
  ranges.sort((a, b) => a.start - b.start);

  const replaced: Array<{ type: PiiType; token: string }> = [];
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    out += text.slice(cursor, r.start) + r.token;
    cursor = r.end;
    replaced.push({ type: r.type, token: r.token });
  }
  out += text.slice(cursor);

  return { text: out, replaced };
}

/**
 * Origin + path only (CLAUDE.md): query strings and fragments routinely carry
 * session tokens, email addresses and order ids, and the VLM never needs them.
 */
export function sanitizeUrl(rawUrl: string): { origin: string; path: string } {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: 'unknown', path: '/' };
  }
}

/**
 * Clamp a label to something a VLM can use without turning the payload into a
 * document. Long "labels" are usually a whole paragraph picked up by mistake, and
 * paragraphs are where free-text PII hides.
 */
export function clampLabel(text: string | undefined, maxLength = 120): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}
