/**
 * The sanitizer pipeline: everything between "we have a screenshot" and "this is
 * safe to send".
 *
 * Order matters and is fixed:
 *   detect → tokenize → fuse → redact pixels → sanitize strings → egress guard
 *
 * Tokenizing before fusing means two boxes over the same value share one token.
 * Redacting before drawing Set-of-Mark numbers means a badge can never be painted
 * over. The egress guard runs dead last, on the finished payload object, because
 * that is the only thing that is actually about to be serialized.
 *
 * Lives in the side panel: it needs a canvas, and later WebGPU (docs/DECISIONS.md).
 */

import type {
  Detection,
  DisclosureLevel,
  DomSnapshot,
  HistoryEntry,
  PageElement,
  StepRequest,
  WireElement,
  WireRedaction,
} from './protocol';
import { Stopwatch } from './metrics';
import { guardPayload, type EgressReport } from './pii/egress';
import { clampLabel, sanitizeText, sanitizeUrl } from './pii/sanitize';
import type { Vault } from './pii/vault';
import { fuseDetections, redactedAreaRatio } from './redact/fuse';
import type { VisionStats } from './vision';
import type { VisionElement } from './vision/ui-detector';
import { dataUrlToBase64, drawSetOfMarks, renderRedacted, toJpegDataUrl } from './redact/render';

/**
 * Above this fraction of the screen covered by redactions, an image tells the
 * server almost nothing but still carries risk, so we drop to structure-only.
 */
const STRUCTURE_ONLY_AREA_RATIO = 0.4;

/** Origins where we never send pixels, however little was redacted. */
const HIGH_SENSITIVITY_HOST = /(bank|banking|netbanking|upi|paytm|phonepe|kyc|aadhaar|uidai|incometax|nsdl|passport|gov\.in|nic\.in)/i;

export interface PipelineInput {
  snapshot: DomSnapshot;
  /** Decoded screenshot, in device pixels. */
  image: CanvasImageSource;
  imageWidth: number;
  imageHeight: number;
  vault: Vault;
  sessionId: string;
  task: string;
  step: number;
  history: HistoryEntry[];
  /** Detections contributed by the vision layer (M4+). Already in CSS pixels. */
  visionDetections?: Detection[];
  /**
   * Interactive elements the custom detector found in pixels. These get ids above
   * `VISION_ID_BASE` and no DOM counterpart, so the agent acts on them by
   * coordinate. Without them a canvas app is readable but not operable.
   */
  visionElements?: VisionElement[];
  /** Force a disclosure level instead of deciding one. */
  forceDisclosure?: DisclosureLevel;
}

export interface PipelineOutput {
  detections: Detection[];
  redactedCanvas: HTMLCanvasElement;
  redactedDataUrl: string;
  /**
   * The unredacted capture, for the side panel's original ↔ sanitized toggle.
   * Stays in the panel: it is never part of `request`, and never serialized.
   */
  originalDataUrl?: string;
  request: StepRequest;
  egress: EgressReport;
  disclosureLevel: DisclosureLevel;
  areaRatio: number;
  /**
   * CSS pixels → sent-image pixels. Any coordinate the server returns is in image
   * space, so divide by this before handing it to the page.
   */
  imageScale: number;
  /**
   * Viewport size in CSS pixels. The side panel needs it to place detection
   * outlines over the preview as percentages — the preview is scaled to the
   * panel's width, so any absolute unit would be wrong.
   */
  viewport: { w: number; h: number };
  /** Set by the agent when the vision layer ran. Reported in the metrics panel. */
  visionStats?: VisionStats;
  timings: ReturnType<Stopwatch['finish']>;
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const { snapshot, vault } = input;
  const watch = new Stopwatch();

  /* 1. Detect ------------------------------------------------------- */
  watch.start('detect');
  const raw: Detection[] = [
    ...detectionsFromFields(snapshot.elements, vault),
    ...detectionsFromText(snapshot, vault),
    ...(input.visionDetections ?? []),
  ];
  watch.end('detect');

  /* 2. Fuse --------------------------------------------------------- */
  watch.start('fuse');
  const detections = fuseDetections(raw, { pad: 3, bounds: snapshot.viewport });
  const areaRatio = redactedAreaRatio(detections, snapshot.viewport);
  watch.end('fuse');

  /* 3. Disclosure level -------------------------------------------- */
  const disclosureLevel =
    input.forceDisclosure ??
    decideDisclosure(snapshot.url, areaRatio);

  /* 4. Redact pixels ------------------------------------------------ */
  watch.start('redact');
  const rendered = renderRedacted(input.image, input.imageWidth, input.imageHeight, detections, {
    dpr: snapshot.dpr,
  });
  // Set-of-Mark last, so a badge is never covered by a redaction box. Uses the
  // renderer's effective scale, which accounts for any downscale it applied.
  // Vision-found elements are numbered too, or the VLM could see a control on the
  // screenshot with no id to refer to it by.
  drawSetOfMarks(
    rendered.canvas,
    [
      ...snapshot.elements.map((e) => ({ id: e.id, bbox: e.bbox })),
      ...(input.visionElements ?? []).map((e) => ({ id: e.id, bbox: e.bbox })),
    ],
    { dpr: rendered.scale },
  );
  const redactedDataUrl = toJpegDataUrl(rendered.canvas);
  watch.end('redact');

  /* 5. Sanitize strings -------------------------------------------- */
  watch.start('tokenize');
  const elements = [
    ...snapshot.elements.map((el) => toWireElement(el, vault)),
    ...(input.visionElements ?? []).map(toWireVisionElement),
  ];
  const page = { ...sanitizeUrl(snapshot.url), title: sanitizeText(snapshot.title, vault).text };
  const redactions: WireRedaction[] = detections.map((d) => ({
    token: d.token,
    type: d.type,
    bbox: [round(d.bbox.x), round(d.bbox.y), round(d.bbox.w), round(d.bbox.h)],
    source: d.source,
  }));
  watch.end('tokenize');

  const request: StepRequest = {
    session_id: input.sessionId,
    task: sanitizeText(input.task, vault).text,
    step: input.step,
    disclosure_level: disclosureLevel,
    page,
    elements,
    redactions,
    profile_keys: vault.profileKeys(),
    history: input.history,
  };

  if (disclosureLevel === 2) {
    request.screen = {
      // The rendered canvas, not the source capture: the renderer may have
      // downscaled, and the server needs the dimensions of the image it receives
      // to map any pixel coordinate it returns back onto the page.
      image_jpeg_b64: dataUrlToBase64(redactedDataUrl),
      width: rendered.canvas.width,
      height: rendered.canvas.height,
    };
  }

  /* 6. Egress guard ------------------------------------------------- */
  watch.start('egress');
  const egress = guardPayload(request, { secrets: vault.secrets() });
  watch.end('egress');

  return {
    detections,
    redactedCanvas: rendered.canvas,
    redactedDataUrl,
    request,
    egress,
    disclosureLevel,
    areaRatio,
    imageScale: rendered.scale,
    viewport: snapshot.viewport,
    timings: watch.finish(),
  };
}

/* ------------------------------------------------------------------ *
 * Detection sources
 * ------------------------------------------------------------------ */

/**
 * A form field the DOM layer flagged. Only redacted when it actually holds
 * something: an empty "Aadhaar number" box has nothing to leak, and blacking it
 * out would hide from the VLM the very field it is supposed to fill.
 */
export function detectionsFromFields(elements: PageElement[], vault: Vault): Detection[] {
  const out: Detection[] = [];

  for (const el of elements) {
    if (!el.sensitive) continue;
    const value = el.value ?? '';
    if (!value) continue;
    // The password value never left the page, so there is nothing to tokenize.
    const isPassword = el.sensitive === 'PASSWORD';

    out.push({
      id: `field:${el.id}`,
      type: el.sensitive,
      bbox: el.bbox,
      confidence: 0.98,
      source: 'dom-field',
      token: isPassword ? '⟦PASSWORD⟧' : vault.tokenize(el.sensitive, value),
      detail: el.sensitiveReason,
      value: isPassword ? undefined : value,
    });
  }

  return out;
}

/** PII sitting in the page's own text. One detection per rendered line. */
export function detectionsFromText(snapshot: DomSnapshot, vault: Vault): Detection[] {
  const out: Detection[] = [];

  snapshot.textFindings.forEach((finding, i) => {
    const token = vault.tokenize(finding.type, finding.value);
    finding.rects.forEach((rect, j) => {
      out.push({
        id: `text:${i}:${j}`,
        type: finding.type,
        bbox: rect,
        confidence: finding.confidence,
        source: 'dom-text',
        token,
        value: finding.value,
      });
    });
  });

  return out;
}

/* ------------------------------------------------------------------ *
 * Wire conversion
 * ------------------------------------------------------------------ */

function toWireElement(el: PageElement, vault: Vault): WireElement {
  const context = [el.label, el.placeholder].filter(Boolean).join(' ');

  const wire: WireElement = {
    id: el.id,
    role: el.role,
    bbox: [round(el.bbox.x), round(el.bbox.y), round(el.bbox.w), round(el.bbox.h)],
  };

  const label = clampLabel(el.label);
  if (label) wire.label = sanitizeText(label, vault, context).text;

  const text = clampLabel(el.text);
  if (text) wire.text = sanitizeText(text, vault, context).text;

  const placeholder = clampLabel(el.placeholder, 60);
  if (placeholder) wire.placeholder = sanitizeText(placeholder, vault, context).text;

  if (el.type) wire.type = el.type;
  if (el.disabled) wire.disabled = true;
  if (el.required) wire.required = true;
  if (el.checked !== undefined) wire.checked = el.checked;
  if (el.options) wire.options = el.options.map((o) => sanitizeText(clampLabel(o, 60) ?? '', vault).text);
  if (el.sensitive) wire.sensitive = el.sensitive;

  const value = el.value ?? '';
  if (el.sensitive === 'PASSWORD') {
    // No value and no token: we never took the password out of the page.
    wire.filled = value.length > 0;
  } else if (el.sensitive && value) {
    wire.value = vault.tokenize(el.sensitive, value);
    wire.filled = true;
  } else if (value) {
    // Not a flagged field, but the value itself may still be PII — a user who
    // typed their email into a box labelled "Reference".
    wire.value = sanitizeText(value.slice(0, 200), vault, context).text;
    wire.filled = true;
  } else if (el.sensitive) {
    wire.filled = false;
  }

  return wire;
}

/**
 * A pixel-found control, as the VLM sees it.
 *
 * No label and no value: the detector reports geometry and a class, nothing more.
 * The `detail` field says where it came from so the model knows it is looking at a
 * best guess rather than a declared control.
 */
function toWireVisionElement(el: VisionElement): WireElement {
  return {
    id: el.id,
    role: el.role,
    bbox: [round(el.bbox.x), round(el.bbox.y), round(el.bbox.w), round(el.bbox.h)],
    label: 'detected on screen (no DOM element)',
  };
}

/* ------------------------------------------------------------------ *
 * Disclosure
 * ------------------------------------------------------------------ */

export function decideDisclosure(url: string, areaRatio: number): DisclosureLevel {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }

  if (HIGH_SENSITIVITY_HOST.test(host)) return 1;
  if (areaRatio > STRUCTURE_ONLY_AREA_RATIO) return 1;
  return 2;
}

function round(n: number): number {
  return Math.round(n);
}
