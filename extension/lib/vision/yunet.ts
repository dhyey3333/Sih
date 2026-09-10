/**
 * YuNet face detection — pre-processing, decoding and NMS.
 *
 * Model: `face_detection_yunet_2023mar.onnx` from the OpenCV Zoo. 227 KB, and it
 * is the reason the vision layer is affordable at all: a general object detector
 * that also finds faces would be 10–40× the size for a job this specific.
 *
 * The model is a fixed 640×640 build with three output strides. For each stride
 * it emits a classification score, an objectness score, a box offset and five
 * landmarks per anchor cell; the final confidence is the geometric mean of the
 * two scores, which is what OpenCV's own implementation uses.
 *
 * Coordinate spaces, in order, because mixing them is the classic bug here:
 *   model space (640×640, letterboxed) → image space (device px) → CSS px
 */

import type { Rect } from '../protocol';

export const YUNET_INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;

export interface FaceBox {
  rect: Rect;
  score: number;
}

export interface LetterboxResult {
  data: Float32Array;
  /** source px → model px. Divide by this to go back. */
  scale: number;
}

/** The sub-rectangle of the source to feed the model, in source (device) pixels. */
export interface SourceRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resize into a 640×640 letterbox, top-left aligned, and lay the pixels out as
 * NCHW **BGR** float32 in 0–255.
 *
 * Two details that are easy to get wrong and produce silently terrible results:
 * YuNet is an OpenCV model, so it expects BGR channel order, and it expects raw
 * 0–255 values — `blobFromImage`'s defaults apply no mean subtraction and no
 * scaling. Feeding it normalised RGB "works" and detects nothing.
 *
 * Top-left rather than centred padding keeps the reverse mapping a single
 * division, with no offset to forget.
 */
/**
 * Channel order and value range the model expects.
 *
 * These are **not** interchangeable, and getting it wrong fails loudly in one
 * direction and silently in the other. Measured on our own YOLO export: fed
 * `bgr255` it returns 2,187 boxes all at confidence exactly 1.0 — saturated
 * nonsense that looks like a working detector until you plot the boxes.
 *
 *   bgr255  OpenCV convention. YuNet, and anything exported from OpenCV's zoo.
 *   rgb01   The usual deep-learning convention. Ultralytics YOLO.
 */
export type PixelFormat = 'bgr255' | 'rgb01';

export function letterbox(
  source: CanvasImageSource,
  region: SourceRegion,
  /** Model input side. YuNet is a fixed 640 build; the custom detector reads its own. */
  inputSize: number = YUNET_INPUT_SIZE,
  format: PixelFormat = 'bgr255',
): LetterboxResult {
  const size = inputSize;
  // No `min(1, …)` cap: a 96 px avatar crop is deliberately *upscaled* to fill the
  // input. The model works in its own 640×640 space, so giving a small face more of
  // that space is precisely what makes it detectable.
  const scale = Math.min(size / region.w, size / region.h);
  const drawWidth = Math.max(1, Math.round(region.w * scale));
  const drawHeight = Math.max(1, Math.round(region.h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable for letterboxing');

  // Black padding, matching what the model saw during training.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, drawWidth, drawHeight);

  const { data: rgba } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;
  const out = new Float32Array(3 * plane);

  if (format === 'rgb01') {
    for (let i = 0; i < plane; i++) {
      const o = i * 4;
      out[i] = rgba[o]! / 255; // R
      out[plane + i] = rgba[o + 1]! / 255; // G
      out[2 * plane + i] = rgba[o + 2]! / 255; // B
    }
  } else {
    for (let i = 0; i < plane; i++) {
      const o = i * 4;
      out[i] = rgba[o + 2]!; // B
      out[plane + i] = rgba[o + 1]!; // G
      out[2 * plane + i] = rgba[o]!; // R
    }
  }

  return { data: out, scale };
}

export interface DecodeOptions {
  /** Minimum confidence. 0.6 is OpenCV's default and holds up well. */
  scoreThreshold?: number;
  nmsThreshold?: number;
  /** model px → source px is `1 / letterboxScale`. */
  letterboxScale: number;
  /** Where the fed region sits in the source image, in source px. */
  offsetX?: number;
  offsetY?: number;
  /** source (device) px → CSS px. */
  dpr: number;
  maxFaces?: number;
}

type OutputMap = Record<string, { data: Float32Array | Uint8Array | unknown }>;

function floats(outputs: OutputMap, name: string): Float32Array {
  const tensor = outputs[name];
  if (!tensor) throw new Error(`YuNet output "${name}" missing — wrong model build?`);
  return tensor.data as Float32Array;
}

/**
 * Turn the twelve output tensors into face rects in **CSS pixels**.
 */
export function decodeFaces(outputs: OutputMap, options: DecodeOptions): FaceBox[] {
  const {
    scoreThreshold = 0.6,
    nmsThreshold = 0.3,
    letterboxScale,
    offsetX = 0,
    offsetY = 0,
    dpr,
    maxFaces = 32,
  } = options;

  // model px → source px, then source px → CSS px, with the region offset applied
  // in source space in between.
  const toSource = 1 / letterboxScale;
  const candidates: FaceBox[] = [];

  for (const stride of STRIDES) {
    const cls = floats(outputs, `cls_${stride}`);
    const obj = floats(outputs, `obj_${stride}`);
    const bbox = floats(outputs, `bbox_${stride}`);

    const gridWidth = YUNET_INPUT_SIZE / stride;
    const cells = cls.length;

    for (let i = 0; i < cells; i++) {
      // Geometric mean of classification and objectness, as OpenCV does.
      const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
      if (score < scoreThreshold) continue;

      // Anchors are generated row-major.
      const col = i % gridWidth;
      const row = Math.floor(i / gridWidth);
      const o = i * 4;

      const cx = (col + bbox[o]!) * stride;
      const cy = (row + bbox[o + 1]!) * stride;
      const w = Math.exp(bbox[o + 2]!) * stride;
      const h = Math.exp(bbox[o + 3]!) * stride;

      candidates.push({
        score,
        rect: {
          x: (offsetX + (cx - w / 2) * toSource) / dpr,
          y: (offsetY + (cy - h / 2) * toSource) / dpr,
          w: (w * toSource) / dpr,
          h: (h * toSource) / dpr,
        },
      });
    }
  }

  return nonMaxSuppression(candidates, nmsThreshold).slice(0, maxFaces);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function iou(a: Rect, b: Rect): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x) * Math.max(0, y2 - y);
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

export function nonMaxSuppression(boxes: FaceBox[], threshold: number): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const box of sorted) {
    if (kept.every((k) => iou(k.rect, box.rect) < threshold)) kept.push(box);
  }
  return kept;
}
