/**
 * Wire + internal types for PrivAgent.
 *
 * The `StepRequest` / `StepResponse` half of this file is mirrored in
 * `server/app/schemas.py`. If you change one, change the other.
 *
 * Convention: every `Rect` in this codebase is in **CSS pixels, viewport-relative**
 * (top-left origin). The captured screenshot is in **device pixels**. Multiply by
 * `DomSnapshot.dpr` at the exact moment you draw onto the screenshot canvas, and
 * nowhere else — mixing the two units is the single most common bug in this pipeline.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ *
 * PII taxonomy
 * ------------------------------------------------------------------ */

export const PII_TYPES = [
  'PASSWORD',
  'AADHAAR',
  'PAN',
  'CARD',
  'CVV',
  'PASSPORT',
  'IFSC',
  'UPI',
  'ACCOUNT',
  'EMAIL',
  'PHONE',
  'OTP',
  'DOB',
  'PINCODE',
  'ADDRESS',
  'NAME',
  'FACE',
  'ID_DOCUMENT',
  'QR_CODE',
  'SIGNATURE',
  /** Matched a sensitive-looking label but no specific type — redact, don't guess. */
  'GENERIC',
] as const;

export type PiiType = (typeof PII_TYPES)[number];

/**
 * Fusion priority. When two detections overlap we keep the higher number.
 * Credentials and government IDs outrank contact details, which outrank
 * weak context-dependent types, so a box is never downgraded on merge.
 */
export const PII_PRIORITY: Record<PiiType, number> = {
  PASSWORD: 100,
  AADHAAR: 95,
  PAN: 94,
  CARD: 93,
  CVV: 92,
  PASSPORT: 91,
  ID_DOCUMENT: 90,
  ACCOUNT: 85,
  IFSC: 80,
  UPI: 79,
  GENERIC: 75,
  EMAIL: 70,
  PHONE: 69,
  OTP: 68,
  DOB: 60,
  PINCODE: 55,
  ADDRESS: 50,
  NAME: 45,
  FACE: 40,
  QR_CODE: 35,
  SIGNATURE: 30,
};

export type RedactionStyle = 'block' | 'pixelate';

/**
 * Privacy rule (CLAUDE.md): text-like PII gets a *solid* fill, never a blur or
 * pixelation — blurred text is recoverable by deconvolution or by a
 * super-resolution model. Only faces are pixelated, because a solid black box
 * over every face destroys the layout context the VLM needs to reason about.
 */
export const REDACTION_STYLE: Record<PiiType, RedactionStyle> = {
  PASSWORD: 'block',
  AADHAAR: 'block',
  PAN: 'block',
  CARD: 'block',
  CVV: 'block',
  PASSPORT: 'block',
  ID_DOCUMENT: 'block',
  ACCOUNT: 'block',
  IFSC: 'block',
  UPI: 'block',
  GENERIC: 'block',
  EMAIL: 'block',
  PHONE: 'block',
  OTP: 'block',
  DOB: 'block',
  PINCODE: 'block',
  ADDRESS: 'block',
  NAME: 'block',
  QR_CODE: 'block',
  SIGNATURE: 'block',
  FACE: 'pixelate',
};

/**
 * Where a detection came from. Shown in the UI so the split between the cheap
 * deterministic layers and the model is visible rather than asserted.
 *
 * `dom-image` is a DOM signal *about* an image — its alt text, class or filename
 * says "avatar" or "aadhaar-scan". It cannot see the pixels, so it is not `vision`.
 */
export type DetectionSource = 'dom-field' | 'dom-text' | 'dom-image' | 'vision' | 'ocr';

/* ------------------------------------------------------------------ *
 * Page capture (internal — carries real values, never leaves the device)
 * ------------------------------------------------------------------ */

export interface PageElement {
  /** Stable within one snapshot; the content script keeps id -> Element. */
  id: number;
  /** Coarse ARIA-ish role the VLM can reason about. */
  role: string;
  tag: string;
  /** `type` attribute for inputs. */
  type?: string;
  /** Accessible name: <label>, aria-label, aria-labelledby, or placeholder. */
  label?: string;
  /** Visible text content, for buttons/links. */
  text?: string;
  placeholder?: string;
  /** Current value. Tokenized before it ever reaches a payload. */
  value?: string;
  autocomplete?: string;
  options?: string[];
  bbox: Rect;
  disabled?: boolean;
  required?: boolean;
  checked?: boolean;
  /** A radio button's group (its `name`). Page structure, not personal data. */
  group?: string;
  /** Set by the DOM heuristics layer when this field holds sensitive data. */
  sensitive?: PiiType;
  /** Why we called it sensitive — a rule name, never a value. */
  sensitiveReason?: string;
}

export interface TextFinding {
  type: PiiType;
  /** The matched string. Stays on-device; used for the vault and egress guard. */
  value: string;
  /** One rect per client rect — a match can wrap across lines. */
  rects: Rect[];
  confidence: number;
}

/**
 * One block of on-screen text, in reading order, with every PII span in it marked.
 * Internal: `text` and span values are raw. Only `lib/pii/visible-text.ts` turns it
 * into something sendable, and only at disclosure level 2.
 */
export interface VisibleTextBlock {
  text: string;
  /** Union of the block's rendered lines, CSS pixels, viewport-relative. */
  bbox: Rect;
  /**
   * Every match in the block, including ones whose pixels are just off screen — a
   * paragraph half in view is sent whole, so the half out of view must be tokenized too.
   */
  spans: Array<{ start: number; end: number; type: PiiType; value: string }>;
  /** The words around the block that context-dependent rules need ("OTP", "Date of birth"). */
  context: string;
}

/** An <img>/<canvas>/<video> the DOM can't read into: handed to the vision layer. */
export interface ImageCandidate {
  elementId: number;
  bbox: Rect;
  kind: 'img' | 'canvas' | 'video' | 'svg';
  /** Why we think it may hold PII, e.g. "class~=avatar". Never a URL with a query. */
  hint?: string;
}

export interface DomSnapshot {
  url: string;
  title: string;
  dpr: number;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
  /** Whether the page continues below the fold — so "nothing to fill here" can mean "scroll". */
  moreBelow?: boolean;
  elements: PageElement[];
  textFindings: TextFinding[];
  /** The screen's text, for answering questions about it. Sanitized before it goes anywhere. */
  visibleText?: VisibleTextBlock[];
  imageCandidates: ImageCandidate[];
  /**
   * Regions of the screen we were not allowed to look inside — cross-origin frames,
   * `<embed>`, `<object>`. Same-origin frames are *not* here: those are traversed
   * like any other scope (lib/dom/deep.ts).
   *
   * The pipeline paints over them. "We scanned it and found nothing" is a claim we
   * cannot make about a region we could not read, and a payment iframe is exactly
   * the kind of frame that carries a card number.
   */
  opaqueFrames: Rect[];
  /** ms spent inside the content script. */
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * Detections and redactions
 * ------------------------------------------------------------------ */

export interface Detection {
  id: string;
  type: PiiType;
  bbox: Rect;
  confidence: number;
  source: DetectionSource;
  /** Assigned by the tokenizer, e.g. `⟦EMAIL_1⟧`. */
  token: string;
  /** Rule or model that fired. Safe to display and to log — never a raw value. */
  detail?: string;
  /** Real value, when we have one. NEVER serialized into a payload. */
  value?: string;
}

/* ------------------------------------------------------------------ *
 * Wire protocol — everything below is what the server may see
 * ------------------------------------------------------------------ */

/**
 * L0 local-only: handled without the server.
 * L1 structure-only: element list + layout, no image (sensitive area too large,
 *    or a banking/ID page).
 * L2 sanitized image + structure: the default.
 */
export type DisclosureLevel = 0 | 1 | 2;

export interface WireElement {
  id: number;
  role: string;
  label?: string;
  text?: string;
  placeholder?: string;
  /** Tokenized: either a token, or a harmless literal that passed the sanitizer. */
  value?: string;
  type?: string;
  options?: string[];
  bbox: [number, number, number, number];
  disabled?: boolean;
  required?: boolean;
  checked?: boolean;
  /** A radio button's group, so a group can be asked about and answered as one. */
  group?: string;
  /** Present when the field is known to hold sensitive data. */
  sensitive?: PiiType;
  /**
   * Whether a sensitive field already has content. Lets the VLM decide "this is
   * done, move on" for a password field whose value never leaves the page at all
   * and therefore has no token.
   */
  filled?: boolean;
}

export interface WireRedaction {
  token: string;
  type: PiiType;
  bbox: [number, number, number, number];
  source: DetectionSource;
}

export interface HistoryEntry {
  action: string;
  /**
   * Origin + path of the page the step was taken on. Element ids are stable only
   * within a page, so "already typed into 3" must never be matched against the
   * field numbered 3 on the next page.
   */
  page?: string;
  element_id?: number;
  /** Tokenized. */
  text?: string;
  ok: boolean;
  error?: string;
}

export interface StepRequest {
  session_id: string;
  task: string;
  step: number;
  disclosure_level: DisclosureLevel;
  /** Origin + path only. Query strings and fragments are stripped (CLAUDE.md). */
  page: { origin: string; path: string; title: string; more_below?: boolean };
  /** Omitted at L0/L1. */
  screen?: { image_jpeg_b64: string; width: number; height: number };
  elements: WireElement[];
  redactions: WireRedaction[];
  /** Which profile keys exist — never their values. */
  profile_keys: string[];
  history: HistoryEntry[];
  /**
   * The screen's text in reading order, every detected value replaced by the same
   * token its box carries. L2 only: it is the text the redacted screenshot already
   * shows, so a small model can read it instead of squinting at pixels.
   */
  visible_text?: string;
}

export type ActionName =
  | 'click'
  | 'click_xy'
  | 'type'
  | 'select'
  | 'scroll'
  | 'key'
  | 'navigate'
  | 'wait'
  | 'ask_user'
  | 'done';

export interface StepResponse {
  action: ActionName;
  element_id?: number;
  x?: number;
  y?: number;
  text?: string;
  option?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  key?: string;
  url?: string;
  ms?: number;
  question?: string;
  summary?: string;
  reason?: string;
  confidence?: number;
  /**
   * The model that decided, when a model did (e.g. "qwen2.5vl:3b"). Shown in the
   * activity log beside `planner`, so a judge can see which weights chose each step.
   */
  model?: string;
  /**
   * Which path produced this action. Shown in the UI so a rule-based fallback is
   * never mistaken for the model reasoning.
   */
  planner?: 'vlm' | 'rule-based' | 'local';
  /** Server-side timing, for the full latency breakdown. */
  timings?: Record<string, number>;
}

/** Actions we refuse to run without an explicit click in the side panel. */
export const IRREVERSIBLE_HINTS = [
  'submit',
  'pay',
  'send',
  'delete',
  'remove',
  'confirm',
  'buy',
  'order',
  'transfer',
  'withdraw',
  'place order',
  'sign up',
  'register',
  'apply',
  'checkout',
];

/* ------------------------------------------------------------------ *
 * Timings
 * ------------------------------------------------------------------ */

export interface StageTimings {
  capture?: number;
  snapshot?: number;
  /** On-device model inference (vision layer). */
  vision?: number;
  detect?: number;
  fuse?: number;
  redact?: number;
  tokenize?: number;
  egress?: number;
  network?: number;
  server?: number;
  execute?: number;
  total?: number;
}
