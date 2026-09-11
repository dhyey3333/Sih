/**
 * Side panel: the agent UI and the on-device model runtime.
 *
 * It owns the vault and runs the sanitizer pipeline, because this is the only
 * extension context with a DOM (canvas, for redaction) and WebGPU. The background
 * worker just moves bytes; the content script just touches the page.
 *
 * Two entry points:
 *   Analyze  — perceive and sanitize only. Nothing is sent. This alone is the whole
 *              privacy demonstration.
 *   Run task — the full agent loop, through the server.
 */

import { Agent, describeAction, type StepReport } from '../../lib/agent';
import { DEMO_PROFILE } from '../../lib/demo-profile';
import type { Detection, StageTimings, StepRequest } from '../../lib/protocol';
import type { PipelineOutput } from '../../lib/pipeline';
import { describeIncidents } from '../../lib/pii/egress';
import { PROFILE_KEYS, Vault, type ProfileKey } from '../../lib/pii/vault';
import { VisionLayer } from '../../lib/vision';

const vault = new Vault();

/**
 * One vision layer for the whole panel session. Compiling the ONNX graph costs
 * ~300 ms and the OCR worker ~900 ms, and the side panel only lives while it is
 * open, so both are created once here and released on `pagehide` (CLAUDE.md).
 */
const vision = new VisionLayer();

let agent: Agent | null = null;
let running = false;
let standaloneStep = 0;
let logCount = 0;

/** Session ledger. Every field is counted, never asserted. */
const ledger = { requests: 0, bytes: 0, local: 0 };

/** Resolver for the confirmation gate, set while the sheet is open. */
let pendingConfirm: ((approved: boolean) => void) | null = null;

/* ------------------------------------------------------------------ *
 * Element handles
 * ------------------------------------------------------------------ */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in the side panel markup`);
  return el as T;
};

const ui = {
  status: $('status'),
  statusText: $('status-text'),

  stage: $('stage'),
  stageEmpty: $('stage-empty'),
  stageReveal: $('stage-reveal'),
  stageDivider: $('stage-divider'),
  stageSlider: $<HTMLInputElement>('stage-slider'),
  stageBoxes: $('stage-boxes'),
  stageModes: $('stage-modes'),
  segmentedPill: $('segmented-pill'),
  badgeLeft: $('stage-badge-left'),
  badgeRight: $('stage-badge-right'),
  previewOriginal: $<HTMLImageElement>('preview-original'),
  previewSanitized: $<HTMLImageElement>('preview-sanitized'),

  task: $<HTMLInputElement>('task'),
  run: $<HTMLButtonElement>('run'),
  presets: $('presets'),
  analyze: $<HTMLButtonElement>('analyze'),
  clear: $<HTMLButtonElement>('clear'),
  error: $('error'),

  guard: $('guard'),
  guardTitle: $('guard-title'),
  guardDetail: $('guard-detail'),

  statDetections: $('stat-detections'),
  statArea: $('stat-area'),
  statLevel: $('stat-level'),
  metricLevel: $('metric-level'),
  statLatency: $('stat-latency'),
  statVault: $('stat-vault'),

  ledger: $('ledger'),
  statRequests: $('stat-requests'),
  statSent: $('stat-sent'),
  statLocal: $('stat-local'),

  panelDetections: $<HTMLDetailsElement>('panel-detections'),
  detections: $('detections'),
  detectionsCount: $('detections-count'),
  timings: $('timings'),
  timingsTotal: $('timings-total'),
  payload: $('payload'),

  visionToggle: $<HTMLInputElement>('vision-toggle'),
  ocrToggle: $<HTMLInputElement>('ocr-toggle'),
  visionStatus: $('vision-status'),

  profile: $('profile'),
  profileDemo: $<HTMLButtonElement>('profile-demo'),

  log: $('log'),
  logCount: $('log-count'),

  serverUrl: $<HTMLInputElement>('server-url'),
  checkServer: $<HTMLButtonElement>('check-server'),
  serverStatus: $('server-status'),

  confirm: $('confirm'),
  confirmScrim: $('confirm-scrim'),
  confirmQuestion: $('confirm-question'),
  confirmYes: $<HTMLButtonElement>('confirm-yes'),
  confirmNo: $<HTMLButtonElement>('confirm-no'),
};

/* ------------------------------------------------------------------ *
 * Status + logging
 * ------------------------------------------------------------------ */

type Status = 'idle' | 'busy' | 'ok' | 'err';

function setStatus(status: Status, text: string): void {
  ui.status.dataset.state = status;
  ui.statusText.textContent = text;
}

function log(message: string, kind: 'info' | 'err' = 'info'): void {
  const li = document.createElement('li');
  if (kind === 'err') li.className = 'err';

  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  li.append(time, document.createTextNode(message));

  ui.log.prepend(li);
  while (ui.log.children.length > 60) ui.log.lastElementChild?.remove();
  ui.logCount.textContent = String(++logCount);
}

function showError(message: string | null): void {
  ui.error.hidden = !message;
  if (message) ui.error.textContent = message;
}

/**
 * One control is both Run and Stop. Two buttons where only one is ever usable is
 * a row of dead pixels; a control that changes state is legible at a glance.
 */
function setRunning(active: boolean): void {
  running = active;
  ui.run.dataset.running = String(active);
  ui.run.title = active ? 'Stop' : 'Run task';
  ui.run.setAttribute('aria-label', active ? 'Stop the task' : 'Run task');
  ui.analyze.disabled = active;
  ui.stage.dataset.busy = String(active);
}

/* ------------------------------------------------------------------ *
 * Confirmation gate
 * ------------------------------------------------------------------ */

function askConfirmation(question: string): Promise<boolean> {
  ui.confirmQuestion.textContent = question;
  ui.confirm.hidden = false;
  setStatus('busy', 'Waiting for you');
  ui.confirmYes.focus();

  return new Promise((resolve) => {
    pendingConfirm = (approved) => {
      ui.confirm.hidden = true;
      pendingConfirm = null;
      resolve(approved);
    };
  });
}

ui.confirmYes.addEventListener('click', () => pendingConfirm?.(true));
ui.confirmNo.addEventListener('click', () => pendingConfirm?.(false));
ui.confirmScrim.addEventListener('click', () => pendingConfirm?.(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingConfirm) pendingConfirm(false);
});

/* ------------------------------------------------------------------ *
 * The comparison wipe
 * ------------------------------------------------------------------ */

/** 0 = show only what the server gets; 100 = show only your screen. */
function setReveal(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent));
  ui.stage.style.setProperty('--reveal', `${clamped}%`);
  ui.badgeLeft.style.opacity = clamped > 14 ? '1' : '0';
  ui.badgeRight.style.opacity = clamped < 86 ? '1' : '0';
}

ui.stageSlider.addEventListener('input', () => {
  setReveal(Number(ui.stageSlider.value));
  // Dragging past either edge is a deliberate choice of view; keep the
  // segmented control honest about which one is showing.
  const value = Number(ui.stageSlider.value);
  setMode(value >= 99 ? 'original' : value <= 1 ? 'sent' : 'compare', false);
});

type Mode = 'original' | 'compare' | 'sent';
const MODE_REVEAL: Record<Mode, number> = { original: 100, compare: 55, sent: 0 };
const MODE_ORDER: Mode[] = ['original', 'compare', 'sent'];

function setMode(mode: Mode, move = true): void {
  ui.segmentedPill.style.translate = `${MODE_ORDER.indexOf(mode) * 100}% 0`;
  for (const button of ui.stageModes.querySelectorAll<HTMLButtonElement>('button')) {
    const on = button.dataset.mode === mode;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  if (move) {
    ui.stageSlider.value = String(MODE_REVEAL[mode]);
    setReveal(MODE_REVEAL[mode]);
  }
}

ui.stageModes.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-mode]');
  if (button) setMode(button.dataset.mode as Mode);
});

function showPreview(originalUrl: string, sanitizedUrl: string): void {
  ui.stageEmpty.hidden = true;
  ui.previewOriginal.src = originalUrl || sanitizedUrl;
  ui.previewSanitized.src = sanitizedUrl;
  for (const el of [
    ui.previewOriginal,
    ui.stageReveal,
    ui.stageDivider,
    ui.stageSlider,
    ui.stageModes,
    ui.badgeLeft,
    ui.badgeRight,
  ]) {
    el.hidden = false;
  }
  setReveal(Number(ui.stageSlider.value));
}

function clearPreview(): void {
  for (const el of [
    ui.previewOriginal,
    ui.stageReveal,
    ui.stageDivider,
    ui.stageSlider,
    ui.stageModes,
    ui.badgeLeft,
    ui.badgeRight,
  ]) {
    el.hidden = true;
  }
  ui.stageEmpty.hidden = false;
  ui.previewOriginal.removeAttribute('src');
  ui.previewSanitized.removeAttribute('src');
  ui.stageBoxes.replaceChildren();
}

/**
 * Outline every redaction on the sanitized half. The boxes are positioned as a
 * percentage of the viewport rather than in pixels: the preview is scaled to
 * whatever width the panel happens to have, so pixels would be wrong at every
 * size but one.
 */
function renderBoxes(output: PipelineOutput): void {
  ui.stageBoxes.replaceChildren();
  const { w, h } = output.viewport;
  if (!w || !h) return;

  output.detections.forEach((d, index) => {
    const box = document.createElement('div');
    box.className = 'stage__box';
    box.dataset.det = d.id;
    if (d.type === 'FACE') box.dataset.kind = 'face';
    box.style.left = `${(d.bbox.x / w) * 100}%`;
    box.style.top = `${(d.bbox.y / h) * 100}%`;
    box.style.width = `${(d.bbox.w / w) * 100}%`;
    box.style.height = `${(d.bbox.h / h) * 100}%`;
    // Stagger, capped: 30 detections should not take three seconds to appear.
    box.style.animationDelay = `${Math.min(index * 28, 600)}ms`;
    ui.stageBoxes.append(box);
  });
}

function lightBox(id: string | null): void {
  for (const box of ui.stageBoxes.querySelectorAll<HTMLElement>('.stage__box')) {
    box.classList.toggle('is-lit', box.dataset.det === id);
  }
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

const PROFILE_STORAGE_KEY = 'privagent.profile';
const SERVER_STORAGE_KEY = 'privagent.serverUrl';

function buildProfileForm(): void {
  ui.profile.replaceChildren();
  for (const key of PROFILE_KEYS) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = key.replace(/_/g, ' ').toLowerCase();

    const input = document.createElement('input');
    input.type = 'text';
    input.value = vault.getProfile(key) ?? '';
    input.autocomplete = 'off';
    input.addEventListener('change', () => {
      vault.setProfile(key, input.value);
      void persistProfile();
      updateVaultStat();
    });

    label.append(span, input);
    ui.profile.append(label);
  }
}

/**
 * `storage.session` lives in memory and is wiped when the browser closes.
 * `storage.local` would write PII to disk in plaintext; encrypted persistence is a
 * later piece of work, and until then not writing it at all is the safer default.
 */
async function persistProfile(): Promise<void> {
  try {
    await browser.storage?.session?.set({
      [PROFILE_STORAGE_KEY]: Object.fromEntries(vault.profileEntries()),
    });
  } catch {
    /* unavailable: the profile simply stays in memory */
  }
}

async function restoreProfile(): Promise<void> {
  try {
    const stored = await browser.storage?.session?.get(PROFILE_STORAGE_KEY);
    const profile = stored?.[PROFILE_STORAGE_KEY] as Record<string, string> | undefined;
    if (!profile) return;
    for (const key of PROFILE_KEYS) {
      if (profile[key]) vault.setProfile(key, profile[key]!);
    }
  } catch {
    /* nothing stored */
  }
}

/** The server URL is not PII, so ordinary local storage is fine for it. */
async function restoreServerUrl(): Promise<void> {
  try {
    const stored = await browser.storage?.local?.get(SERVER_STORAGE_KEY);
    const url = stored?.[SERVER_STORAGE_KEY] as string | undefined;
    if (url) ui.serverUrl.value = url;
  } catch {
    /* keep the default */
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const CREDENTIAL_TYPES = new Set(['PASSWORD', 'CARD', 'CVV', 'AADHAAR', 'PAN', 'PASSPORT', 'ACCOUNT']);

function renderDetections(detections: Detection[]): void {
  ui.detectionsCount.textContent = String(detections.length);
  ui.detections.replaceChildren();

  if (detections.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sensitive content found on this screen.';
    ui.detections.append(li);
    return;
  }

  for (const d of detections) {
    const li = document.createElement('li');
    li.dataset.det = d.id;

    const type = document.createElement('span');
    type.className =
      d.type === 'FACE' ? 'type type--face' : CREDENTIAL_TYPES.has(d.type) ? 'type type--cred' : 'type';
    type.textContent = d.type;

    const token = document.createElement('span');
    token.className = 'token';
    token.textContent = d.token;

    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = `${d.source} · ${Math.round(d.confidence * 100)}%`;

    // Pointing at a row points at the pixels. This is the fastest way for a
    // sceptic to check that a given box covers the thing it claims to.
    li.addEventListener('pointerenter', () => lightBox(d.id));
    li.addEventListener('pointerleave', () => lightBox(null));

    li.append(type, token, src);
    ui.detections.append(li);
  }
}

const TIMING_LABELS: Partial<Record<keyof StageTimings, string>> = {
  capture: 'capture',
  snapshot: 'DOM snapshot',
  vision: 'vision models',
  detect: 'detect PII',
  fuse: 'fuse boxes',
  redact: 'redact pixels',
  tokenize: 'tokenize',
  egress: 'egress guard',
  network: 'network',
  server: 'server',
  execute: 'execute',
};

function renderTimings(timings: StageTimings): void {
  const entries = Object.entries(timings).filter(
    ([key, ms]) => key !== 'total' && typeof ms === 'number' && ms > 0,
  ) as Array<[keyof StageTimings, number]>;

  ui.timings.replaceChildren();
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing measured yet.';
    ui.timings.append(li);
    ui.timingsTotal.textContent = '—';
    return;
  }

  const max = Math.max(...entries.map(([, ms]) => ms), 1);
  for (const [stage, ms] of entries) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = TIMING_LABELS[stage] ?? stage;

    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(3, (ms / max) * 100)}%`;
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'ms';
    value.textContent = `${ms} ms`;

    li.append(name, track, value);
    ui.timings.append(li);
  }

  const wall = entries.reduce((sum, [, ms]) => sum + ms, 0);
  ui.timingsTotal.textContent = `${Math.round(wall)} ms`;
  countTo(ui.statLatency, Math.round(wall));
}

/** The payload, with the screenshot summarised rather than inlined. */
function renderPayload(request: StepRequest): void {
  const preview: Record<string, unknown> = { ...request };
  if (request.screen) {
    const kb = Math.round((request.screen.image_jpeg_b64.length * 0.75) / 1024);
    preview.screen = {
      image_jpeg_b64: `<redacted screenshot, ${kb} KB, ${request.screen.width}×${request.screen.height}>`,
      width: request.screen.width,
      height: request.screen.height,
    };
  }
  ui.payload.textContent = JSON.stringify(preview, null, 2);
}

function renderGuard(output: PipelineOutput): void {
  const { egress } = output;
  if (egress.ok) {
    ui.guard.dataset.state = 'pass';
    ui.guardTitle.textContent = 'Egress guard passed';
    ui.guardDetail.textContent =
      `${egress.stringsScanned} strings re-scanned in ${egress.durationMs.toFixed(1)} ms · no PII`;
  } else {
    ui.guard.dataset.state = 'block';
    ui.guardTitle.textContent = 'Blocked — nothing was sent';
    ui.guardDetail.textContent = describeIncidents(egress.incidents);
  }
}

/**
 * The resource story, in the UI rather than on a slide: which backend the model got,
 * how big it is, how long this frame took, and when a frame was skipped entirely.
 */
function renderVisionStatus(output: PipelineOutput): void {
  const stats = output.visionStats;
  if (!stats) return;

  if (stats.skipped && stats.skipReason === 'vision layer disabled') {
    ui.visionStatus.textContent = 'Off — DOM and text layers only.';
    return;
  }

  const parts: string[] = [];
  if (stats.session) {
    parts.push(
      `${stats.session.backend.toUpperCase()} · ${Math.round(stats.session.modelBytes / 1024)} KB · ` +
        `${stats.session.loadMs} ms load`,
    );
  }
  parts.push(
    stats.skipped
      ? `frame skipped (${stats.skipReason})`
      : `${stats.inferenceMs} ms · ${stats.facesFound} face(s)`,
  );
  if (stats.cropPasses) parts.push(`${stats.cropPasses} close-up pass(es)`);
  if (stats.detectorAvailable === false) parts.push('custom detector not bundled');
  else if (stats.detectorMs !== undefined) parts.push(`detector ${stats.detectorMs} ms`);
  if (stats.ocrRegions) {
    const cached = stats.ocrCacheHits ? `, ${stats.ocrCacheHits} cached` : '';
    parts.push(`OCR ${stats.ocrRegions} region(s) ${stats.ocrMs} ms${cached}`);
  }
  if (stats.session?.webgpuError) parts.push(stats.session.webgpuError);

  ui.visionStatus.textContent = parts.join(' · ');
}

function updateVaultStat(): void {
  ui.statVault.textContent = String(vault.size);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderLedger(): void {
  ui.statRequests.textContent = String(ledger.requests);
  ui.statSent.textContent = formatBytes(ledger.bytes);
  ui.statLocal.textContent = String(ledger.local);
  ui.ledger.dataset.sent = String(ledger.bytes > 0);
}

/**
 * Animate a metric to its new value. Short, eased, and skipped entirely under
 * `prefers-reduced-motion` — the point is that the number *moved*, not the show.
 */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const counters = new WeakMap<HTMLElement, number>();

function countTo(el: HTMLElement, target: number, suffix = ''): void {
  const from = counters.get(el) ?? 0;
  counters.set(el, target);

  if (reduceMotion.matches || from === target) {
    el.textContent = `${target}${suffix}`;
    return;
  }

  const start = performance.now();
  const duration = 420;
  const tick = (now: number): void => {
    // Only this element's most recent target may keep writing to it.
    if (counters.get(el) !== target) return;
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(from + (target - from) * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const DISCLOSURE_NOTE: Record<number, string> = {
  0: 'Handled locally — no request was made.',
  1: 'Structure only — no screenshot was sent.',
  2: 'Sanitized screenshot + structure.',
};

function renderOutput(output: PipelineOutput): void {
  countTo(ui.statDetections, output.detections.length);
  countTo(ui.statArea, Math.round(output.areaRatio * 100), '%');
  ui.statLevel.textContent = `L${output.disclosureLevel}`;
  ui.metricLevel.dataset.level = String(output.disclosureLevel);
  ui.metricLevel.title = DISCLOSURE_NOTE[output.disclosureLevel] ?? '';
  updateVaultStat();

  renderDetections(output.detections);
  renderTimings(output.timings);
  renderPayload(output.request);
  renderGuard(output);
  renderVisionStatus(output);

  showPreview(output.originalDataUrl ?? '', output.redactedDataUrl);
  renderBoxes(output);
  if (output.detections.length > 0) ui.panelDetections.open = true;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function makeAgent(): Agent {
  return new Agent(
    vault,
    {
      serverUrl: ui.serverUrl.value.trim(),
      maxSteps: 12,
      vision: ui.visionToggle.checked,
      ocr: ui.ocrToggle.checked,
    },
    vision,
  );
}

/** Perceive and sanitize only. Nothing is sent anywhere. */
async function analyze(): Promise<void> {
  setRunning(true);
  showError(null);
  setStatus('busy', 'Reading page');

  try {
    const output = await makeAgent().perceiveOnly(
      ui.task.value.trim() || 'Describe this page',
      standaloneStep++,
    );
    renderOutput(output);

    if (output.egress.ok) {
      setStatus('ok', 'Safe to send');
      log(
        `${output.detections.length} redactions · ${Math.round(output.areaRatio * 100)}% of screen · ` +
          `L${output.disclosureLevel} · ${output.timings.total} ms`,
      );
    } else {
      setStatus('err', 'Blocked');
      log(`Egress guard blocked the payload: ${describeIncidents(output.egress.incidents)}`, 'err');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus('err', 'Failed');
    showError(message);
    log(message, 'err');
  } finally {
    setRunning(false);
  }
}

/** The full agent loop. */
async function run(): Promise<void> {
  const task = ui.task.value.trim();
  if (!task) {
    showError('Type a task first — or pick one of the suggestions.');
    ui.task.focus();
    return;
  }

  setRunning(true);
  showError(null);
  agent = makeAgent();
  log(`Task: ${task}`);

  await agent.run(task, {
    onStatus: (status, text) => setStatus(status, capitalise(text)),
    onLog: log,
    onPerceived: renderOutput,
    onStep: (report: StepReport) => {
      renderTimings(report.output.timings);
      countLedger(report);
      if (report.result?.ok) log(`✓ ${describeAction(report.response)}`);
      if (report.response.planner) {
        ui.visionStatus.title =
          report.response.planner === 'vlm'
            ? 'Decided by the server-side VLM'
            : 'Decided by the server’s deterministic planner';
      }
    },
    confirm: askConfirmation,
  });

  setRunning(false);
  agent = null;
}

/**
 * The ledger counts what actually happened on the wire. An L0 step never made a
 * request, so it adds to "handled on-device" and to nothing else.
 */
function countLedger(report: StepReport): void {
  if (report.response.planner === 'local') {
    ledger.local += 1;
  } else {
    ledger.requests += 1;
    ledger.bytes += new Blob([JSON.stringify(report.output.request)]).size;
  }
  renderLedger();
}

async function checkServer(): Promise<void> {
  const url = ui.serverUrl.value.trim().replace(/\/$/, '');
  ui.serverStatus.textContent = 'Checking…';
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { planner?: string; vlm_model?: string | null };
    ui.serverStatus.textContent = body.vlm_model
      ? `Connected · VLM: ${body.vlm_model}`
      : `Connected · ${body.planner ?? 'unknown'} planner (no VLM configured)`;
    await browser.storage?.local?.set({ [SERVER_STORAGE_KEY]: url });
  } catch (error) {
    ui.serverStatus.textContent = `Unreachable — ${error instanceof Error ? error.message : error}`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.analyze.addEventListener('click', () => void analyze());
ui.checkServer.addEventListener('click', () => void checkServer());

ui.run.addEventListener('click', () => {
  if (running) {
    agent?.stop();
    pendingConfirm?.(false);
    log('Stop requested.');
    return;
  }
  void run();
});

ui.task.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !running) void run();
});

ui.presets.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-task]');
  if (!chip) return;
  ui.task.value = chip.dataset.task ?? '';
  ui.task.focus();
});

// ⌘K / Ctrl-K puts the cursor in the prompt from anywhere in the panel.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    ui.task.focus();
    ui.task.select();
  }
});

ui.clear.addEventListener('click', () => {
  agent?.stop();
  vault.clearSession();
  standaloneStep = 0;
  ledger.requests = 0;
  ledger.bytes = 0;
  ledger.local = 0;

  clearPreview();
  renderDetections([]);
  renderTimings({});
  renderLedger();
  ui.payload.textContent = '—';
  ui.guard.dataset.state = 'idle';
  ui.guardTitle.textContent = 'Egress guard armed';
  ui.guardDetail.textContent = 'Every payload is re-scanned before it is sent';
  for (const el of [ui.statDetections, ui.statArea, ui.statLevel, ui.statLatency]) {
    el.textContent = '—';
    counters.delete(el);
  }
  delete ui.metricLevel.dataset.level;
  updateVaultStat();
  setStatus('idle', 'Ready');
  log('Session cleared. Tokens and captured values dropped.');
});

ui.profileDemo.addEventListener('click', () => {
  for (const [key, value] of Object.entries(DEMO_PROFILE)) {
    vault.setProfile(key as ProfileKey, value);
  }
  buildProfileForm();
  void persistProfile();
  updateVaultStat();
  log('Loaded the demo profile (fake data).');
});

ui.visionToggle.addEventListener('change', () => {
  vision.enabled = ui.visionToggle.checked;
  ui.ocrToggle.disabled = !ui.visionToggle.checked;
  ui.visionStatus.textContent = ui.visionToggle.checked
    ? 'Models load on first use.'
    : 'Off — DOM and text layers only.';
  log(`Vision layer ${ui.visionToggle.checked ? 'enabled' : 'disabled'}.`);
});

ui.ocrToggle.addEventListener('change', () => {
  vision.ocrEnabled = ui.ocrToggle.checked;
  log(`OCR ${ui.ocrToggle.checked ? 'enabled' : 'disabled'}.`);
});

// The panel is torn down whenever it closes; release the WASM heaps with it.
window.addEventListener('pagehide', () => {
  void vision.dispose();
});

void (async () => {
  await Promise.all([restoreProfile(), restoreServerUrl()]);
  buildProfileForm();
  updateVaultStat();
  renderLedger();
  setMode('compare');
  setStatus('idle', 'Ready');
  log('Ready. Nothing has left this device.');
})();
