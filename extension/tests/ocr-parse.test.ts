import { describe, expect, it } from 'vitest';
import { boxForSpan, linesOf, type OcrLine } from '../lib/vision/ocr-parse';
import { scanText } from '../lib/pii/validators';
import { FAKE } from './fixtures';

/** A Tesseract-shaped result tree. */
function tesseractData(lines: Array<{ words: string[]; confidence?: number }>) {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: lines.map((line) => ({
              confidence: line.confidence ?? 90,
              words: line.words.map((text, i) => ({
                text,
                bbox: { x0: i * 100, y0: 0, x1: i * 100 + 80, y1: 20 },
              })),
            })),
          },
        ],
      },
    ],
  };
}

describe('linesOf', () => {
  it('rebuilds line text from words', () => {
    const [line] = linesOf(tesseractData([{ words: ['Aadhaar', 'Number'] }]));
    expect(line!.text).toBe('Aadhaar Number');
  });

  it('records offsets that index back into the line text', () => {
    const [line] = linesOf(tesseractData([{ words: ['GOVERNMENT', 'OF', 'INDIA'] }]));
    for (const word of line!.words) {
      expect(line!.text.slice(word.start, word.end)).toBe(word.text);
    }
  });

  it('walks every level of the tree', () => {
    const lines = linesOf(tesseractData([{ words: ['one'] }, { words: ['two'] }]));
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('carries the line confidence through', () => {
    const [line] = linesOf(tesseractData([{ words: ['x'], confidence: 42 }]));
    expect(line!.confidence).toBe(42);
  });

  it('skips words with no text or no box', () => {
    const data = {
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  confidence: 80,
                  words: [
                    { text: 'good', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
                    { text: '', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
                    { text: 'noBox' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [line] = linesOf(data);
    expect(line!.text).toBe('good');
  });

  it('drops blank lines', () => {
    expect(linesOf(tesseractData([{ words: ['   '] }]))).toEqual([]);
  });

  it('survives a shape it does not recognise rather than throwing', () => {
    // The tree layout has changed across tesseract.js majors; an empty result in
    // the middle of a redaction pass is far better than an exception.
    expect(linesOf(null)).toEqual([]);
    expect(linesOf({})).toEqual([]);
    expect(linesOf({ blocks: 'nope' })).toEqual([]);
    expect(linesOf({ blocks: [{}] })).toEqual([]);
    expect(linesOf({ blocks: [{ paragraphs: [{ lines: [{}] }] }] })).toEqual([]);
  });
});

describe('boxForSpan', () => {
  const line: OcrLine = linesOf(tesseractData([{ words: ['Name:', 'Ananya', 'Iyer'] }]))[0]!;

  it('returns the box of the single word a span falls in', () => {
    const start = line.text.indexOf('Ananya');
    expect(boxForSpan(line, start, start + 6)).toEqual({ x0: 100, y0: 0, x1: 180, y1: 20 });
  });

  it('unions the boxes of every word a span crosses', () => {
    const start = line.text.indexOf('Ananya');
    const box = boxForSpan(line, start, line.text.length);
    expect(box).toEqual({ x0: 100, y0: 0, x1: 280, y1: 20 });
  });

  it('returns null when nothing overlaps', () => {
    expect(boxForSpan(line, 9999, 10000)).toBeNull();
  });

  it('handles a line with no words', () => {
    expect(boxForSpan({ text: 'x', words: [], confidence: 90 }, 0, 1)).toBeNull();
  });
});

describe('end to end over a line, the way readRegion uses it', () => {
  it('boxes an Aadhaar number split across three OCR words', () => {
    // Tesseract splits "2234 5678 9018" into three words; the box must cover all three.
    const [line] = linesOf(tesseractData([{ words: ['2234', '5678', '9018'] }]));
    const matches = scanText(line!.text);
    expect(matches.map((m) => m.type)).toContain('AADHAAR');

    const match = matches.find((m) => m.type === 'AADHAAR')!;
    expect(boxForSpan(line!, match.start, match.end)).toEqual({ x0: 0, y0: 0, x1: 280, y1: 20 });
  });

  it('boxes only the PII, not the label beside it', () => {
    const [line] = linesOf(tesseractData([{ words: ['Email:', FAKE.email] }]));
    const match = scanText(line!.text).find((m) => m.type === 'EMAIL')!;
    const box = boxForSpan(line!, match.start, match.end)!;
    // The label word starts at x0 = 0; the box must start after it.
    expect(box.x0).toBe(100);
  });

  it('finds nothing in a line of ordinary card text', () => {
    const [line] = linesOf(tesseractData([{ words: ['GOVERNMENT', 'OF', 'INDIA'] }]));
    expect(scanText(line!.text)).toEqual([]);
  });
});
