/**
 * Turning Tesseract's block tree into lines with word offsets.
 *
 * Split out from `ocr.ts` so it can be unit-tested in plain Node: importing
 * `tesseract.js` drags in a worker and a WASM loader, and this is the part with the
 * arithmetic worth testing.
 *
 * Same shape as `lib/dom/text-blocks.ts`, for the same reason: a PII match spans
 * several words, and we need one pixel box covering exactly that span.
 */

export interface OcrWord {
  text: string;
  bbox: OcrBox;
  /** Offsets into the parent line's concatenated text. */
  start: number;
  end: number;
}

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
  /** Tesseract's own 0–100 confidence for the line. */
  confidence: number;
}

function arrayOf(node: unknown, key: string): unknown[] {
  const value = (node as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Flatten blocks → paragraphs → lines, rebuilding each line's text alongside the
 * word offsets that go with it. Tolerant of missing levels: the shape of this tree
 * has changed across tesseract.js majors, and a silent empty result is far better
 * than a thrown exception in the middle of a redaction pass.
 */
export function linesOf(data: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  const blocks = (data as { blocks?: unknown[] } | null)?.blocks;
  if (!Array.isArray(blocks)) return out;

  for (const block of blocks) {
    for (const paragraph of arrayOf(block, 'paragraphs')) {
      for (const rawLine of arrayOf(paragraph, 'lines')) {
        const words: OcrWord[] = [];
        let text = '';

        for (const rawWord of arrayOf(rawLine, 'words')) {
          const w = rawWord as { text?: string; bbox?: OcrBox };
          if (!w.text || !w.bbox) continue;
          if (text) text += ' ';
          const start = text.length;
          text += w.text;
          words.push({ text: w.text, bbox: w.bbox, start, end: text.length });
        }

        if (!text.trim()) continue;
        out.push({
          text,
          words,
          confidence: (rawLine as { confidence?: number }).confidence ?? 0,
        });
      }
    }
  }
  return out;
}

/**
 * Union of the boxes of every word overlapping `[start, end)`.
 *
 * The union rather than an interpolation: a redaction box that is slightly too big
 * is harmless, one that is slightly too small leaks the edge of a digit.
 */
export function boxForSpan(line: OcrLine, start: number, end: number): OcrBox | null {
  const covering = line.words.filter((w) => start < w.end && w.start < end);
  if (covering.length === 0) return null;

  return covering.reduce<OcrBox>(
    (acc, w) => ({
      x0: Math.min(acc.x0, w.bbox.x0),
      y0: Math.min(acc.y0, w.bbox.y0),
      x1: Math.max(acc.x1, w.bbox.x1),
      y1: Math.max(acc.y1, w.bbox.y1),
    }),
    { ...covering[0]!.bbox },
  );
}
