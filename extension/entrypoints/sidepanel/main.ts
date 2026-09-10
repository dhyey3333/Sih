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
let lastOutput: PipelineOutput | null = null;
let standaloneStep = 0;
let logCount = 0;

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
  stageLegend: $('stage-legend'),
  stageReveal: $('stage-reveal'),
  stageDivider: $('stage-divider'),
  stageSlider: $<HTMLInputElement>('stage-slider'),
  previewOriginal: $<HTMLImageElement>('preview-original'),
  previewSanitized: $<HTMLImageElement>('preview-sanitized'),

  task: $<HTMLInputElement>('task'),
  run: $<HTMLButtonElement>('run'),
  presets: $('presets'),
  analyze: $<HTMLButtonElement>('analyze'),
  stop: $<HTMLButtonElement>('stop'),
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

function setRunning(running: boolean): void {
  ui.run.disabled = running;
  ui.analyze.disabled = running;
  ui.stop.disabled = !running;
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingConfirm) pendingConfirm(false);
});

/* ------------------------------------------------------------------ *
 * The comparison wipe
 * ------------------------------------------------------------------ */

function setReveal(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent));
  ui.stage.style.setProperty('--reveal', `${clamped}%`);
}

ui.stageSlider.addEventListener('input', () => setReveal(Number(ui.stageSlider.value)));

function showPreview(originalUrl: string, sanitizedUrl: string): void {
  ui.stageEmpty.hidden = true;
  ui.previewOriginal.src = originalUrl || sanitizedUrl;
  ui.previewSanitized.src = sanitizedUrl;
  for (const el of [ui.previewOriginal, ui.stageReveal, ui.stageDivider, ui.stageSlider, ui.stageLegend]) {
    el.hidden = false;
  }
  setReveal(Number(ui.stageSlider.value));
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
  ui.statLatency.textContent = `${Math.round(wall)}`;
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

const DISCLOSURE_NOTE: Record<number, string> = {
  0: 'Handled locally — no request was made.',
  1: 'Structure only — no screenshot was sent.',
  2: 'Sanitized screenshot + structure.',
};

function renderOutput(output: PipelineOutput): void {
  lastOutput = output;

  ui.statDetections.textContent = String(output.detections.length);
  ui.statArea.textContent = `${Math.round(output.areaRatio * 100)}%`;
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
ui.run.addEventListener('click', () => void run());
ui.checkServer.addEventListener('click', () => void checkServer());

ui.task.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void run();
});

ui.presets.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-task]');
  if (!chip) return;
  ui.task.value = chip.dataset.task ?? '';
  ui.task.focus();
});

ui.stop.addEventListener('click', () => {
  agent?.stop();
  pendingConfirm?.(false);
  log('Stop requested.');
});

ui.clear.addEventListener('click', () => {
  agent?.stop();
  vault.clearSession();
  standaloneStep = 0;
  lastOutput = null;

  for (const el of [ui.previewOriginal, ui.stageReveal, ui.stageDivider, ui.stageSlider, ui.stageLegend]) {
    el.hidden = true;
  }
  ui.stageEmpty.hidden = false;
  ui.previewOriginal.removeAttribute('src');
  ui.previewSanitized.removeAttribute('src');

  renderDetections([]);
  renderTimings({});
  ui.payload.textContent = '—';
  ui.guard.dataset.state = 'idle';
  ui.guardTitle.textContent = 'Egress guard';
  ui.guardDetail.textContent = 'Nothing has left this device';
  for (const el of [ui.statDetections, ui.statArea, ui.statLevel, ui.statLatency]) el.textContent = '—';
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
  setStatus('idle', 'Ready');
  log('Ready. Nothing has left this device.');
})();
