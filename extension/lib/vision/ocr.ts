/**
 * OCR over image regions.
 *
 * This is the layer that closes the last real hole. Region flagging redacts an
 * `<img class="aadhaar-scan">` wholesale, but it is driven by alt text, class names
 * and filenames — an ID card or a bank statement saved as `IMG_2043.png` carries no
 * such signal, and until something reads the pixels it is invisible to us.
 *
 * Deliberately **never full-page**. Page text already comes from the DOM, exactly and
 * for free; running OCR over it would be slower, less accurate, and would add false
 * positives to a layer that currently has none. This runs only on image, canvas and
 * video regions — the places the DOM genuinely cannot see into.
 *
 * Loaded lazily. The engine is ~8 MB of WASM and language data, and most pages never
 * need it, so nothing is instantiated until a region actually has to be read.
 */

import { createWorker, type Worker } from 'tesseract.js';
import type { PiiType, Rect } from '../protocol';
import { scanText } from '../pii/validators';
import { boxForSpan, linesOf } from './ocr-parse';

export interface OcrInfo {
  loadMs: number;
  /** Bundled asset footprint, for the resource metric. */
  assetBytes: number;
}

export interface OcrFinding {
  type: PiiType;
  value: string;
  /** In CSS pixels, ready to fuse with the other layers. */
  bbox: Rect;
  confidence: number;
}

export interface OcrRegionResult {
  findings: OcrFinding[];
  /** Characters recognised, for the stats line. Never the text itself. */
  charsRead: number;
}

/**
 * Roughly what `public/tesseract/` costs: core WASM + language data. Reported
 * rather than hidden — it is the single largest thing we ship after ORT.
 */
const ASSET_BYTES = 2_700_000 + 1_938_000;

/**
 * Small text OCRs badly. Upscaling the crop before recognition costs almost nothing
 * (a canvas draw) and is the difference between reading an Aadhaar number off a card
 * thumbnail and getting noise.
 *
 * Measured on the demo ID card: 700 px took 1,853 ms, 500 px took 1,831 ms and 400 px
 * took 1,509 ms — and all three read the number correctly. There is no accuracy to be
 * bought above ~400 px for this kind of content, only latency.
 */
const TARGET_MIN_HEIGHT = 400;
const MAX_UPSCALE = 3;

/** Cells per side of the per-region cache signature. */
const SIGNATURE_GRID = 16;

export class OcrEngine {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private info: OcrInfo | null = null;
  private assetBase: string | null = null;

  /**
   * Results keyed by the region's own pixels.
   *
   * This is what makes OCR affordable inside the agent loop. A single read costs
   * ~1.5 s, but across a twelve-step form fill the *images* never change — only the
   * form fields do. Hashing the region's pixels means step 2 onwards pays a canvas
   * draw instead of a second and a half, and a genuinely new image still gets read.
   */
  private readonly cache = new Map<string, OcrRegionResult>();
  private signatureCanvas: HTMLCanvasElement | null = null;
  private cacheHits = 0;

  /** Mirrors the vision runtime's override, so `eval/` can run this outside the extension. */
  setAssetBase(base: string): void {
    this.assetBase = base.replace(/\/$/, '');
  }

  private url(path: string): string {
    return this.assetBase !== null
      ? `${this.assetBase}${path}`
      : browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]);
  }

  get loaded(): boolean {
    return this.worker !== null;
  }

  async warmUp(): Promise<OcrInfo> {
    if (this.info && this.worker) return this.info;
    if (!this.loading) {
      this.loading = (async () => {
        const started = performance.now();
        // Every path is an extension URL: tesseract.js would otherwise fetch its
        // core and language data from a CDN, which MV3 forbids.
        this.worker = await createWorker('eng', 1, {
          workerPath: this.url('/tesseract/worker.min.js'),
          // A *specific file*, not a directory. Given a directory, tesseract.js probes
          // for the best variant it can run and asks for relaxed-SIMD first — a build
          // we deliberately do not ship, because carrying every variant is 6.4 MB each.
          // Pinning plain SIMD costs a little speed and works on every browser that
          // can run this extension (Chrome 91+, Firefox 89+).
          corePath: this.url('/tesseract/tesseract-core-simd-lstm.wasm.js'),
          langPath: this.url('/tesseract'),
          gzip: true,
          // Suppress the library's progress logging; it is noisy and can echo text.
          logger: () => {},
        });
        this.info = {
          loadMs: Math.round((performance.now() - started) * 10) / 10,
          assetBytes: ASSET_BYTES,
        };
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    if (!this.info) throw new Error('OCR engine failed to load');
    return this.info;
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
    this.info = null;
    // Recognised values live in here; drop them with the session.
    this.cache.clear();
    this.cacheHits = 0;
  }

  /**
   * Read one region of the capture and return only what the validators recognise
   * as PII. Recognised text that is *not* PII is discarded immediately and never
   * stored, logged or returned.
   */
  async readRegion(
    image: CanvasImageSource,
    region: { x: number; y: number; w: number; h: number },
    dpr: number,
  ): Promise<OcrRegionResult> {
    const key = this.signature(image, region);
    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    await this.warmUp();
    if (!this.worker) throw new Error('OCR engine failed to load');

    const upscale = Math.min(MAX_UPSCALE, Math.max(1, TARGET_MIN_HEIGHT / region.h));
    const width = Math.round(region.w * upscale);
    const height = Math.round(region.h * upscale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for OCR');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, width, height);

    const { data } = await this.worker.recognize(canvas, {}, { blocks: true });

    const findings: OcrFinding[] = [];
    let charsRead = 0;

    // crop px → device px → CSS px, in that order.
    const toCss = (v: number) => v / upscale / dpr;

    for (const line of linesOf(data)) {
      charsRead += line.text.length;
      for (const match of scanText(line.text)) {
        const box = boxForSpan(line, match.start, match.end);
        if (!box) continue;
        findings.push({
          type: match.type,
          value: match.value,
          bbox: {
            x: region.x / dpr + toCss(box.x0),
            y: region.y / dpr + toCss(box.y0),
            w: toCss(box.x1 - box.x0),
            h: toCss(box.y1 - box.y0),
          },
          // OCR is a noisier source than the DOM; discount accordingly. Tesseract's
          // own per-word confidence is 0–100.
          confidence: Math.min(0.95, (match.confidence * (line.confidence / 100)) ** 0.5),
        });
      }
    }

    const result = { findings, charsRead };
    // Bounded: a long browsing session should not accumulate regions forever.
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }

  /** How many reads the cache saved this session. Shown in the metrics panel. */
  get savedReads(): number {
    return this.cacheHits;
  }

  /**
   * A cheap content hash of the region: 16×16 greyscale, quantised to 16 levels.
   *
   * Quantising matters — JPEG noise makes exact pixel equality useless between two
   * captures of an unchanged screen, while a coarse hash is stable across it and
   * still changes the moment the image genuinely does.
   */
  private signature(image: CanvasImageSource, region: { x: number; y: number; w: number; h: number }): string {
    if (!this.signatureCanvas) {
      this.signatureCanvas = document.createElement('canvas');
      this.signatureCanvas.width = SIGNATURE_GRID;
      this.signatureCanvas.height = SIGNATURE_GRID;
    }
    const ctx = this.signatureCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return `${region.x},${region.y},${region.w},${region.h},nohash`;

    ctx.clearRect(0, 0, SIGNATURE_GRID, SIGNATURE_GRID);
    ctx.drawImage(
      image,
      region.x, region.y, region.w, region.h,
      0, 0, SIGNATURE_GRID, SIGNATURE_GRID,
    );
    const { data } = ctx.getImageData(0, 0, SIGNATURE_GRID, SIGNATURE_GRID);

    let hash = '';
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      hash += (luma >> 4).toString(16);
    }
    return `${Math.round(region.w)}x${Math.round(region.h)}:${hash}`;
  }
}
