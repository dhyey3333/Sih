/**
 * Scoring the privacy filter against a page's own ground truth.
 *
 * Any page whose sensitive elements carry `data-pii="TYPE"` can be scored: the
 * demo site, and every page the synthetic data engine generates. Because the
 * attribute is written once by the page author and read by both the trainer and
 * the scorer, the labels can never drift from what the model is trained on.
 *
 * Two numbers, and they answer different questions:
 *
 *   coverage  — was the region redacted at all? This is the one that matters for
 *               "did anything leak", and it is what the redaction-precision metric
 *               is built on.
 *   typed     — was it redacted *and* labelled with the right PII type? This is the
 *               harder number, and the one the redaction legend depends on.
 *
 * Detections whose type is only reachable by the vision layer (a face, an ID card
 * scan) are reported separately, so a DOM-only build reports an honest miss
 * instead of quietly excluding what it cannot see.
 */

import type { Detection, PiiType, Rect } from '../protocol';
import { buildSnapshot } from '../dom/snapshot';
import { detectionsFromFields, detectionsFromText } from '../pipeline';
import { Vault, type ProfileKey } from '../pii/vault';
import { containment, fuseDetections } from '../redact/fuse';

/** Types no DOM inspection can find; they need pixels. */
export const VISION_ONLY_TYPES: ReadonlySet<PiiType> = new Set([
  'FACE',
  'ID_DOCUMENT',
  'QR_CODE',
  'SIGNATURE',
]);

/** A detection counts as covering a ground-truth box at or above this containment. */
const MATCH_THRESHOLD = 0.5;

export interface GroundTruthItem {
  type: PiiType;
  bbox: Rect;
  /** Tag + name/id, for a readable miss list. Never a value. */
  describe: string;
}

export interface TypeScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface PageScore {
  url: string;
  viewport: { w: number; h: number };
  groundTruth: number;
  detections: number;
  /** Ground-truth items reachable without a vision model. */
  domReachable: TypeScore & { coverage: number | null };
  /** Ground-truth items that need the vision layer. Expected to miss before M4. */
  visionRequired: { total: number; matched: number };
  byType: Partial<Record<PiiType, TypeScore>>;
  missed: string[];
  falsePositives: Array<{ type: PiiType; bbox: Rect; source: string }>;
  timings: { snapshot: number; detect: number; fuse: number; total: number };
}

function describeElement(el: Element): string {
  const name = el.getAttribute('name') ?? el.id ?? '';
  return name ? `${el.tagName.toLowerCase()}[${name}]` : el.tagName.toLowerCase();
}

function collectGroundTruth(viewport: { w: number; h: number }): GroundTruthItem[] {
  const items: GroundTruthItem[] = [];

  for (const el of document.querySelectorAll('[data-pii]')) {
    const type = el.getAttribute('data-pii') as PiiType | null;
    if (!type) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Only score what is actually on screen — the screenshot cannot leak the rest.
    if (r.bottom <= 0 || r.right <= 0 || r.top >= viewport.h || r.left >= viewport.w) continue;

    items.push({
      type,
      bbox: { x: r.left, y: r.top, w: r.width, h: r.height },
      describe: `${describeElement(el)} → ${type}`,
    });
  }

  return items;
}

function emptyScore(): TypeScore {
  return { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null };
}

function finalize(score: TypeScore): TypeScore {
  const { tp, fp, fn } = score;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision: round(precision), recall: round(recall), f1: round(f1) };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

export interface ScoreOptions {
  /** Vision-layer detections to fold in, once that layer exists (M4). */
  extraDetections?: Detection[];
  /**
   * The user's profile, exactly as the side panel would hold it.
   *
   * This is not a thumb on the scale: names and free-text addresses are caught by
   * the vault, not by a pattern, so scoring with an empty profile measures a
   * configuration the product never actually runs in. Score both ways and report
   * both — with a profile is the real number, without it is the floor.
   */
  profile?: Partial<Record<ProfileKey, string>>;
}

/** Run the DOM half of the pipeline over the current page and score it. */
export function scorePage(options: ScoreOptions = {}): PageScore {
  const startedAt = performance.now();
  const { extraDetections = [], profile = {} } = options;

  const vault = new Vault();
  for (const [key, value] of Object.entries(profile)) {
    if (value) vault.setProfile(key as ProfileKey, value);
  }

  const snapshotStart = performance.now();
  const snapshot = buildSnapshot({ knownValues: vault.needles() });
  const snapshotMs = performance.now() - snapshotStart;

  const detectStart = performance.now();
  const raw = [
    ...detectionsFromFields(snapshot.elements, vault),
    ...detectionsFromText(snapshot, vault),
    ...extraDetections,
  ];
  const detectMs = performance.now() - detectStart;

  const fuseStart = performance.now();
  const detections = fuseDetections(raw, { pad: 3, bounds: snapshot.viewport });
  const fuseMs = performance.now() - fuseStart;

  const groundTruth = collectGroundTruth(snapshot.viewport);
  const byType: Partial<Record<PiiType, TypeScore>> = {};
  const missed: string[] = [];
  const matchedDetections = new Set<string>();

  let domTotal = 0;
  let domCovered = 0;
  let domTyped = 0;
  let visionTotal = 0;
  let visionMatched = 0;

  for (const item of groundTruth) {
    const overlapping = detections.filter((d) => containment(item.bbox, d.bbox) >= MATCH_THRESHOLD);
    const typeMatch = overlapping.find((d) => d.type === item.type);
    for (const d of overlapping) matchedDetections.add(d.id);

    if (VISION_ONLY_TYPES.has(item.type)) {
      visionTotal++;
      if (overlapping.length > 0) visionMatched++;
      continue;
    }

    domTotal++;
    const score = (byType[item.type] ??= emptyScore());

    if (typeMatch) {
      domCovered++;
      domTyped++;
      score.tp++;
    } else if (overlapping.length > 0) {
      // Covered by a box, but labelled as the wrong type: safe, but the legend lies.
      domCovered++;
      score.fn++;
      missed.push(`${item.describe} (covered as ${overlapping[0]!.type})`);
    } else {
      score.fn++;
      missed.push(item.describe);
    }
  }

  const falsePositives = detections
    .filter((d) => !matchedDetections.has(d.id))
    .map((d) => ({ type: d.type, bbox: d.bbox, source: d.detail ?? d.source }));

  for (const fp of falsePositives) {
    (byType[fp.type] ??= emptyScore()).fp++;
  }

  const domScore = finalize({
    tp: domTyped,
    fp: falsePositives.length,
    fn: domTotal - domTyped,
    precision: null,
    recall: null,
    f1: null,
  });

  return {
    url: location.href,
    viewport: snapshot.viewport,
    groundTruth: groundTruth.length,
    detections: detections.length,
    domReachable: {
      ...domScore,
      coverage: domTotal === 0 ? null : round(domCovered / domTotal),
    },
    visionRequired: { total: visionTotal, matched: visionMatched },
    byType: Object.fromEntries(
      Object.entries(byType).map(([type, score]) => [type, finalize(score)]),
    ) as Partial<Record<PiiType, TypeScore>>,
    missed,
    falsePositives,
    timings: {
      snapshot: Math.round(snapshotMs * 10) / 10,
      detect: Math.round(detectMs * 10) / 10,
      fuse: Math.round(fuseMs * 10) / 10,
      total: Math.round((performance.now() - startedAt) * 10) / 10,
    },
  };
}
