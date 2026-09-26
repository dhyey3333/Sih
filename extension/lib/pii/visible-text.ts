/**
 * The screen's text, made safe to send.
 *
 * A 3B vision model asked "what is the status of my application?" answered
 * "Application status confirmed." — it could not read the word on the screenshot.
 * Text is how small models read. So at disclosure level 2, where the redacted
 * screenshot already goes, the same screen goes as text too.
 *
 * "The same screen" is the whole privacy argument, and three things make it true:
 *
 *  1. Every value the text layer found is replaced by the token its box carries,
 *     by offset, from the same scan that painted the boxes (lib/dom/snapshot.ts).
 *     The two can't disagree about what was sensitive.
 *  2. A block that a pixel detector covered — vision or OCR saw something there
 *     that the text rules did not — is sent as that box's token and nothing else.
 *     The text never says what the image hides.
 *  3. The result goes through the text sanitizer again, with the block's context,
 *     and then through the egress guard like every other string.
 *
 * Faces don't count for (2): a face beside a caption says nothing about the caption.
 * Nor does a vague pixel box ("this looks like personal text", GENERIC) that sits on a
 * value the text layer already found: the text layer read those exact characters and
 * tokenized them, so the block goes with that token — `⟦PROFILE.EMAIL⟧`, not an
 * anonymous `⟦GENERIC_1⟧`. A vague box over text the text layer found clean still
 * withholds it: that is the case of a third party's name, which only pixels caught.
 */

import type { Detection, Rect, VisibleTextBlock } from '../protocol';
import { sanitizeText } from './sanitize';
import type { Vault } from './vault';

/** Enough for a form or a status page. A small model's context is the constraint. */
export const MAX_VISIBLE_TEXT = 4000;
const MAX_BLOCK_CHARS = 400;

/** How much of either box must overlap before a pixel detection withholds a block. */
const COVER_RATIO = 0.3;

export function buildVisibleText(
  blocks: VisibleTextBlock[],
  detections: Detection[],
  vault: Vault,
  maxChars = MAX_VISIBLE_TEXT,
): string {
  const fromText = detections.filter((d) => d.source === 'dom-text' || d.source === 'dom-field');
  const pixelOnly = detections.filter(
    (d) =>
      (d.source === 'vision' || d.source === 'ocr') &&
      d.type !== 'FACE' &&
      !(d.type === 'GENERIC' && d.source === 'vision' && fromText.some((t) => explains(t.bbox, d.bbox))),
  );

  const lines: string[] = [];
  let used = 0;
  let previous = '';

  for (const block of blocks) {
    const covering = pixelOnly.filter((d) => covers(d.bbox, block.bbox));
    // "Registered email" then "⟦PROFILE.EMAIL⟧" on the next line reads, to a small
    // model, as a label with nothing after it — a 3B model answered with the label.
    // A value whose label is the line just written joins it: "Registered email: …".
    const labelled = block.label !== undefined && collapse(block.label) === previous && lines.length > 0;
    previous = collapse(block.text);
    const line = clampAtWord(
      covering.length > 0
        ? [...new Set(covering.map((d) => d.token))].join(' ')
        : sanitizeText(collapse(replaceSpans(block, vault)), vault, block.context).text,
      MAX_BLOCK_CHARS,
    );
    if (!line || line === lines.at(-1)) continue;
    if (labelled && covering.length === 0) {
      const label = lines.pop()!;
      used -= label.length + 1;
      const joined = `${label}${/[:：]$/.test(label) ? ' ' : ': '}${line}`;
      if (used + joined.length + 1 > maxChars) {
        lines.push('…');
        break;
      }
      lines.push(joined);
      used += joined.length + 1;
      continue;
    }
    if (used + line.length + 1 > maxChars) {
      lines.push('…');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

/** The block's text with each marked span swapped for its token, by offset. */
function replaceSpans(block: VisibleTextBlock, vault: Vault): string {
  const spans = [...block.spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // overlapping match; the earlier one already covers it
    out += block.text.slice(cursor, span.start) + vault.tokenize(span.type, span.value);
    cursor = span.end;
  }
  return out + block.text.slice(cursor);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cut at a word boundary, and never inside a token — half a token is noise. */
function clampAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf(' ', max - 1);
  if (cut < max / 2) cut = max - 1;
  const open = text.lastIndexOf('⟦', cut);
  if (open !== -1 && text.indexOf('⟧', open) >= cut) cut = open;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function covers(detection: Rect, block: Rect): boolean {
  const w = Math.min(detection.x + detection.w, block.x + block.w) - Math.max(detection.x, block.x);
  const h = Math.min(detection.y + detection.h, block.y + block.h) - Math.max(detection.y, block.y);
  if (w <= 0 || h <= 0) return false;
  const overlap = w * h;
  const smaller = Math.min(detection.w * detection.h, block.w * block.h);
  return smaller > 0 && overlap / smaller >= COVER_RATIO;
}

/**
 * A text-layer finding that accounts for a vague pixel box: it fills most of it.
 * One-directional on purpose — a large box over a paragraph is not explained by the
 * one email inside it, because the rest of what it covers may be a name.
 */
function explains(finding: Rect, pixel: Rect): boolean {
  const w = Math.min(finding.x + finding.w, pixel.x + pixel.w) - Math.max(finding.x, pixel.x);
  const h = Math.min(finding.y + finding.h, pixel.y + pixel.h) - Math.max(finding.y, pixel.y);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (pixel.w * pixel.h) >= 0.5;
}

/**
 * Vague pixel boxes that the text under them contradicts.
 *
 * The detector's `pii_text` class (GENERIC) says "this looks like personal text", and
 * on government portals it fires on deadlines — "Last date to apply: 31 October 2026"
 * came back as a black box, and the question about it went unanswered. When the text
 * layer has read those exact characters, found nothing, and they are only a date
 * that has not happened yet, the box is wrong: a future date is nobody's date of
 * birth. It is dropped from the image and the text alike, so the two still agree.
 *
 * Deliberately narrow. Past dates keep their box (one could be a birth date with its
 * label out of view), and so does anything with a name, a number or a word in it.
 */
export function dismissFutureDateBoxes(
  detections: Detection[],
  blocks: VisibleTextBlock[],
  today: Date = new Date(),
): Detection[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return detections.filter((d) => {
    if (d.source !== 'vision' || d.type !== 'GENERIC') return true;
    const under = blocks.filter((b) => covers(d.bbox, b.bbox));
    if (under.length === 0) return true;
    return !under.every((b) => {
      if (b.spans.length > 0) return false;
      const date = parseDate(collapse(b.text).replace(DATE_LEAD, ''));
      return date !== null && date.getTime() > start;
    });
  });
}

/** Words that introduce a deadline without changing what it is. */
const DATE_LEAD =
  /^(?:(?:last|closing|due|end|expiry|expires?|valid|open|opens|closes)\s+(?:date|on|till|until|by)?\s*[:：-]?\s*|(?:until|till|by|before|on|from|up\s*to|upto)\s+)/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];

/** "31 October 2026", "October 31, 2026", "31/10/2026", "2026-10-31". Null for anything else. */
export function parseDate(text: string): Date | null {
  const t = text.trim().replace(/[.,]$/, '');
  let m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(t);
  if (m) return build(+m[3]!, monthOf(m[2]!), +m[1]!);
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(t);
  if (m) return build(+m[3]!, monthOf(m[1]!), +m[2]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t); // day first, as India writes it
  if (m) return build(+m[3]!, +m[2]! - 1, +m[1]!);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return build(+m[1]!, +m[2]! - 1, +m[3]!);
  return null;
}

/** A month name or its abbreviation ("Oct", "Sept"); -1 for any other word ("Mayor"). */
function monthOf(word: string): number {
  const w = word.toLowerCase() === 'sept' ? 'sep' : word.toLowerCase();
  return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
}

function build(year: number, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1) return null;
  const d = new Date(year, month, day);
  return d.getMonth() === month && d.getDate() === day ? d : null;
}
