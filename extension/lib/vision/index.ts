/**
 * The vision layer.
 *
 * Scope, deliberately narrow: this covers what the DOM *cannot* see. A profile
 * photo, an uploaded ID-card scan, a canvas-rendered app, a PDF page. Anything
 * the DOM can describe is already handled deterministically, in microseconds, by
 * `lib/pii/` — running a model over it too would cost time and add false
 * positives without adding recall (docs/DECISIONS.md D1).
 *
 * Two sources of truth here, and they are honestly different:
 *
 *   dom-image  What the page says an image *is* — `class="avatar"`,
 *              `src=".../aadhaar-front.png"`. Free, exact boxes, and it works on
 *              an illustration or an icon that no face detector would fire on.
 *              Blind to an ID card named `IMG_2043.jpg`.
 *   vision     YuNet actually looking at the pixels. Catches the photo the page
 *              never labelled, at the cost of ~15–40 ms and a 227 KB model.
 *
 * Neither is sufficient. Both run, and the fusion step merges them.
 */

import type { Detection, DomSnapshot, ImageCandidate, PiiType, Rect } from '../protocol';
import type { Vault } from '../pii/vault';
import { ChangeDetector } from './change';
import { OcrEngine } from './ocr';
import {
  createSession,
  tensorFrom,
  type Backend,
  type InferenceSession,
  type SessionInfo,
} from './runtime';
import {
  decodeFaces,
  letterbox,
  nonMaxSuppression,
  YUNET_INPUT_SIZE,
  type FaceBox,
} from './yunet';

const YUNET_PATH = '/models/face_detection_yunet.onnx' as const;

/**
 * An image whose longest edge (in device px) is at or below this is a candidate for
 * a close-up pass. Above it, the whole-frame pass has enough pixels to work with.
 */
const SMALL_IMAGE_PX = 320;

/** Hard cap on close-up passes per frame, so a gallery page cannot stall the loop. */
const MAX_CROP_PASSES = 4;

/**
 * OCR costs 100–500 ms per region, so it is strictly rationed: only regions big
 * enough to hold legible text, only a couple per frame, document-like ones first.
 */
const MAX_OCR_REGIONS = 3;
const MIN_OCR_WIDTH = 80;
const MIN_OCR_HEIGHT = 40;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** What an image's alt/class/filename hint implies. */
const HINT_TYPES: Record<string, PiiType> = {
  'avatar-like': 'FACE',
  'document-like': 'ID_DOCUMENT',
  'signature-like': 'SIGNATURE',
  'code-like': 'QR_CODE',
};

export interface VisionStats {
  /** Null until the model has been loaded. */
  session: SessionInfo | null;
  /** Inference wall time, or 0 when the frame was skipped. */
  inferenceMs: number;
  facesFound: number;
  imageRegions: number;
  /** Extra close-up passes run on small images the whole-frame pass could not see into. */
  cropPasses?: number;
  /** Image regions read by OCR this frame. */
  ocrRegions?: number;
  ocrMs?: number;
  /** Characters recognised. The text itself is discarded unless it is PII. */
  ocrCharsRead?: number;
  ocrFindings?: number;
  ocrLoadMs?: number;
  /** Reads avoided because the region's pixels were unchanged. */
  ocrCacheHits?: number;
  skipped: boolean;
  skipReason?: string;
  changeDiff?: number;
}

export interface VisionResult {
  detections: Detection[];
  stats: VisionStats;
}

export class VisionLayer {
  private session: InferenceSession | null = null;
  private sessionInfo: SessionInfo | null = null;
  private loading: Promise<void> | null = null;
  private readonly change = new ChangeDetector();

  /** Cached detections, reused when the screen has not changed. */
  private cache: Detection[] = [];

  /**
   * Turning this off leaves only the DOM and text layers running — which is the
   * most instructive comparison to show a judge, because it is exactly the state
   * where a profile photo and an ID-card scan go out unredacted.
   */
  enabled = true;

  /** OCR is the expensive half; it can be turned off independently of face detection. */
  ocrEnabled = true;

  private readonly ocr = new OcrEngine();
  private readonly scoreThreshold: number;
  private readonly prefer?: Backend;

  constructor(
    options: { enabled?: boolean; ocr?: boolean; scoreThreshold?: number; backend?: Backend } = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.ocrEnabled = options.ocr ?? true;
    this.scoreThreshold = options.scoreThreshold ?? 0.6;
    this.prefer = options.backend;
  }

  /** Mirrors the runtime override, so `eval/` can run this outside the extension. */
  setAssetBase(base: string): void {
    this.ocr.setAssetBase(base);
  }

  get info(): SessionInfo | null {
    return this.sessionInfo;
  }

  /**
   * Load the model once and reuse it. The side panel lives only while it is open,
   * so the session is created lazily on first use and released in `dispose()`.
   */
  async warmUp(): Promise<SessionInfo> {
    if (this.sessionInfo && this.session) return this.sessionInfo;
    if (!this.loading) {
      this.loading = (async () => {
        const { session, info } = await createSession(YUNET_PATH, this.prefer);
        this.session = session;
        this.sessionInfo = info;
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    if (!this.sessionInfo) throw new Error('Vision model failed to load');
    return this.sessionInfo;
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.sessionInfo = null;
    await this.ocr.dispose();
    this.change.reset();
    this.cache = [];
  }

  /**
   * Detect on one frame.
   *
   * `image` is the raw capture in device pixels. Every rect returned is in CSS
   * pixels, so it can be fused with the DOM layer's boxes without conversion.
   */
  async detect(
    image: CanvasImageSource,
    imageWidth: number,
    imageHeight: number,
    snapshot: DomSnapshot,
    vault: Vault,
  ): Promise<VisionResult> {
    if (!this.enabled) {
      return {
        detections: [],
        stats: {
          session: this.sessionInfo,
          inferenceMs: 0,
          facesFound: 0,
          imageRegions: 0,
          skipped: true,
          skipReason: 'vision layer disabled',
        },
      };
    }

    // The DOM-derived image regions are free, so they run even when the model is
    // skipped for an unchanged screen.
    const regions = this.detectionsFromImageHints(snapshot.imageCandidates, vault);

    // Skip the model when the screen has not moved. Scroll position and URL are
    // part of the key, so a scroll always re-runs it even if the pixels are similar.
    const key = `${snapshot.url}@${Math.round(snapshot.scroll.y)}`;
    const change = this.change.check(image, key);
    if (!change.changed) {
      return {
        detections: [...this.cache, ...regions],
        stats: {
          session: this.sessionInfo,
          inferenceMs: 0,
          facesFound: this.cache.length,
          imageRegions: regions.length,
          skipped: true,
          skipReason: 'screen unchanged',
          changeDiff: change.diff,
        },
      };
    }

    await this.warmUp();
    if (!this.session) throw new Error('Vision model failed to load');

    const started = performance.now();
    const dpr = snapshot.dpr;

    // Pass 1: the whole screen. Catches every face big enough to survive being
    // letterboxed down to 640×640.
    const faces = await this.runOn(image, { x: 0, y: 0, w: imageWidth, h: imageHeight }, dpr);

    // Pass 2: close-ups of small images the first pass found nothing in.
    //
    // Measured: on a 1280×900 screen the whole-frame pass finds a real photographic
    // face in a 200 px image but misses it at 96 px — and 96 px is what a profile
    // avatar actually is. The frame is scaled by 0.5 before the model sees it, so a
    // small face has almost no pixels left. Re-running on the crop *upscales* it
    // instead. Bounded to a handful of candidates so this cannot run away.
    let cropPasses = 0;
    for (const candidate of this.smallUncoveredImages(snapshot.imageCandidates, faces, dpr)) {
      if (cropPasses >= MAX_CROP_PASSES) break;
      cropPasses++;

      const region = {
        x: Math.max(0, Math.round(candidate.bbox.x * dpr)),
        y: Math.max(0, Math.round(candidate.bbox.y * dpr)),
        w: Math.min(imageWidth, Math.round(candidate.bbox.w * dpr)),
        h: Math.min(imageHeight, Math.round(candidate.bbox.h * dpr)),
      };
      if (region.w < 8 || region.h < 8) continue;
      faces.push(...(await this.runOn(image, region, dpr)));
    }

    const merged = nonMaxSuppression(faces, 0.3);
    const inferenceMs = Math.round((performance.now() - started) * 10) / 10;

    this.cache = merged.map((face, i) => ({
      id: `vision:face:${i}`,
      type: 'FACE' as const,
      bbox: face.rect,
      confidence: Math.round(face.score * 1000) / 1000,
      source: 'vision' as const,
      token: vault.mintToken('FACE'),
      detail: 'yunet',
    }));

    // Pass 3: read text out of image regions. This is the only thing that finds PII
    // in an image the page never labelled.
    const ocr = await this.readImageText(image, snapshot, vault, imageWidth, imageHeight);
    this.cache.push(...ocr.detections);

    return {
      detections: [...this.cache, ...regions],
      stats: {
        session: this.sessionInfo,
        inferenceMs,
        facesFound: merged.length,
        imageRegions: regions.length,
        cropPasses,
        ...ocr.stats,
        skipped: false,
        changeDiff: change.diff,
      },
    };
  }

  /**
   * OCR the most promising image regions and keep only what the validators call PII.
   *
   * A failure here degrades the frame, it does not fail it: OCR is the most fragile
   * layer in the stack (8 MB of WASM, a worker, a language pack) and the DOM layer
   * has already done the bulk of the work by this point.
   */
  private async readImageText(
    image: CanvasImageSource,
    snapshot: DomSnapshot,
    vault: Vault,
    imageWidth: number,
    imageHeight: number,
  ): Promise<{ detections: Detection[]; stats: Partial<VisionStats> }> {
    if (!this.ocrEnabled) return { detections: [], stats: {} };

    const dpr = snapshot.dpr;
    const targets = snapshot.imageCandidates
      .filter((c) => c.bbox.w >= MIN_OCR_WIDTH && c.bbox.h >= MIN_OCR_HEIGHT)
      // Document-like regions first — that is where the numbers live.
      .sort((a, b) => {
        const aDoc = a.hint === 'document-like' ? 1 : 0;
        const bDoc = b.hint === 'document-like' ? 1 : 0;
        return bDoc - aDoc || b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h;
      })
      .slice(0, MAX_OCR_REGIONS);

    if (targets.length === 0) return { detections: [], stats: {} };

    const started = performance.now();
    const detections: Detection[] = [];
    let charsRead = 0;
    let ocrLoadMs: number | undefined;

    try {
      const info = await this.ocr.warmUp();
      ocrLoadMs = info.loadMs;

      for (const [i, target] of targets.entries()) {
        const region = {
          x: Math.max(0, Math.round(target.bbox.x * dpr)),
          y: Math.max(0, Math.round(target.bbox.y * dpr)),
          w: Math.min(imageWidth, Math.round(target.bbox.w * dpr)),
          h: Math.min(imageHeight, Math.round(target.bbox.h * dpr)),
        };
        if (region.w < 8 || region.h < 8) continue;

        const result = await this.ocr.readRegion(image, region, dpr);
        charsRead += result.charsRead;

        for (const [j, finding] of result.findings.entries()) {
          detections.push({
            id: `ocr:${i}:${j}`,
            type: finding.type,
            bbox: finding.bbox,
            confidence: Math.round(finding.confidence * 1000) / 1000,
            source: 'ocr',
            // Into the vault, so a number read off a card image gets the *same*
            // token as the same number typed into a form field — and so the egress
            // guard will catch it if it ever leaks.
            token: vault.tokenize(finding.type, finding.value),
            value: finding.value,
            detail: 'tesseract',
          });
        }
      }
    } catch (error) {
      // Type only, never the text (CLAUDE.md).
      console.warn('OCR unavailable this frame:', error instanceof Error ? error.name : 'error');
      return { detections, stats: { ocrRegions: targets.length, ocrMs: 0 } };
    }

    return {
      detections,
      stats: {
        ocrRegions: targets.length,
        ocrMs: Math.round((performance.now() - started) * 10) / 10,
        ocrCharsRead: charsRead,
        ocrFindings: detections.length,
        ocrLoadMs,
        ocrCacheHits: this.ocr.savedReads,
      },
    };
  }

  /** One model pass over a region of the capture. Returns CSS-pixel rects. */
  private async runOn(
    image: CanvasImageSource,
    region: { x: number; y: number; w: number; h: number },
    dpr: number,
  ): Promise<FaceBox[]> {
    const { data, scale } = letterbox(image, region);
    const outputs = await this.session!.run({
      input: tensorFrom(data, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]),
    });
    return decodeFaces(outputs as never, {
      letterboxScale: scale,
      offsetX: region.x,
      offsetY: region.y,
      dpr,
      scoreThreshold: this.scoreThreshold,
    });
  }

  /**
   * Image regions small enough that the whole-frame pass probably could not see
   * into them, and which no face has been found in yet.
   */
  private smallUncoveredImages(
    candidates: ImageCandidate[],
    faces: FaceBox[],
    dpr: number,
  ): ImageCandidate[] {
    return candidates
      .filter((c) => c.kind === 'img' || c.kind === 'canvas')
      .filter((c) => Math.max(c.bbox.w, c.bbox.h) * dpr <= SMALL_IMAGE_PX)
      .filter((c) => !faces.some((f) => overlaps(f.rect, c.bbox)))
      // Biggest first: a 96 px avatar is a better bet than a 32 px icon.
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  }

  /**
   * Images the DOM itself flags as personal. Costs nothing, and it is the only
   * thing that catches an illustrated avatar or an ID scan whose face is not
   * visible — cases a face detector is right to miss.
   */
  private detectionsFromImageHints(candidates: ImageCandidate[], vault: Vault): Detection[] {
    const out: Detection[] = [];

    for (const candidate of candidates) {
      if (!candidate.hint) continue;
      const type = HINT_TYPES[candidate.hint];
      if (!type) continue;

      out.push({
        id: `image:${candidate.elementId}`,
        type,
        bbox: candidate.bbox,
        // Lower than a model hit: a filename is evidence, not proof.
        confidence: 0.75,
        source: 'dom-image',
        token: vault.mintToken(type),
        detail: candidate.hint,
      });
    }

    return out;
  }
}

export type { SessionInfo } from './runtime';
