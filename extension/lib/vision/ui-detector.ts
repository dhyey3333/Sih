/**
 * The custom UI detector: our own model, trained on `ml/synth`.
 *
 * It does two different jobs, and the second is the one that matters most.
 *
 * 1. **Redaction.** `pii_text`, `password_field`, `payment_card`, `id_document`,
 *    `qr_code` and `signature` become detections like any other, fused with the DOM
 *    and OCR layers.
 * 2. **Action.** `text_input` and `button` become *elements* — entries in the list
 *    the VLM reasons over. On a canvas-rendered app the DOM contains one `<canvas>`
 *    and nothing else, so without this the agent can see the screen but cannot act
 *    on it. These carry synthetic ids above `VISION_ID_BASE`; the agent turns a
 *    click on one into a `click_xy` at its centre, because there is no DOM element
 *    to resolve.
 *
 * The model is optional. If `ui_detector.onnx` is not in the bundle — it is produced
 * by a training run, not committed — everything degrades to the DOM, YuNet and OCR
 * layers, which is exactly the state before M5.
 */

import type { Detection, PiiType, Rect } from '../protocol';
import type { Vault } from '../pii/vault';
import {
  createSession,
  tensorFrom,
  type Backend,
  type InferenceSession,
  type ModelPath,
  type SessionInfo,
} from './runtime';
import { letterbox, nonMaxSuppression, YUNET_INPUT_SIZE, type FaceBox } from './yunet';

/**
 * Cast, deliberately: WXT types this union from what is actually in `public/`, and
 * this model is *produced by a training run* rather than committed. Before the first
 * run the file genuinely is absent — which `warmUp` handles as a normal state, not
 * an error.
 */
const MODEL_PATH = '/models/ui_detector.onnx' as ModelPath;

/** Must match `ml/synth/classes.py` — the label index *is* the contract. */
export const DETECTOR_CLASSES = [
  'text_input',
  'button',
  'password_field',
  'pii_text',
  'payment_card',
  'id_document',
  'qr_code',
  'signature',
] as const;

export type DetectorClass = (typeof DETECTOR_CLASSES)[number];

/** Classes that mean "redact this". */
const CLASS_TO_PII: Partial<Record<DetectorClass, PiiType>> = {
  password_field: 'PASSWORD',
  payment_card: 'CARD',
  id_document: 'ID_DOCUMENT',
  qr_code: 'QR_CODE',
  signature: 'SIGNATURE',
  // The model can see that a value is a secret but not *which kind* — reading that
  // off pixels is what the validators do, from characters, far more reliably.
  pii_text: 'GENERIC',
};

/** Classes that mean "the agent can act here". */
const CLASS_TO_ROLE: Partial<Record<DetectorClass, string>> = {
  text_input: 'textbox',
  button: 'button',
};

/**
 * Element ids at or above this came from the model, not the DOM. Chosen well clear
 * of the DOM's ids, which start at 1 and are capped at 160.
 */
export const VISION_ID_BASE = 1000;

/**
 * Fallback input side, used only if the model does not declare its own shape.
 *
 * The real value is read from the loaded graph: the export's `--imgsz` sets it, and
 * training at a smaller size to fit a laptop is a normal thing to do. Hardcoding 640
 * here would silently letterbox to the wrong size and produce boxes that are subtly,
 * consistently wrong.
 */
const DEFAULT_INPUT_SIZE = YUNET_INPUT_SIZE;

export interface VisionElement {
  id: number;
  role: string;
  bbox: Rect;
  confidence: number;
}

export interface UiDetectorResult {
  detections: Detection[];
  elements: VisionElement[];
  inferenceMs: number;
}

export class UiDetector {
  private session: InferenceSession | null = null;
  private info: SessionInfo | null = null;
  private loading: Promise<void> | null = null;
  /** Set once we know the model is not in the bundle, so we stop trying. */
  private unavailable = false;
  private inputName = 'images';
  private inputSize = DEFAULT_INPUT_SIZE;

  constructor(
    private readonly options: { scoreThreshold?: number; backend?: Backend } = {},
  ) {}

  get available(): boolean {
    return !this.unavailable;
  }

  get sessionInfo(): SessionInfo | null {
    return this.info;
  }

  async warmUp(): Promise<SessionInfo | null> {
    if (this.unavailable) return null;
    if (this.info && this.session) return this.info;

    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { session, info } = await createSession(MODEL_PATH, this.options.backend);
          this.session = session;
          this.info = info;
          this.inputName = session.inputNames[0] ?? 'images';
          this.inputSize = inputSideOf(session) ?? DEFAULT_INPUT_SIZE;
        } catch (error) {
          // No model in the bundle is a normal state before a training run, not a
          // failure. Say so once and move on.
          this.unavailable = true;
          console.info(
            'Custom UI detector not bundled; DOM + YuNet + OCR only.',
            error instanceof Error ? error.message : '',
          );
        }
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.info;
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.info = null;
  }

  async detect(
    image: CanvasImageSource,
    imageWidth: number,
    imageHeight: number,
    dpr: number,
    vault: Vault,
  ): Promise<UiDetectorResult> {
    await this.warmUp();
    if (!this.session) return { detections: [], elements: [], inferenceMs: 0 };

    const started = performance.now();
    const region = { x: 0, y: 0, w: imageWidth, h: imageHeight };
    // rgb01, not YuNet's bgr255: this is an Ultralytics export, and the two
    // conventions are not interchangeable (see PixelFormat in yunet.ts).
    const { data, scale } = letterbox(image, region, this.inputSize, 'rgb01');
    const outputs = await this.session.run({
      [this.inputName]: tensorFrom(data, [1, 3, this.inputSize, this.inputSize]),
    });

    const raw = decodeYolo(outputs, {
      letterboxScale: scale,
      dpr,
      scoreThreshold: this.options.scoreThreshold ?? 0.35,
    });

    const detections: Detection[] = [];
    const elements: VisionElement[] = [];
    let nextId = VISION_ID_BASE;

    for (const [i, box] of raw.entries()) {
      const name = DETECTOR_CLASSES[box.classIndex];
      if (!name) continue;

      const pii = CLASS_TO_PII[name];
      if (pii) {
        detections.push({
          id: `ui-detector:${i}`,
          type: pii,
          bbox: box.rect,
          confidence: Math.round(box.score * 1000) / 1000,
          source: 'vision',
          token: vault.mintToken(pii),
          detail: `ui-detector:${name}`,
        });
        continue;
      }

      const role = CLASS_TO_ROLE[name];
      if (role) {
        elements.push({
          id: nextId++,
          role,
          bbox: box.rect,
          confidence: Math.round(box.score * 1000) / 1000,
        });
      }
    }

    return {
      detections,
      elements,
      inferenceMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }
}

/**
 * The square input side the model was exported at, read from its own graph.
 * Returns null for a dynamic-shape export, where there is nothing to read.
 */
function inputSideOf(session: InferenceSession): number | null {
  const meta = (session as unknown as {
    inputMetadata?: Array<{ dims?: readonly (number | string)[]; shape?: readonly (number | string)[] }>;
  }).inputMetadata;
  const dims = meta?.[0]?.dims ?? meta?.[0]?.shape;
  if (!dims || dims.length < 4) return null;
  const side = dims[dims.length - 1];
  return typeof side === 'number' && side > 0 ? side : null;
}

/* ------------------------------------------------------------------ *
 * YOLO decoding
 * ------------------------------------------------------------------ */

interface ClassBox extends FaceBox {
  classIndex: number;
}

interface YoloDecodeOptions {
  letterboxScale: number;
  dpr: number;
  scoreThreshold?: number;
  nmsThreshold?: number;
}

/**
 * Decode an Ultralytics YOLO11 ONNX export.
 *
 * Output is a single `[1, 4 + numClasses, numAnchors]` tensor: the first four rows
 * are cx, cy, w, h **in input pixels** (not normalised — Ultralytics bakes the scale
 * into the graph), and the rest are per-class scores with no separate objectness.
 * The layout is channel-major, so an anchor's fields are strided by `numAnchors`,
 * which is the detail that silently produces garbage boxes if you read it as
 * anchor-major.
 */
export function decodeYolo(
  outputs: Record<string, { data: unknown; dims?: readonly number[] }>,
  options: YoloDecodeOptions,
): ClassBox[] {
  const first = Object.values(outputs)[0];
  if (!first) return [];

  const data = first.data as Float32Array;
  const dims = first.dims ?? [];
  // [1, channels, anchors]
  const channels = dims.length === 3 ? Number(dims[1]) : 4 + DETECTOR_CLASSES.length;
  const anchors = dims.length === 3 ? Number(dims[2]) : data.length / channels;
  const numClasses = channels - 4;
  if (numClasses <= 0 || !Number.isFinite(anchors)) return [];

  const { letterboxScale, dpr, scoreThreshold = 0.35, nmsThreshold = 0.45 } = options;
  const toCss = 1 / (letterboxScale * dpr);
  const candidates: ClassBox[] = [];

  for (let a = 0; a < anchors; a++) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * anchors + a]!;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0 || bestScore < scoreThreshold) continue;

    const cx = data[a]!;
    const cy = data[anchors + a]!;
    const w = data[2 * anchors + a]!;
    const h = data[3 * anchors + a]!;

    candidates.push({
      classIndex: best,
      score: bestScore,
      rect: {
        x: (cx - w / 2) * toCss,
        y: (cy - h / 2) * toCss,
        w: w * toCss,
        h: h * toCss,
      },
    });
  }

  // Per class, so a button sitting inside a detected input is not suppressed by it.
  const kept: ClassBox[] = [];
  for (let c = 0; c < numClasses; c++) {
    const ofClass = candidates.filter((b) => b.classIndex === c);
    if (ofClass.length === 0) continue;
    kept.push(...(nonMaxSuppression(ofClass, nmsThreshold) as ClassBox[]));
  }
  return kept.sort((a, b) => b.score - a.score).slice(0, 120);
}
