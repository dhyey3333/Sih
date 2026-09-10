/**
 * Side panel: the agent UI and, from M4, the on-device model runtime.
 *
 * It owns the vault and runs the sanitizer pipeline, because this is the only
 * extension context with a DOM (canvas for redaction) and WebGPU. The background
 * worker just moves bytes; the content script just touches the page.
 */

import { DEMO_PROFILE } from '../../lib/demo-profile';
import { sendToBackground, type PerceiveResult } from '../../lib/messaging';
import type { Detection, StageTimings, StepRequest } from '../../lib/protocol';
import { runPipeline, type PipelineOutput } from '../../lib/pipeline';
import { describeIncidents } from '../../lib/pii/egress';
import { PROFILE_KEYS, Vault, type ProfileKey } from '../../lib/pii/vault';
import { loadImage } from '../../lib/redact/render';

const vault = new Vault();
const sessionId = crypto.randomUUID();
let step = 0;
let lastOutput: PipelineOutput | null = null;
let originalDataUrl = '';
let previewMode: 'sanitized' | 'original' = 'sanitized';

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
  clear: $<HTMLButtonElement>('clear'),
  error: $('error'),
  tabSanitized: $<HTMLButtonElement>('tab-sanitized'),
  tabOriginal: $<HTMLButtonElement>('tab-original'),
  preview: $('preview'),
  previewImg: $<HTMLImageElement>('preview-img'),
  statDetections: $('stat-detections'),
  statArea: $('stat-area'),
  statLevel: $('stat-level'),
  statVault: $('stat-vault'),
  egress: $('egress'),
  egressDetail: $('egress-detail'),
  detections: $('detections'),
  detectionsCount: $('detections-count'),
  timings: $('timings'),
  payload: $('payload'),
  profile: $('profile'),
  profileDemo: $<HTMLButtonElement>('profile-demo'),
  log: $('log'),
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
  while (ui.log.children.length > 40) ui.log.lastElementChild?.remove();
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

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

const PROFILE_STORAGE_KEY = 'privagent.profile';

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
  total: 'total',
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

  if (timings.total !== undefined) {
    const li = document.createElement('li');
    li.innerHTML = `<span><b>total</b></span><span class="track"></span><span class="ms"><b>${timings.total} ms</b></span>`;
    ui.timings.append(li);
  }
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
 * Main action
 * ------------------------------------------------------------------ */

async function analyze(): Promise<void> {
  ui.analyze.disabled = true;
  showError(null);
  setStatus('busy', 'reading page…');

  try {
    // The vault's values go with the request so the content script can locate the
    // user's own name and address on screen and give them a redaction box, not
    // just a token in the JSON (docs/DECISIONS.md).
    const perceived = await sendToBackground<PerceiveResult>({
      kind: 'perceive',
      knownValues: vault.needles(),
    });
    originalDataUrl = perceived.imageDataUrl;

    const image = await loadImage(perceived.imageDataUrl);
    setStatus('busy', 'redacting…');

    const output = runPipeline({
      snapshot: perceived.snapshot,
      image,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      vault,
      sessionId,
      task: ui.task.value.trim() || 'Describe this page',
      step: step++,
      history: [],
    });

    // Merge the capture/snapshot timings from the background into the panel's own.
    output.timings.capture = perceived.timings.capture;
    output.timings.snapshot = perceived.timings.snapshot;

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
    ui.analyze.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ui.analyze.addEventListener('click', () => void analyze());
ui.tabSanitized.addEventListener('click', () => setPreviewMode('sanitized'));
ui.tabOriginal.addEventListener('click', () => setPreviewMode('original'));

ui.clear.addEventListener('click', () => {
  vault.clearSession();
  step = 0;
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
  await restoreProfile();
  buildProfileForm();
  updateVaultStat();
  setStatus('idle', 'idle');
  log('Ready. Nothing has left this device.');
})();
