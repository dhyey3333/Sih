/**
 * Side panel: the agent UI and, from M4, the on-device model runtime.
 *
 * It owns the vault and runs the sanitizer pipeline, because this is the only
 * extension context with a DOM (canvas for redaction) and WebGPU. The background
 * worker just moves bytes; the content script just touches the page.
 *
 * Two entry points:
 *   Analyze page — perceive and sanitize only. Nothing is sent. This alone is the
 *                  whole privacy demonstration.
 *   Run task     — the full agent loop, through the server.
 */

import { Agent, describeAction, type StepReport } from '../../lib/agent';
import { DEMO_PROFILE } from '../../lib/demo-profile';
import type { StageTimings, StepRequest } from '../../lib/protocol';
import type { Detection } from '../../lib/protocol';
import type { PipelineOutput } from '../../lib/pipeline';
import { describeIncidents } from '../../lib/pii/egress';
import { PROFILE_KEYS, Vault, type ProfileKey } from '../../lib/pii/vault';

const vault = new Vault();
let agent: Agent | null = null;
let lastOutput: PipelineOutput | null = null;
let originalDataUrl = '';
let previewMode: 'sanitized' | 'original' = 'sanitized';
let standaloneStep = 0;

/** Resolver for the confirmation gate, set while the dialog is open. */
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
  task: $<HTMLInputElement>('task'),
  analyze: $<HTMLButtonElement>('analyze'),
  run: $<HTMLButtonElement>('run'),
  stop: $<HTMLButtonElement>('stop'),
  clear: $<HTMLButtonElement>('clear'),
  error: $('error'),
  confirm: $('confirm'),
  confirmQuestion: $('confirm-question'),
  confirmYes: $<HTMLButtonElement>('confirm-yes'),
  confirmNo: $<HTMLButtonElement>('confirm-no'),
  tabSanitized: $<HTMLButtonElement>('tab-sanitized'),
  tabOriginal: $<HTMLButtonElement>('tab-original'),
  preview: $('preview'),
  previewImg: $<HTMLImageElement>('preview-img'),
  statDetections: $('stat-detections'),
  statArea: $('stat-area'),
  statLevel: $('stat-level'),
  statVault: $('stat-vault'),
  plannerNote: $('planner-note'),
  egress: $('egress'),
  egressDetail: $('egress-detail'),
  detections: $('detections'),
  detectionsCount: $('detections-count'),
  timings: $('timings'),
  payload: $('payload'),
  profile: $('profile'),
  profileDemo: $<HTMLButtonElement>('profile-demo'),
  log: $('log'),
  serverUrl: $<HTMLInputElement>('server-url'),
  checkServer: $<HTMLButtonElement>('check-server'),
  serverStatus: $('server-status'),
};

/* ------------------------------------------------------------------ *
 * Status + logging
 * ------------------------------------------------------------------ */

type Status = 'idle' | 'busy' | 'ok' | 'err';

function setStatus(status: Status, text: string): void {
  ui.status.className = `pill pill--${status}`;
  ui.status.textContent = text;
}

function log(message: string, kind: 'info' | 'err' = 'info'): void {
  const li = document.createElement('li');
  if (kind === 'err') li.className = 'err';
  const time = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<b>${time}</b> ${escapeHtml(message)}`;
  ui.log.prepend(li);
  while (ui.log.children.length > 60) ui.log.lastElementChild?.remove();
}

function showError(message: string | null): void {
  if (!message) {
    ui.error.hidden = true;
    return;
  }
  ui.error.hidden = false;
  ui.error.textContent = message;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
  setStatus('busy', 'waiting for you');
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

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

const PROFILE_STORAGE_KEY = 'privagent.profile';
const SERVER_STORAGE_KEY = 'privagent.serverUrl';

function buildProfileForm(): void {
  ui.profile.innerHTML = '';
  for (const key of PROFILE_KEYS) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = key.replace(/_/g, ' ').toLowerCase();

    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.key = key;
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
 * Persisted to `storage.session`, which lives in memory and is wiped when the
 * browser closes. Encrypted `storage.local` persistence is a later milestone —
 * until then, not writing PII to disk at all is the safer default.
 */
async function persistProfile(): Promise<void> {
  try {
    await browser.storage?.session?.set({
      [PROFILE_STORAGE_KEY]: Object.fromEntries(vault.profileEntries()),
    });
  } catch {
    /* storage.session unavailable: the profile simply stays in memory */
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

/** The server URL is not PII, so local storage is fine for it. */
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

function setPreviewMode(mode: 'sanitized' | 'original'): void {
  previewMode = mode;
  ui.tabSanitized.classList.toggle('is-active', mode === 'sanitized');
  ui.tabOriginal.classList.toggle('is-active', mode === 'original');
  ui.tabSanitized.setAttribute('aria-selected', String(mode === 'sanitized'));
  ui.tabOriginal.setAttribute('aria-selected', String(mode === 'original'));

  const src = mode === 'sanitized' ? lastOutput?.redactedDataUrl : originalDataUrl;
  if (!src) return;
  ui.previewImg.src = src;
  ui.previewImg.hidden = false;
  ui.preview.querySelector('.preview__empty')?.remove();
}

const CREDENTIAL_TYPES = new Set(['PASSWORD', 'CARD', 'CVV', 'AADHAAR', 'PAN', 'PASSPORT', 'ACCOUNT']);

function renderDetections(detections: Detection[]): void {
  ui.detectionsCount.textContent = String(detections.length);
  ui.detections.innerHTML = '';

  if (detections.length === 0) {
    ui.detections.innerHTML = '<li class="muted">No sensitive content found on this screen.</li>';
    return;
  }

  for (const d of detections) {
    const li = document.createElement('li');
    const tagClass = d.type === 'FACE' ? 'tag tag--face' : CREDENTIAL_TYPES.has(d.type) ? 'tag tag--cred' : 'tag';
    li.innerHTML =
      `<span class="${tagClass}">${escapeHtml(d.type)}</span>` +
      `<span class="token">${escapeHtml(d.token)}</span>` +
      `<span class="src">${escapeHtml(d.source)} · ${Math.round(d.confidence * 100)}%</span>`;
    ui.detections.append(li);
  }
}

const TIMING_LABELS: Partial<Record<keyof StageTimings, string>> = {
  capture: 'capture',
  snapshot: 'DOM snapshot',
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
  const entries = Object.entries(timings).filter(([key]) => key !== 'total') as Array<
    [keyof StageTimings, number]
  >;
  ui.timings.innerHTML = '';
  if (entries.length === 0) {
    ui.timings.innerHTML = '<li class="muted">Nothing measured yet.</li>';
    return;
  }

  const max = Math.max(...entries.map(([, ms]) => ms), 1);
  for (const [stage, ms] of entries) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${escapeHtml(TIMING_LABELS[stage] ?? stage)}</span>` +
      `<span class="track"><span class="fill" style="width:${Math.max(2, (ms / max) * 100)}%"></span></span>` +
      `<span class="ms">${ms} ms</span>`;
    ui.timings.append(li);
  }

  const wall = entries.reduce((sum, [, ms]) => sum + ms, 0);
  const li = document.createElement('li');
  li.innerHTML = `<span><b>total</b></span><span class="track"></span><span class="ms"><b>${Math.round(wall * 10) / 10} ms</b></span>`;
  ui.timings.append(li);
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

function renderEgress(output: PipelineOutput): void {
  const { egress } = output;
  if (egress.ok) {
    ui.egress.className = 'egress egress--pass';
    ui.egressDetail.textContent = `clean · ${egress.stringsScanned} strings · ${egress.durationMs.toFixed(1)} ms`;
  } else {
    ui.egress.className = 'egress egress--block';
    ui.egressDetail.textContent = `BLOCKED · ${describeIncidents(egress.incidents)}`;
  }
}

function updateVaultStat(): void {
  ui.statVault.textContent = String(vault.size);
}

function renderOutput(output: PipelineOutput): void {
  lastOutput = output;
  originalDataUrl = output.originalDataUrl ?? '';
  ui.statDetections.textContent = String(output.detections.length);
  ui.statArea.textContent = `${Math.round(output.areaRatio * 100)}%`;
  ui.statLevel.textContent = `L${output.disclosureLevel}`;
  updateVaultStat();
  renderDetections(output.detections);
  renderTimings(output.timings);
  renderPayload(output.request);
  renderEgress(output);
  setPreviewMode(previewMode);
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function makeAgent(): Agent {
  return new Agent(vault, { serverUrl: ui.serverUrl.value.trim(), maxSteps: 12 });
}

/** Perceive and sanitize only. Nothing is sent anywhere. */
async function analyze(): Promise<void> {
  setRunning(true);
  showError(null);
  setStatus('busy', 'reading page…');

  try {
    const output = await makeAgent().perceiveOnly(
      ui.task.value.trim() || 'Describe this page',
      standaloneStep++,
    );
    renderOutput(output);

    if (output.egress.ok) {
      setStatus('ok', 'safe to send');
      log(
        `${output.detections.length} detections · ${Math.round(output.areaRatio * 100)}% redacted · ` +
          `L${output.disclosureLevel} · ${output.timings.total} ms`,
      );
    } else {
      setStatus('err', 'egress blocked');
      log(`Egress guard blocked the payload: ${describeIncidents(output.egress.incidents)}`, 'err');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus('err', 'failed');
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
    showError('Type a task first, for example: fill this form with my profile and stop before submitting.');
    return;
  }

  setRunning(true);
  showError(null);
  agent = makeAgent();
  log(`Task: ${task}`);

  await agent.run(task, {
    onStatus: setStatus,
    onLog: log,
    onPerceived: renderOutput,
    onStep: (report: StepReport) => {
      renderTimings(report.output.timings);
      if (report.response.planner) {
        ui.plannerNote.hidden = false;
        ui.plannerNote.textContent =
          report.response.planner === 'vlm'
            ? 'Decided by the server-side VLM.'
            : 'Decided by the server’s deterministic planner (no VLM endpoint configured).';
      }
      if (report.result?.ok) log(`✓ ${describeAction(report.response)}`);
    },
    confirm: askConfirmation,
  });

  setRunning(false);
  agent = null;
}

async function checkServer(): Promise<void> {
  const url = ui.serverUrl.value.trim().replace(/\/$/, '');
  ui.serverStatus.textContent = 'checking…';
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { planner?: string; vlm_model?: string | null };
    ui.serverStatus.textContent = body.vlm_model
      ? `connected · VLM: ${body.vlm_model}`
      : `connected · ${body.planner ?? 'unknown'} planner (no VLM configured)`;
    await browser.storage?.local?.set({ [SERVER_STORAGE_KEY]: url });
  } catch (error) {
    ui.serverStatus.textContent = `unreachable — ${error instanceof Error ? error.message : error}`;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.analyze.addEventListener('click', () => void analyze());
ui.run.addEventListener('click', () => void run());
ui.stop.addEventListener('click', () => {
  agent?.stop();
  pendingConfirm?.(false);
  log('Stop requested.');
});
ui.checkServer.addEventListener('click', () => void checkServer());
ui.tabSanitized.addEventListener('click', () => setPreviewMode('sanitized'));
ui.tabOriginal.addEventListener('click', () => setPreviewMode('original'));

ui.task.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void run();
});

ui.clear.addEventListener('click', () => {
  agent?.stop();
  vault.clearSession();
  standaloneStep = 0;
  lastOutput = null;
  originalDataUrl = '';
  ui.previewImg.hidden = true;
  ui.previewImg.removeAttribute('src');
  ui.detections.innerHTML = '<li class="muted">Nothing scanned yet.</li>';
  ui.detectionsCount.textContent = '0';
  ui.timings.innerHTML = '<li class="muted">Nothing measured yet.</li>';
  ui.payload.textContent = '–';
  ui.egress.className = 'egress egress--unknown';
  ui.egressDetail.textContent = 'not run yet';
  ui.statDetections.textContent = '–';
  ui.statArea.textContent = '–';
  ui.statLevel.textContent = '–';
  ui.plannerNote.hidden = true;
  updateVaultStat();
  setStatus('idle', 'idle');
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

void (async () => {
  await Promise.all([restoreProfile(), restoreServerUrl()]);
  buildProfileForm();
  updateVaultStat();
  setStatus('idle', 'idle');
  log('Ready. Nothing has left this device.');
})();
