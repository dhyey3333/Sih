/**
 * The egress guard: the last thing that runs before `fetch`.
 *
 * Every other layer can have a bug. The DOM heuristics can miss a field, the
 * vision model can miss a face, a new page structure can defeat the label
 * matcher. This function is the backstop that makes "no PII left the device" a
 * property of the *architecture* rather than a property of a model's accuracy —
 * it re-scans the fully serialized payload and blocks the request on any hit.
 *
 * The server runs the same scan on arrival and rejects the request if anything
 * slipped through, so a client bug can't turn into a server-side leak either.
 *
 * Incidents record the *type* and the JSON path. Never the value (CLAUDE.md).
 */

import type { PiiType } from '../protocol';
import { normalizeForCompare, scanText } from './validators';
import { isToken } from './vault';

export interface EgressIncident {
  kind: 'pattern' | 'vault-value';
  /** PII type for `pattern`, `'VAULT_VALUE'` for a known secret. */
  type: PiiType | 'VAULT_VALUE';
  /** Where in the payload, e.g. `elements[3].label`. */
  path: string;
  /** Validator rule name, when the hit came from a pattern. */
  rule?: string;
}

export interface EgressReport {
  ok: boolean;
  incidents: EgressIncident[];
  stringsScanned: number;
  charsScanned: number;
  /** Fields skipped because they are binary blobs — see SKIPPED_PATHS. */
  skipped: string[];
  durationMs: number;
}

/**
 * Paths excluded from the *text* scan.
 *
 * The screenshot is base64-encoded JPEG bytes. Running text validators over it is
 * meaningless — PII in an image isn't ASCII in the compressed stream — and with a
 * megabyte of random-looking digits, a Luhn-valid 16-digit run appears by chance
 * and would block every single request. The image is protected by pixel-level
 * redaction instead, and verified by the OCR leak test in `eval/`.
 */
const SKIPPED_PATHS = new Set(['screen.image_jpeg_b64']);

/** Anything longer than this that isn't at a skipped path is truncated, not dropped. */
const MAX_SCAN_CHARS = 20_000;

export interface GuardOptions {
  /** Real values from the vault. Matched case- and separator-insensitively. */
  secrets?: string[];
  /** Extra paths to exclude from the text scan. */
  skipPaths?: readonly string[];
}

/**
 * Walk every string in `payload` and report anything that looks like PII.
 * `ok === false` means: do not send this.
 */
export function guardPayload(payload: unknown, options: GuardOptions = {}): EgressReport {
  const startedAt = performance.now();
  const incidents: EgressIncident[] = [];
  const skipped: string[] = [];
  let stringsScanned = 0;
  let charsScanned = 0;

  const skipPaths = new Set([...SKIPPED_PATHS, ...(options.skipPaths ?? [])]);
  const normalizedSecrets = (options.secrets ?? [])
    .map((s) => ({ raw: s, normalized: normalizeForCompare(s) }))
    .filter((s) => s.normalized.length >= 4);

  const visit = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      if (skipPaths.has(path)) {
        skipped.push(path);
        return;
      }
      scanString(node, path);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${path}[${i}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };

  const scanString = (value: string, path: string): void => {
    if (!value) return;
    // A bare token is the expected shape of a sanitized value; nothing to check.
    if (isToken(value)) return;

    const text = value.length > MAX_SCAN_CHARS ? value.slice(0, MAX_SCAN_CHARS) : value;
    stringsScanned++;
    charsScanned += text.length;

    for (const match of scanText(text)) {
      incidents.push({ kind: 'pattern', type: match.type, path, rule: match.rule });
    }

    if (normalizedSecrets.length > 0) {
      const normalized = normalizeForCompare(text);
      for (const secret of normalizedSecrets) {
        if (normalized.includes(secret.normalized)) {
          incidents.push({ kind: 'vault-value', type: 'VAULT_VALUE', path });
          break; // one incident per string is enough; we're blocking either way
        }
      }
    }
  };

  visit(payload, '');

  return {
    ok: incidents.length === 0,
    incidents,
    stringsScanned,
    charsScanned,
    skipped,
    durationMs: performance.now() - startedAt,
  };
}

/** One-line summary for the UI and the incident log. Contains no values. */
export function describeIncidents(incidents: EgressIncident[]): string {
  if (incidents.length === 0) return 'clean';
  const counts = new Map<string, number>();
  for (const i of incidents) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, n]) => `${type}×${n}`).join(', ');
}
