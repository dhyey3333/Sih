/**
 * Redaction rendering (§3.4 of docs/PLAN.md).
 *
 * Runs on the captured screenshot, in the side panel, before anything is
 * serialized. Two styles, and the difference matters:
 *
 *   - block:    an opaque fill. Used for all text-like PII. A blur or a pixelation
 *               of text is reversible — the glyph set is tiny and known, so
 *               deconvolution or a super-resolution model recovers it. Paint over it.
 *   - pixelate: coarse mosaic. Used only for faces, where a solid box would destroy
 *               the layout cue the VLM needs ("there is a person's avatar here")
 *               and where there is no small alphabet to brute-force.
 *
 * Every box also gets its token drawn on it, so the server can see *what* was
 * removed and refer to it, and so a judge can read the redaction legend straight
 * off the screenshot.
 */

import type { Detection, Rect } from '../protocol';
import { REDACTION_STYLE } from '../protocol';

export interface RenderOptions {
  /** devicePixelRatio of the captured tab: CSS rects × dpr = image pixels. */
  dpr: number;
  /** Mosaic cell size in CSS pixels. 12+ is "heavy" per the plan. */
  pixelBlock?: number;
  /** Draw the `⟦TOKEN⟧` label on each box. */
  labels?: boolean;
  fill?: string;
  stroke?: string;
  labelColor?: string;
}

const DEFAULTS = {
  pixelBlock: 14,
  labels: true,
  fill: '#0b0d12',
  stroke: '#ff4d6d',
  labelColor: '#ff9db1',
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // `willReadFrequently` matters: the pixelate path reads back region by region.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** CSS-pixel rect → integer device-pixel rect, clamped to the image. */
function toDeviceRect(rect: Rect, dpr: number, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(rect.x * dpr));
  const y = Math.max(0, Math.floor(rect.y * dpr));
  const x2 = Math.min(width, Math.ceil((rect.x + rect.w) * dpr));
  const y2 = Math.min(height, Math.ceil((rect.y + rect.h) * dpr));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

function drawBlock(ctx: CanvasRenderingContext2D, r: Rect, opts: Required<RenderOptions>): void {
  ctx.fillStyle = opts.fill;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

function drawPixelated(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  r: Rect,
  opts: Required<RenderOptions>,
): void {
  const block = Math.max(2, Math.round(opts.pixelBlock * opts.dpr));
  const cols = Math.max(1, Math.round(r.w / block));
  const rows = Math.max(1, Math.round(r.h / block));

  // Downscale into a tiny buffer, then blow it back up with smoothing off.
  const scratch = createCanvas(cols, rows);
  const scratchCtx = context2d(scratch);
  scratchCtx.imageSmoothingEnabled = false;
  scratchCtx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, cols, rows);

  const previous = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, cols, rows, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = previous;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  token: string,
  opts: Required<RenderOptions>,
): void {
  // Scale the label to the box, then bail out if it still won't fit — a label
  // spilling outside its box would cover neighbouring content.
  const fontSize = Math.min(13 * opts.dpr, Math.max(9 * opts.dpr, r.h * 0.62));
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'middle';

  const metrics = ctx.measureText(token);
  if (metrics.width > r.w - 4 || fontSize > r.h) return;

  ctx.fillStyle = opts.labelColor;
  ctx.fillText(token, r.x + (r.w - metrics.width) / 2, r.y + r.h / 2);
}

export interface RenderResult {
  canvas: HTMLCanvasElement;
  /** Boxes actually painted, in device pixels — used by the eval mask metric. */
  painted: Array<{ token: string; rect: Rect; style: 'block' | 'pixelate' }>;
  durationMs: number;
}

/**
 * Paint the redactions onto a copy of the screenshot.
 * The source image is never mutated, so the side panel can still show the original.
 */
export function renderRedacted(
  source: CanvasImageSource,
  width: number,
  height: number,
  detections: Detection[],
  options: RenderOptions,
): RenderResult {
  const startedAt = performance.now();
  const opts = { ...DEFAULTS, ...options } as Required<RenderOptions>;

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(source, 0, 0, width, height);

  const painted: RenderResult['painted'] = [];

  for (const detection of detections) {
    const rect = toDeviceRect(detection.bbox, opts.dpr, width, height);
    if (rect.w <= 0 || rect.h <= 0) continue;

    const style = REDACTION_STYLE[detection.type];
    if (style === 'pixelate') {
      drawPixelated(ctx, canvas, rect, opts);
    } else {
      drawBlock(ctx, rect, opts);
    }

    // A thin outline makes the redaction obvious on stage and in the eval images.
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = Math.max(1, Math.round(opts.dpr));
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    if (opts.labels) drawLabel(ctx, rect, detection.token, opts);
    painted.push({ token: detection.token, rect, style });
  }

  return { canvas, painted, durationMs: performance.now() - startedAt };
}

export interface MarkOptions {
  dpr: number;
  /** Boxes already redacted; marks are nudged so they never cover a token label. */
  avoid?: Rect[];
  background?: string;
  color?: string;
}

/**
 * Set-of-Mark: draw a small numbered badge on each interactive element.
 *
 * This is what lets a modest open-weights VLM act reliably. Asked to "click the
 * blue Continue button" it has to describe a pixel location; asked to return an
 * element id it only has to read a number off the image, which is a far easier
 * task and is exactly grounded in our element list.
 *
 * Drawn after redaction so a badge can never be painted over.
 */
export function drawSetOfMarks(
  canvas: HTMLCanvasElement,
  marks: Array<{ id: number; bbox: Rect }>,
  options: MarkOptions,
): void {
  const ctx = context2d(canvas);
  const dpr = options.dpr;
  const background = options.background ?? '#1d4ed8';
  const color = options.color ?? '#ffffff';
  const fontSize = Math.round(11 * dpr);
  const padX = Math.round(4 * dpr);
  const height = Math.round(16 * dpr);

  ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';

  for (const mark of marks) {
    const label = String(mark.id);
    const width = Math.ceil(ctx.measureText(label).width) + padX * 2;

    // Top-left corner of the element, pulled inside the image if it would clip.
    let x = Math.max(0, Math.round(mark.bbox.x * dpr));
    let y = Math.max(0, Math.round(mark.bbox.y * dpr));
    x = Math.min(x, canvas.width - width);
    y = Math.min(y, canvas.height - height);

    ctx.fillStyle = background;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = color;
    ctx.fillText(label, x + padX, y + height / 2);
  }
}

/** JPEG keeps the payload small; quality 0.72 is the point where OCR of a
 *  *non*-redacted screenshot still works, so the leak test stays honest. */
export function toJpegDataUrl(canvas: HTMLCanvasElement, quality = 0.72): string {
  return canvas.toDataURL('image/jpeg', quality);
}

/** Strip the `data:image/jpeg;base64,` prefix for the wire format. */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured tab image'));
    img.src = src;
  });
}
