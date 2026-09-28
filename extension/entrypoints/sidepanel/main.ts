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
import type { Detection, PiiType, StageTimings, StepRequest } from '../../lib/protocol';
import type { PipelineOutput } from '../../lib/pipeline';
import { describeIncidents } from '../../lib/pii/egress';
import { loadImage } from '../../lib/redact/render';
import {
  documentSuggestions,
  maskValue,
  NEVER_REMEMBERED,
  normalizeLabel,
  profileKeyForField,
  questionLabel,
} from '../../lib/pii/memory';
import { TOKEN_PATTERN, Vault, type ProfileKey } from '../../lib/pii/vault';
import { forgetBackup, isRemembered, loadBackup, persistBackup } from '../../lib/pii/vault-persist';
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

  thread: $('thread'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultText: $('result-text'),
  resultNote: $('result-note'),
  resultDismiss: $<HTMLButtonElement>('result-dismiss'),

  panelDetections: $<HTMLDetailsElement>('panel-detections'),
  panelActivity: $<HTMLDetailsElement>('panel-activity'),
  detections: $('detections'),
  detectionsCount: $('detections-count'),
  timings: $('timings'),
  timingsTotal: $('timings-total'),
  payload: $('payload'),

  visionToggle: $<HTMLInputElement>('vision-toggle'),
  ocrToggle: $<HTMLInputElement>('ocr-toggle'),
  framesToggle: $<HTMLInputElement>('frames-toggle'),
  visionStatus: $('vision-status'),

  profile: $('profile'),
  profileDemo: $<HTMLButtonElement>('profile-demo'),
  vaultState: $('vault-state'),
  vaultForget: $<HTMLButtonElement>('vault-forget'),

  learn: $('learn'),
  learnTitle: $('learn-title'),
  learnNote: $('learn-note'),
  learnList: $('learn-list'),
  idScan: $<HTMLInputElement>('id-scan'),
  idScanButton: $('id-scan-button'),
  learnSave: $<HTMLButtonElement>('learn-save'),
  learnDismiss: $<HTMLButtonElement>('learn-dismiss'),

  log: $('log'),
  logCount: $('log-count'),

  serverUrl: $<HTMLInputElement>('server-url'),
  serverToken: $<HTMLInputElement>('server-token'),
  checkServer: $<HTMLButtonElement>('check-server'),
  serverStatus: $('server-status'),

  confirm: $('confirm'),
  confirmScrim: $('confirm-scrim'),
  confirmQuestion: $('confirm-question'),
  confirmAnswer: $('confirm-answer'),
  confirmInput: $<HTMLInputElement>('confirm-input'),
  confirmSelect: $<HTMLSelectElement>('confirm-select'),
  confirmNote: $('confirm-note'),
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
 * What the agent concluded, where the user is already looking.
 *
 * For a form-filling task the visible proof is the page itself. For a question —
 * "describe this page" — the summary *is* the whole answer, and it used to go only
 * into the collapsed Activity list, so a completed task looked like nothing had
 * happened at all.
 */
/**
 * The answer, as the user should read it. A question about their own data comes
 * back naming a token — "Email ⟦PROFILE.EMAIL⟧" — because a token is all the server
 * ever saw. The value goes back in here, on this device, and the note says so: the
 * server answered a question about the user's email without learning it.
 */
function showResult(title: string, text: string, kind: 'done' | 'stopped' = 'done'): void {
  ui.result.dataset.kind = kind;
  ui.resultTitle.textContent = title;
  const shown = vault.resolve(text);
  ui.resultText.textContent = shown;
  const tokens = [...new Set(text.match(TOKEN_PATTERN) ?? [])].filter((t) => vault.valueOf(t) !== undefined);
  ui.resultNote.hidden = shown === text;
  ui.resultNote.textContent =
    shown === text ? '' : `The server saw only ${tokens.join(', ')}. Filled in here, on this device.`;
  ui.result.hidden = false;
}

function hideResult(): void {
  ui.result.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Conversation
 * ------------------------------------------------------------------ */

interface Turn {
  task: string;
  /** How it ended, in the planner's own words — tokens, never resolved values. */
  summary?: string;
  li: HTMLLIElement;
  live: HTMLElement;
}

/** This panel session's turns, oldest first. Dropped by Reset and when the panel closes. */
const turns: Turn[] = [];
const TURNS_SHOWN = 6;

/**
 * A new turn: the user's words, a live line, and the answer card moved in beneath
 * them. The card keeps its id — `#result` is always the newest answer — and the
 * previous answer stays behind as plain text.
 */
function startTurn(task: string): Turn {
  const previous = turns.at(-1);
  if (previous && !ui.result.hidden) {
    const reply = Object.assign(document.createElement('p'), {
      className: 'turn__reply',
      textContent: ui.resultText.textContent ?? '',
    });
    previous.li.append(reply);
  }
  hideResult();

  const li = document.createElement('li');
  li.className = 'turn';
  const me = Object.assign(document.createElement('p'), { className: 'turn__me', textContent: task });
  const live = Object.assign(document.createElement('p'), { className: 'turn__live' });
  li.append(me, live, ui.result);
  ui.thread.prepend(li);
  ui.thread.hidden = false;
  while (ui.thread.children.length > TURNS_SHOWN) ui.thread.lastElementChild?.remove();

  const turn: Turn = { task, li, live };
  setLive(turn, 'busy', 'Reading the page…');
  turns.push(turn);
  return turn;
}

function setLive(turn: Turn, state: Status, text: string): void {
  turn.live.dataset.state = state;
  turn.live.textContent = text;
}

interface Tally {
  steps: number;
  /** Values typed or chosen on the page. */
  filled: number;
  /** Steps that never left the device (L0). */
  local: number;
}

function finishTurn(turn: Turn, outcome: { status: Status; text: string; summary?: string; tally: Tally; ms: number }): void {
  const { tally } = outcome;
  const facts = [
    ...(tally.filled ? [`${tally.filled} filled`] : []),
    ...(tally.local ? [`${tally.local} on this device`] : []),
    `${tally.steps} step${tally.steps === 1 ? '' : 's'}`,
    `${(outcome.ms / 1000).toFixed(1)} s`,
  ];
  const headline = outcome.status === 'ok' ? 'Done' : capitalise(outcome.text || 'Stopped');
  setLive(turn, outcome.status === 'busy' ? 'idle' : outcome.status, `${headline} · ${facts.join(' · ')}`);
  turn.summary = outcome.summary ?? (outcome.status === 'ok' ? 'Done.' : `Stopped: ${outcome.text || 'no reason given'}.`);
}

/** Earlier turns for the planner, oldest first. The pipeline sanitizes every string. */
function conversationSoFar(): Array<{ task: string; summary?: string }> {
  return turns.slice(-4).map(({ task, summary }) => ({ task, ...(summary ? { summary } : {}) }));
}

function clearConversation(): void {
  turns.length = 0;
  // The answer card goes home before the turns holding it are removed.
  ui.learn.before(ui.result);
  hideResult();
  ui.thread.replaceChildren();
  ui.thread.hidden = true;
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
  sheetMode('confirm');
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

/**
 * The sheet has two jobs: consent ("Press Submit?") and a question with an answer
 * ("What should I put in Father's name?"). Same surface, so the user always knows
 * where the agent is waiting — but the answer mode says plainly where the value goes.
 */
function sheetMode(mode: 'confirm' | 'ask'): void {
  ui.confirm.dataset.mode = mode;
  ui.confirmAnswer.hidden = mode !== 'ask';
  ui.confirmYes.textContent = mode === 'ask' ? 'Fill it' : 'Continue';
  ui.confirmNo.textContent = mode === 'ask' ? 'Skip' : 'Stop';
  ui.confirmNote.textContent =
    mode === 'ask'
      ? 'Typed into the page on this device. The server never sees your answer.'
      : 'Nothing has been clicked. The agent is waiting for you.';
}

/** Resolver for an answer, set while the sheet is open in answer mode. */
let pendingAnswer: ((answer: string | null) => void) | null = null;

function askForValue(question: string, field: { label?: string; options?: string[] }): Promise<string | null> {
  sheetMode('ask');
  ui.confirmQuestion.textContent = question;

  const options = (field.options ?? []).filter((o) => o.trim() && !/^(select|choose|--)/i.test(o.trim()));
  ui.confirmSelect.hidden = options.length === 0;
  ui.confirmInput.hidden = options.length > 0;
  ui.confirmSelect.replaceChildren(
    ...options.map((o) => Object.assign(document.createElement('option'), { value: o, textContent: o })),
  );
  ui.confirmInput.value = '';
  ui.confirmInput.placeholder = field.label ? `Your ${field.label.toLowerCase()}` : 'Your answer';

  ui.confirm.hidden = false;
  setStatus('busy', 'Waiting for your answer');
  (options.length ? ui.confirmSelect : ui.confirmInput).focus();

  return new Promise((resolve) => {
    pendingAnswer = (answer) => {
      ui.confirm.hidden = true;
      pendingAnswer = null;
      ui.confirmInput.value = ''; // never leave an answer sitting in the DOM
      resolve(answer);
    };
  });
}

function answerNow(): void {
  const value = ui.confirmSelect.hidden ? ui.confirmInput.value : ui.confirmSelect.value;
  pendingAnswer?.(value.trim() ? value : null);
}

ui.confirmInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') answerNow();
});

ui.confirmYes.addEventListener('click', () => {
  if (pendingAnswer) answerNow();
  else pendingConfirm?.(true);
});
ui.confirmNo.addEventListener('click', () => {
  pendingAnswer?.(null);
  pendingConfirm?.(false);
});
ui.confirmScrim.addEventListener('click', () => {
  pendingAnswer?.(null);
  pendingConfirm?.(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  pendingAnswer?.(null);
  pendingConfirm?.(false);
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

const SERVER_STORAGE_KEY = 'privagent.serverUrl';
/** A credential: kept in session storage (memory, wiped on close), like the profile. */
const TOKEN_STORAGE_KEY = 'privagent.serverToken';

/** Whether the user has agreed to keep what PrivAgent learned on this device. */
let remembered = false;

/** The × on a remembered answer. Built with DOM calls: no `innerHTML` anywhere in the panel. */
function forgetIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  for (const [name, value] of [['d', 'M7 7l10 10M17 7L7 17'], ['stroke', 'currentColor'],
    ['stroke-width', '1.9'], ['stroke-linecap', 'round']]) {
    path.setAttribute(name!, value!);
  }
  svg.append(path);
  return svg;
}

/** How the profile's keys read in the panel. */
const KEY_LABEL: Record<ProfileKey, string> = {
  FULL_NAME: 'Name',
  EMAIL: 'Email',
  PHONE: 'Mobile',
  DOB: 'Date of birth',
  ADDRESS: 'Address',
  PINCODE: 'PIN code',
  AADHAAR: 'Aadhaar',
  PAN: 'PAN',
  PASSPORT: 'Passport',
  UPI: 'UPI ID',
};

/**
 * What PrivAgent knows about the user: read-only, masked, each item forgettable.
 * Nothing here is typed in by hand (D40) — it is learned from forms the user sends,
 * answers they give the agent, a card they scan — so this is for seeing and
 * forgetting, not for filling in.
 */
function buildKnownList(): void {
  const rows = [
    ...vault.profileEntries().map(([key, value]) => ({
      label: KEY_LABEL[key],
      value,
      forget: () => vault.setProfile(key, ''),
    })),
    ...vault.memoEntries().map((memo) => ({
      label: memo.label.replace(/[*:]+\s*$/, '').trim(),
      value: memo.value ?? '',
      forget: () => vault.forgetMemo(memo.label),
    })),
  ];

  ui.profile.replaceChildren();
  if (rows.length === 0) {
    ui.profile.append(
      Object.assign(document.createElement('p'), {
        className: 'fineprint',
        textContent:
          'Nothing yet. Fill in a form yourself and PrivAgent offers to remember it; answer a question it asks and it will not ask again.',
      }),
    );
  } else {
    const list = Object.assign(document.createElement('ul'), { className: 'list list--memos' });
    for (const row of rows) {
      const li = document.createElement('li');
      const label = Object.assign(document.createElement('span'), { className: 'memo__label', textContent: row.label });
      label.title = row.label;
      const value = Object.assign(document.createElement('span'), { className: 'memo__value', textContent: maskValue(row.value) });
      const forget = Object.assign(document.createElement('button'), { className: 'memo__forget' });
      forget.append(forgetIcon());
      forget.setAttribute('aria-label', `Forget ${row.label}`);
      forget.title = 'Forget this';
      forget.addEventListener('click', () => {
        row.forget();
        buildKnownList();
        updateVaultStat();
        void saveVault(false);
        log(`Forgot your ${row.label.toLowerCase()}.`);
      });
      li.append(label, value, forget);
      list.append(li);
    }
    ui.profile.append(list);
  }
  ui.vaultState.textContent = rows.length === 0
    ? ''
    : remembered
      ? 'Kept on this device, encrypted. The server only ever sees keys like ⟦PROFILE.EMAIL⟧.'
      : 'Kept until the browser closes. The server only ever sees keys like ⟦PROFILE.EMAIL⟧.';
}

/**
 * Save the vault (lib/pii/vault-persist.ts). `remember` is the user's agreement to
 * keep it on the device — given by any act of learning: a yes on a page's prompt, a
 * save, an answer to the agent. Forgetting one item keeps the agreement as it is.
 */
async function saveVault(remember = true): Promise<void> {
  try {
    await persistBackup(vault.backup(), remember);
    remembered = await isRemembered();
  } catch (error) {
    log(`Could not save on this device: ${error instanceof Error ? error.message : error}`, 'err');
  }
}

async function restoreVault(): Promise<void> {
  const backup = await loadBackup().catch(() => undefined);
  if (backup) vault.restore(backup);
  remembered = await isRemembered();
}

/* ---- Learning from the page ---------------------------------------- */

interface Suggestion {
  label: string;
  value: string;
  type: PiiType;
  /** The profile key it would fill, when it is one. */
  key: ProfileKey | null;
}

let suggestions: Suggestion[] = [];

/**
 * Details the user has already typed into this page's form, which the vault does
 * not hold yet. Read from the payload's own elements: a sensitive field's value is
 * a token there, and the vault — here, on the device — knows what it stands for.
 * Only form fields: text on the page could be anyone's.
 */
function findSuggestions(output: PipelineOutput): Suggestion[] {
  const found: Suggestion[] = [];
  const seen = new Set<string>();
  for (const el of output.request.elements) {
    if (!el.sensitive || !el.value || NEVER_REMEMBERED.has(el.sensitive)) continue;
    if (el.value.startsWith('⟦PROFILE.')) continue; // already the user's own
    const value = vault.valueOf(el.value);
    if (!value) continue;
    const label = questionLabel(el);
    const key = profileKeyForField(el.sensitive, label);
    if (key ? vault.getProfile(key) !== undefined : !normalizeLabel(label) || vault.recall(label)) continue;
    const id = key ?? normalizeLabel(label);
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ label: label ?? key ?? el.sensitive, value, type: el.sensitive, key });
  }
  return found;
}

function offerToLearn(output: PipelineOutput): void {
  showSuggestions(
    findSuggestions(output),
    'Save your details from this page?',
    'Found in this form. Kept in your vault on this device, never sent.',
  );
}

/**
 * Read an ID card the user picked, on this device, and offer what it says for the
 * vault. The image is drawn to a canvas, read by OCR, and dropped: `readDocument`
 * returns only what the validators recognise, and nothing is kept until Save.
 */
async function scanDocument(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  ui.idScanButton.setAttribute('aria-busy', 'true');
  setStatus('busy', 'Reading the card on this device');
  try {
    const image = await loadImage(url);
    const found = await vision.readDocument(image, image.naturalWidth, image.naturalHeight);
    const offer = documentSuggestions(found, (key) => vault.getProfile(key) !== undefined);
    showSuggestions(
      offer,
      'Save what this card says?',
      'Read on this device by OCR. The image was not kept, and nothing is sent.',
    );
    ui.learn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    log(
      offer.length
        ? `Read ${offer.length} detail${offer.length === 1 ? '' : 's'} off the card, on this device.`
        : found.length
          ? 'Everything on the card is already in your vault.'
          : 'Could not read an Aadhaar number, PAN or date of birth on that image. Try a sharper, straight-on photo.',
    );
    setStatus('idle', 'Ready');
  } catch (error) {
    setStatus('err', 'Could not read the card');
    log(`Could not read the card: ${error instanceof Error ? error.message : error}`, 'err');
  } finally {
    URL.revokeObjectURL(url);
    ui.idScan.value = ''; // the file handle goes with it
    ui.idScanButton.removeAttribute('aria-busy');
  }
}

function showSuggestions(list: Suggestion[], title: string, note: string): void {
  suggestions = list;
  ui.learnTitle.textContent = title;
  ui.learnNote.textContent = note;
  ui.learn.hidden = suggestions.length === 0;
  ui.learnList.replaceChildren(
    ...suggestions.map((s, i) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
      box.dataset.index = String(i);
      const what = Object.assign(document.createElement('span'), {
        className: 'learn__what',
        textContent: s.key ? `${s.key.replace(/_/g, ' ').toLowerCase()}` : s.label,
      });
      what.title = s.label;
      const value = Object.assign(document.createElement('span'), {
        className: 'learn__value',
        textContent: maskValue(s.value),
      });
      label.append(box, what, value);
      li.append(label);
      return li;
    }),
  );
}

function saveSuggestions(): void {
  const chosen = [...ui.learnList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    .filter((box) => box.checked)
    .map((box) => suggestions[Number(box.dataset.index)]!)
    .filter(Boolean);
  for (const s of chosen) vault.learn(s.label, s.value, s.type);
  suggestions = [];
  ui.learn.hidden = true;
  updateVaultStat();
  void saveVault().then(buildKnownList);
  log(`Remembered ${chosen.length} detail${chosen.length === 1 ? '' : 's'}, on this device.`);
}

/** The server URL is not PII, so ordinary local storage is fine for it. */
async function restoreServerUrl(): Promise<void> {
  try {
    const stored = await browser.storage?.local?.get(SERVER_STORAGE_KEY);
    const url = stored?.[SERVER_STORAGE_KEY] as string | undefined;
    if (url) ui.serverUrl.value = url;
    const session = await browser.storage?.session?.get(TOKEN_STORAGE_KEY);
    const token = session?.[TOKEN_STORAGE_KEY] as string | undefined;
    if (token) ui.serverToken.value = token;
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

/**
 * Set when the panel was opened as its own window (`sidepanel.html?tab=123`):
 * browsers without a side panel API, and the task benchmark. In a side panel this
 * is undefined and the agent follows the active tab, as a person would expect.
 */
const PINNED_TAB = Number(new URLSearchParams(location.search).get('tab')) || undefined;

function makeAgent(conversation?: Array<{ task: string; summary?: string }>): Agent {
  return new Agent(
    vault,
    {
      ...(conversation?.length ? { conversation } : {}),
      targetTabId: PINNED_TAB,
      serverUrl: ui.serverUrl.value.trim(),
      serverToken: ui.serverToken.value.trim() || undefined,
      maxSteps: 12,
      vision: ui.visionToggle.checked,
      ocr: ui.ocrToggle.checked,
      coverFrames: ui.framesToggle.checked,
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
    offerToLearn(output);

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
  // Open the log for the duration: a multi-step task is the one time the user
  // wants to watch it work, and a collapsed panel makes it look like nothing is.
  ui.panelActivity.open = true;
  const conversation = conversationSoFar();
  const turn = startTurn(task);
  ui.task.value = ''; // sent, as in any chat
  agent = makeAgent(conversation);
  log(`Task: ${task}`);

  const started = performance.now();
  const tally: Tally = { steps: 0, filled: 0, local: 0 };
  let last: { status: Status; text: string } = { status: 'busy', text: '' };
  let summary: string | undefined;

  await agent.run(task, {
    onStatus: (status, text) => {
      setStatus(status, capitalise(text));
      setLive(turn, status, capitalise(text));
      last = { status, text };
    },
    onLog: log,
    onPerceived: renderOutput,
    onStep: (report: StepReport) => {
      renderTimings(report.output.timings);
      countLedger(report);
      tally.steps += 1;
      if (report.response.planner === 'local') tally.local += 1;
      if (report.result?.ok && (report.response.action === 'type' || report.response.action === 'select')) {
        tally.filled += 1;
      }
      if (report.response.action === 'done') {
        summary = report.response.summary;
        // For a question, this text is the whole answer.
        showResult(
          'Task complete',
          report.response.summary ?? 'Finished, but the planner gave no summary.',
        );
      }
      if (report.result?.ok) log(`✓ ${describeAction(report.response)}`);
      if (report.response.planner) {
        ui.visionStatus.title =
          report.response.planner === 'vlm'
            ? 'Decided by the server-side VLM'
            : 'Decided by the server’s deterministic planner';
      }
    },
    confirm: askConfirmation,
    ask: askForValue,
    onLearned: (label, profileKey) => {
      log(
        profileKey
          ? `Learned your ${profileKey.replace(/_/g, ' ').toLowerCase()} — it will be filled in for you from now on.`
          : `Learned your answer for “${label}” — it will be filled next time without asking.`,
      );
      updateVaultStat();
      void saveVault().then(buildKnownList);
    },
  });

  finishTurn(turn, { ...last, summary, tally, ms: performance.now() - started });
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
    const body = (await response.json()) as {
      planner?: string;
      vlm_model?: string | null;
      auth_required?: boolean;
    };
    const auth = body.auth_required
      ? ui.serverToken.value.trim() ? ' · token set' : ' · needs an access token'
      : '';
    ui.serverStatus.textContent = (body.vlm_model
      ? `Connected · VLM: ${body.vlm_model}`
      : `Connected · ${body.planner ?? 'unknown'} planner (no VLM configured)`) + auth;
    await browser.storage?.local?.set({ [SERVER_STORAGE_KEY]: url });
    await browser.storage?.session?.set({ [TOKEN_STORAGE_KEY]: ui.serverToken.value.trim() });
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

ui.resultDismiss.addEventListener('click', hideResult);

ui.analyze.addEventListener('click', () => void analyze());
ui.checkServer.addEventListener('click', () => void checkServer());

ui.run.addEventListener('click', () => {
  if (running) {
    agent?.stop();
    pendingAnswer?.(null);
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
  clearConversation();
  ui.learn.hidden = true;
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
  void saveVault().then(buildKnownList);
  updateVaultStat();
  log('Loaded the demo profile (fake data).');
});

ui.learnSave.addEventListener('click', saveSuggestions);
ui.idScan.addEventListener('change', () => {
  const file = ui.idScan.files?.[0];
  if (file) void scanDocument(file);
});
ui.learnDismiss.addEventListener('click', () => {
  suggestions = [];
  ui.learn.hidden = true;
});

ui.vaultForget.addEventListener('click', async () => {
  const proceed = await askConfirmation(
    'Forget everything PrivAgent knows about you — here and on this device?',
  );
  setStatus('idle', 'Ready');
  if (!proceed) return;
  vault.clearAll();
  try {
    await forgetBackup();
  } catch {
    /* nothing was saved */
  }
  remembered = false;
  buildKnownList();
  updateVaultStat();
  log('Forgotten. Nothing of yours is kept on this device.');
});

// A yes on a page's "Remember what you typed?" is saved by the background (D40);
// pick it up here so the list and the next agent step both know it.
browser.runtime.onMessage.addListener((message: { kind?: string }) => {
  if (message?.kind !== 'vault-changed') return;
  void (async () => {
    await restoreVault();
    buildKnownList();
    updateVaultStat();
    log('Remembered what you typed on the page. It will be filled in for you next time.');
  })();
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

ui.framesToggle.addEventListener('change', () => {
  log(
    ui.framesToggle.checked
      ? 'Frames we cannot inspect will be covered.'
      : 'Frames we cannot inspect will be sent as-is. Their contents were never scanned.',
    ui.framesToggle.checked ? 'info' : 'err',
  );
});

// The panel is torn down whenever it closes; release the WASM heaps with it.
window.addEventListener('pagehide', () => {
  void vision.dispose();
});

void (async () => {
  await Promise.all([restoreVault(), restoreServerUrl()]);
  buildKnownList();
  updateVaultStat();
  renderLedger();
  setMode('compare');
  setStatus('idle', 'Ready');
  log('Ready. Nothing has left this device.');
})();
