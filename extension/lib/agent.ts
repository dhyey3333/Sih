/**
 * The agent loop.
 *
 * perceive → sanitize → send → decide → confirm → rehydrate → execute → repeat.
 *
 * Three safety gates sit between the server's answer and the page, and none of
 * them trust the model:
 *
 *   1. **Token resolution.** A `type` action whose text still contains an unknown
 *      token is refused. A model that hallucinates `⟦AADHAAR_9⟧` gets an error in
 *      the history, not an arbitrary string typed into a government form.
 *   2. **Irreversible actions.** Submit, pay, send, delete and friends stop the
 *      loop and wait for the user to click Confirm in the side panel. The server
 *      is told not to try, but the client is what enforces it.
 *   3. **Step budget.** A bounded number of steps, so a confused model cannot
 *      loop on a page forever.
 *   4. **Value-to-field matching** (lib/type-gate.ts). A real value is only typed
 *      into a field detected as asking for that kind of value. A page that talks the
 *      model into "type the Aadhaar into this search box" gets a question put to the
 *      user, not the user's Aadhaar number.
 *
 * And two rules about where the agent may go: it navigates within the site it is
 * on without asking, and anywhere else only with the user's say-so; and it never
 * resolves a token inside a URL, so a model cannot smuggle a value out in a link.
 */

import { DEMO_PROFILE } from './demo-profile';
import { planLocally } from './local-planner';
import { sendToBackground, type ActionResult, type PerceiveResult, type ResolvedAction } from './messaging';
import { runPipeline, type PipelineOutput } from './pipeline';
import { checkValueTarget, friendlyType } from './type-gate';
import {
  IRREVERSIBLE_HINTS,
  type HistoryEntry,
  type StepRequest,
  type StepResponse,
  type WireElement,
} from './protocol';
import { TOKEN_PATTERN, type Vault } from './pii/vault';
import { loadImage } from './redact/render';
import type { VisionLayer } from './vision';
import { VISION_ID_BASE, type VisionElement } from './vision/ui-detector';

export interface AgentOptions {
  serverUrl: string;
  maxSteps?: number;
  /** Pause between steps, to let the page settle after an action. */
  settleMs?: number;
  /** Turn the on-device vision layer off, to show the DOM-only baseline. */
  vision?: boolean;
  /** Turn OCR off independently — it is the expensive half of the vision layer. */
  ocr?: boolean;
  /**
   * Handle unambiguous steps on-device without contacting the server (L0).
   * On by default: it is both the fastest and the most private path.
   */
  localFirst?: boolean;
  /**
   * Paint over frames the DOM layer was not allowed to read (cross-origin iframes,
   * embeds). On by default — see `detectionsFromOpaqueFrames`.
   */
  coverFrames?: boolean;
  /**
   * Act on this tab rather than "the active tab of the panel's window". Set when the
   * panel runs in its own window (browsers with no side panel, like Opera — and the
   * task benchmark), where the active tab of *that* window is the panel itself.
   */
  targetTabId?: number;
}

export interface StepReport {
  step: number;
  output: PipelineOutput;
  response: StepResponse;
  result?: ActionResult;
  /** Round-trip time to the server, measured client-side. */
  networkMs: number;
}

export interface AgentCallbacks {
  onStatus: (status: 'idle' | 'busy' | 'ok' | 'err', text: string) => void;
  onLog: (message: string, kind?: 'info' | 'err') => void;
  /** Fired after every perception, so the UI can show the redacted preview. */
  onPerceived: (output: PipelineOutput) => void;
  onStep: (report: StepReport) => void;
  /** Resolve true to proceed with an irreversible action. */
  confirm: (question: string) => Promise<boolean>;
  /**
   * Ask the user for a value the agent needs and the profile does not hold.
   * Resolves to the answer, or null if they declined. The answer is typed locally
   * and never sent: a sensitive field's answer goes on the wire only as a token.
   */
  ask?: (question: string, field: { label?: string; options?: string[] }) => Promise<string | null>;
}

/** A field a person could type or pick an answer into. Never a password. */
function isFillable(el: WireElement | undefined): el is WireElement {
  if (!el || el.disabled || el.type === 'password') return false;
  return ['textbox', 'searchbox', 'combobox', 'spinbutton', 'radio'].includes(el.role);
}

/** What a question about `el` can be answered with: a dropdown's options, or a radio group's labels. */
function answerOptions(el: WireElement, all: WireElement[]): string[] | undefined {
  if (el.role === 'radio') {
    const labels = all.filter((e) => e.role === 'radio' && e.group === el.group).map((e) => e.label ?? '');
    return labels.filter(Boolean);
  }
  return el.options;
}

/** Would pressing Enter here submit something? Everything except a search box. */
function enterSubmits(el: WireElement | undefined): boolean {
  if (!el) return true;
  if (el.role === 'searchbox' || el.type === 'search') return false;
  return !/\bsearch\b|खोज/i.test(`${el.label ?? ''} ${el.placeholder ?? ''}`);
}

export class AgentStopped extends Error {
  constructor() {
    super('Stopped');
    this.name = 'AgentStopped';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Agent {
  private stopped = false;
  private readonly history: HistoryEntry[] = [];
  private readonly sessionId = crypto.randomUUID();
  /** Elements the detector found in pixels, from the most recent perception. */
  private visionElements: VisionElement[] = [];
  /** Element ids already acted on, so the local planner never loops on one. */
  private readonly attempted = new Set<number>();
  /** The page those ids belong to. A different page means different elements. */
  private pageKey = '';

  /** Record a step, tagged with the page it happened on. */
  private remember(entry: HistoryEntry): void {
    this.history.push({ ...entry, page: this.pageKey });
  }

  constructor(
    private readonly vault: Vault,
    private readonly options: AgentOptions,
    /**
     * Shared across agent runs: the ONNX session takes ~100 ms to compile and the
     * side panel would otherwise pay that on every task (CLAUDE.md).
     */
    private readonly vision: VisionLayer,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Perceive once and run the sanitizer, without contacting the server.
   * This is the "Analyze page" button, and it is the whole privacy demo on its own.
   */
  async perceiveOnly(task: string, step = 0): Promise<PipelineOutput> {
    const perceived = await sendToBackground<PerceiveResult>({
      kind: 'perceive',
      tabId: this.options.targetTabId,
      knownValues: this.vault.needles(),
    });
    return this.sanitize(perceived, task, step);
  }

  async run(task: string, callbacks: AgentCallbacks): Promise<void> {
    this.stopped = false;
    const maxSteps = this.options.maxSteps ?? 12;

    try {
      for (let step = 0; step < maxSteps; step++) {
        this.throwIfStopped();

        callbacks.onStatus('busy', `step ${step + 1}: reading page…`);
        const perceived = await sendToBackground<PerceiveResult>({
          kind: 'perceive',
          tabId: this.options.targetTabId,
          knownValues: this.vault.needles(),
        });
        this.throwIfStopped();

        const output = await this.sanitize(perceived, task, step);
        callbacks.onPerceived(output);

        // A new page means new elements: ids from the last one mean nothing here.
        const here = `${output.request.page.origin}${output.request.page.path}`;
        if (here !== this.pageKey) {
          this.pageKey = here;
          this.attempted.clear();
        }

        if (!output.egress.ok) {
          callbacks.onStatus('err', 'egress blocked');
          callbacks.onLog('Egress guard blocked the payload. Nothing was sent.', 'err');
          return;
        }

        // L0: if the next action is unambiguous from what the page declared about
        // itself, do it here and send nothing at all (docs/PLAN.md §3.5).
        const local = this.options.localFirst === false
          ? null
          : planLocally({
              task,
              elements: perceived.snapshot.elements,
              vault: this.vault,
              attempted: this.attempted,
              alreadyScrolled: this.history.some((h) => h.action === 'scroll' && h.ok && h.page === this.pageKey),
            });

        let response: StepResponse;
        if (local) {
          response = local.response;
          output.disclosureLevel = 0;
          callbacks.onPerceived(output);
          callbacks.onLog(`local → ${describeAction(response)} — ${local.because}`);
        } else {
          callbacks.onStatus('busy', `step ${step + 1}: asking the server…`);
          const networkStart = performance.now();
          response = await this.postStep(output.request);
          const networkMs = Math.round((performance.now() - networkStart) * 10) / 10;
          this.throwIfStopped();

          output.timings.network = networkMs - (response.timings?.server_total ?? 0);
          output.timings.server = response.timings?.server_total ?? 0;
        }

        const report: StepReport = { step, output, response, networkMs: output.timings.network ?? 0 };
        if (!local) {
          const who = `${response.planner ?? 'server'}${response.model ? ` · ${response.model}` : ''}`;
          callbacks.onLog(
            `${who} → ${describeAction(response)}` + (response.reason ? ` — ${response.reason}` : ''),
          );
        }

        if (response.action === 'done') {
          callbacks.onStep(report);
          callbacks.onStatus('ok', 'task complete');
          callbacks.onLog(`Done: ${response.summary ?? 'no summary given'}`);
          return;
        }

        if (response.action === 'ask_user') {
          callbacks.onStep(report);
          const question = response.question ?? 'The agent needs your input.';
          const target = output.request.elements.find((e) => e.id === response.element_id);

          // A question about a field is a request for a *value*: collect it here,
          // type it here, and keep it off the wire. (It used to be a Continue/Stop
          // sheet whose Continue clicked the field — a dead end on every required
          // field the profile did not cover.) A question about a button is a
          // request for consent, and keeps the old path below.
          if (isFillable(target) && callbacks.ask) {
            const options = answerOptions(target, output.request.elements);
            const answer = await callbacks.ask(question, {
              label: target.role === 'radio' ? target.group?.replace(/_/g, ' ') : target.label,
              options,
            });
            this.throwIfStopped();
            if (answer === null || !answer.trim()) {
              this.remember({ action: 'ask_user', element_id: target.id, ok: false, error: 'declined by user' });
              callbacks.onStatus('idle', 'stopped by you');
              callbacks.onLog('You skipped the question. Stopping.');
              return;
            }
            // A sensitive field's answer becomes a vault secret with a token, so the
            // next payload carries ⟦AADHAAR_1⟧ and the egress guard knows to block the
            // raw value. A plain field's answer ("Occupation") stays plain on the page
            // but is still kept out of the history we send back.
            const value = target.sensitive ? this.vault.tokenize(target.sensitive, answer.trim()) : answer.trim();
            const filled: StepResponse = options?.length
              ? { action: 'select', element_id: target.id, option: value, planner: response.planner }
              : { action: 'type', element_id: target.id, text: value, planner: response.planner };
            await this.executeStep(filled, output.request.elements, callbacks, report, true,
              target.sensitive ? value : '(your answer)');
            callbacks.onLog(`✓ filled your answer into ${target.label ? `“${target.label}”` : `field ${target.id}`}`);
            await sleep(this.options.settleMs ?? 700);
            continue;
          }

          const proceed = await callbacks.confirm(question);
          this.throwIfStopped();

          if (!proceed) {
            this.remember({ action: 'ask_user', ok: false, error: 'declined by user' });
            callbacks.onStatus('idle', 'stopped by you');
            callbacks.onLog('You declined. Stopping.');
            return;
          }
          // Approval of an ask_user that names an element means "do it".
          if (response.element_id === undefined) {
            this.remember({ action: 'ask_user', ok: true });
            continue;
          }
          const approved: StepResponse = { ...response, action: 'click' };
          await this.executeStep(approved, output.request.elements, callbacks, report, true);
          await sleep(this.options.settleMs ?? 700);
          continue;
        }

        if (response.action === 'wait') {
          callbacks.onStep(report);
          // Bounded: a model asking to wait a minute is a model that is stuck.
          await sleep(Math.min(Math.max(response.ms ?? 800, 100), 5000));
          this.remember({ action: 'wait', ok: true });
          continue;
        }

        if (response.action === 'navigate') {
          callbacks.onStep(report);
          await this.navigate(response, output, callbacks);
          continue;
        }

        await this.executeStep(response, output.request.elements, callbacks, report, false);
        await sleep(this.options.settleMs ?? 700);
      }

      callbacks.onStatus('err', 'step budget reached');
      callbacks.onLog(`Stopped after ${maxSteps} steps without finishing.`, 'err');
    } catch (error) {
      if (error instanceof AgentStopped) {
        callbacks.onStatus('idle', 'stopped');
        callbacks.onLog('Stopped.');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onStatus('err', 'failed');
      callbacks.onLog(message, 'err');
    }
  }

  /* ---------------- internals ---------------- */

  private throwIfStopped(): void {
    if (this.stopped) throw new AgentStopped();
  }

  private async sanitize(
    perceived: PerceiveResult,
    task: string,
    step: number,
  ): Promise<PipelineOutput> {
    const image = await loadImage(perceived.imageDataUrl);

    // The vision layer runs before the pipeline, so its boxes go through the same
    // fusion, tokenization and egress guard as the DOM layer's — one path, not two.
    this.vision.enabled = this.options.vision !== false;
    this.vision.ocrEnabled = this.options.ocr !== false;
    const visionStart = performance.now();
    const vision = await this.vision.detect(
      image,
      image.naturalWidth,
      image.naturalHeight,
      perceived.snapshot,
      this.vault,
    );
    const visionMs = Math.round((performance.now() - visionStart) * 10) / 10;

    const output = runPipeline({
      snapshot: perceived.snapshot,
      image,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      vault: this.vault,
      sessionId: this.sessionId,
      task,
      step,
      history: this.history.slice(-8),
      visionDetections: vision.detections,
      visionElements: vision.elements,
      coverOpaqueFrames: this.options.coverFrames !== false,
    });
    // Remembered so an action on a pixel-found control can be resolved to a point.
    this.visionElements = vision.elements;
    output.timings.vision = visionMs;
    output.visionStats = vision.stats;
    output.timings.capture = perceived.timings.capture;
    output.timings.snapshot = perceived.timings.snapshot;
    // Held only for the panel's before/after toggle; never serialized.
    output.originalDataUrl = perceived.imageDataUrl;
    return output;
  }

  private async postStep(request: StepRequest): Promise<StepResponse> {
    const base = this.options.serverUrl.replace(/\/$/, '');

    let response: Response;
    try {
      response = await fetch(`${base}/v1/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // `fetch` rejects with a bare "Failed to fetch" when nothing is listening,
      // which tells the user nothing about what to do next. Every other failure in
      // this file names its cause; this one has to as well, because "the planner is
      // not running" is by far the most common way a fresh setup breaks.
      throw new Error(
        `Cannot reach the planner at ${base}. Start it with: ` +
          `cd server && uv run uvicorn app.main:app --port 8000 — or press Analyze, ` +
          `which needs no server at all. (${error instanceof Error ? error.message : error})`,
      );
    }

    if (response.status === 422) {
      const body = (await response.json()) as { detail?: string; incidents?: Array<{ type: string }> };
      const types = [...new Set((body.incidents ?? []).map((i) => i.type))].join(', ');
      throw new Error(`Server rejected the payload as containing PII (${types}). Nothing was processed.`);
    }
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}. Is it running at ${this.options.serverUrl}?`);
    }

    return (await response.json()) as StepResponse;
  }

  private async executeStep(
    response: StepResponse,
    elements: WireElement[],
    callbacks: AgentCallbacks,
    report: StepReport,
    preApproved: boolean,
    /** What the history should record as typed, when not the response's own text. */
    historyText?: string,
  ): Promise<void> {
    const element = elements.find((e) => e.id === response.element_id);

    // Gate 4: a real value only goes into a field that asks for that kind of value.
    // Skipped for an answer the user just typed for this very field.
    if (!preApproved && (response.action === 'type' || response.action === 'select')) {
      const carried = response.action === 'type' ? (response.text ?? '') : (response.option ?? '');
      const verdict = checkValueTarget(carried, element, this.vault);
      if (!verdict.ok) {
        const proceed = await callbacks.confirm(verdict.question);
        this.throwIfStopped();
        if (!proceed) {
          this.remember({
            action: response.action,
            element_id: response.element_id,
            ok: false,
            error: `refused: the user's ${verdict.valueType} value does not belong in this field`,
          });
          callbacks.onLog(
            `Blocked: your ${friendlyType(verdict.valueType)} was not typed into a field that did not ask for it.`,
            'err',
          );
          callbacks.onStep(report);
          return;
        }
      }
    }

    // Enter in a form field submits the form — the same irreversible step as the
    // Submit button, so it gets the same question.
    if (!preApproved && response.action === 'key' && (response.key ?? 'Enter') === 'Enter' && enterSubmits(element)) {
      const where = element?.label ?? element?.placeholder ?? 'the focused field';
      const proceed = await callbacks.confirm(`Press Enter in “${where}”? That submits the form.`);
      this.throwIfStopped();
      if (!proceed) {
        this.remember({ action: 'key', element_id: response.element_id, ok: false, error: 'user declined submitting' });
        callbacks.onStatus('idle', 'stopped by you');
        callbacks.onLog('Declined: Enter was not pressed.');
        throw new AgentStopped();
      }
    }

    // Gate 2: irreversible actions need a human, whatever the model says.
    if (!preApproved && response.action === 'click' && isIrreversible(element)) {
      const label = element?.text ?? element?.label ?? `element ${response.element_id}`;
      const proceed = await callbacks.confirm(`Press "${label}"? This cannot be undone.`);
      this.throwIfStopped();
      if (!proceed) {
        this.remember({
          action: 'click',
          element_id: response.element_id,
          ok: false,
          error: 'user declined an irreversible action',
        });
        callbacks.onStatus('idle', 'stopped by you');
        callbacks.onLog(`Declined: "${label}" was not pressed.`);
        throw new AgentStopped();
      }
    }

    let action: ResolvedAction;
    try {
      action = this.resolve(response, report.output.imageScale);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.remember({
        action: response.action,
        element_id: response.element_id,
        ok: false,
        error: message,
      });
      callbacks.onLog(message, 'err');
      callbacks.onStep(report);
      return;
    }

    const executeStart = performance.now();
    let result: ActionResult;
    try {
      result = await sendToBackground<ActionResult>({
        kind: 'execute',
        tabId: report.output.request.step >= 0 ? await this.activeTabId() : 0,
        action,
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    report.output.timings.execute = Math.round((performance.now() - executeStart) * 10) / 10;

    if (response.element_id !== undefined) this.attempted.add(response.element_id);

    this.remember({
      action: response.action,
      element_id: response.element_id,
      // The token, never the resolved value — history goes back to the server.
      text: historyText ?? response.text,
      ok: result.ok,
      error: result.error,
    });

    report.result = result;
    callbacks.onStep(report);
    if (!result.ok) callbacks.onLog(`Action failed: ${result.error}`, 'err');
  }

  /**
   * Go somewhere. Same-site links are followed without asking — that is most
   * multi-page forms — while leaving the site needs the user's say-so, and only
   * http(s) is ever opened. Tokens in a URL are never resolved: a model cannot put a
   * vault value into a query string and have us deliver it to someone's server.
   */
  private async navigate(response: StepResponse, output: PipelineOutput, callbacks: AgentCallbacks): Promise<void> {
    const raw = (response.url ?? '').trim();
    const here = `${output.request.page.origin}${output.request.page.path}`;
    const tabId = await this.activeTabId();

    if (!raw || raw.toLowerCase() === 'back') {
      const result = await sendToBackground<{ url: string }>({ kind: 'navigate', tabId, url: 'back' })
        .then(() => ({ ok: true as const }))
        .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      this.remember({ action: 'navigate', ok: result.ok, error: result.ok ? undefined : result.error });
      callbacks.onLog(result.ok ? '✓ went back' : `Could not go back: ${result.error}`, result.ok ? 'info' : 'err');
      await sleep(1500);
      return;
    }

    let target: URL;
    try {
      target = new URL(raw, here);
    } catch {
      this.remember({ action: 'navigate', ok: false, error: 'not a valid URL' });
      callbacks.onLog(`Refused to navigate: "${raw.slice(0, 80)}" is not a valid URL.`, 'err');
      return;
    }
    if (!/^https?:$/.test(target.protocol) || new RegExp(TOKEN_PATTERN.source).test(decodeURIComponent(target.href))) {
      this.remember({ action: 'navigate', ok: false, error: 'only plain http(s) links are allowed' });
      callbacks.onLog('Refused to navigate: only plain http(s) links, with no tokens in them, are allowed.', 'err');
      return;
    }
    if (target.origin !== output.request.page.origin) {
      const proceed = await callbacks.confirm(`Leave ${output.request.page.origin} and open ${target.origin}?`);
      this.throwIfStopped();
      if (!proceed) {
        this.remember({ action: 'navigate', ok: false, error: 'user declined leaving the site' });
        callbacks.onLog(`Declined: stayed on ${output.request.page.origin}.`);
        return;
      }
    }

    await sendToBackground({ kind: 'navigate', tabId, url: target.href });
    this.remember({ action: 'navigate', ok: true });
    callbacks.onLog(`✓ opened ${target.origin}${target.pathname}`);
    await sleep(1500);
  }

  private async activeTabId(): Promise<number> {
    if (this.options.targetTabId !== undefined) return this.options.targetTabId;
    const tab = await sendToBackground<{ id: number }>({ kind: 'activeTab' });
    return tab.id;
  }

  /**
   * Gate 1: turn the server's tokenized action into a real one.
   * Refuses rather than typing a token we cannot resolve.
   */
  private resolve(response: StepResponse, imageScale: number): ResolvedAction {
    // An id above VISION_ID_BASE names a control the *detector* found, which has no
    // DOM element behind it. The only way to reach it is by coordinate, so a click
    // becomes a click at its centre and a type becomes a click-then-type.
    const detected =
      response.element_id !== undefined && response.element_id >= VISION_ID_BASE
        ? this.visionElements.find((e) => e.id === response.element_id)
        : undefined;

    if (detected) {
      const x = Math.round(detected.bbox.x + detected.bbox.w / 2);
      const y = Math.round(detected.bbox.y + detected.bbox.h / 2);

      if (response.action === 'type') {
        const text = response.text ?? '';
        if (this.vault.hasUnresolvedTokens(text)) {
          throw new Error(
            `Refused to type: the server asked for a value we do not hold (${text}).`,
          );
        }
        return { kind: 'type_xy', x, y, text: this.vault.resolve(text) };
      }
      if (response.action === 'click') return { kind: 'click_xy', x, y };
      throw new Error(
        `Action "${response.action}" cannot be performed on a detected control (id ${response.element_id})`,
      );
    }

    const base = {
      elementId: response.element_id,
      option: response.option,
      direction: response.direction,
      amount: response.amount,
      key: response.key,
    };

    switch (response.action) {
      case 'type': {
        const text = response.text ?? '';
        if (this.vault.hasUnresolvedTokens(text)) {
          throw new Error(
            `Refused to type: the server asked for a value we do not hold (${text}). ` +
              `Add it to your profile if you want this filled.`,
          );
        }
        return { ...base, kind: 'type', text: this.vault.resolve(text) };
      }
      case 'click':
        return { ...base, kind: 'click' };
      case 'click_xy': {
        // The server saw a possibly downscaled image; the page works in CSS pixels.
        const scale = imageScale || 1;
        return {
          ...base,
          kind: 'click_xy',
          x: Math.round((response.x ?? 0) / scale),
          y: Math.round((response.y ?? 0) / scale),
        };
      }
      case 'select': {
        // An option may itself be a token (a profile choice, or an answer the user
        // gave for a sensitive dropdown); it is resolved here like typed text.
        const option = response.option ?? '';
        if (this.vault.hasUnresolvedTokens(option)) {
          throw new Error(`Refused to select: the server asked for a value we do not hold (${option}).`);
        }
        return { ...base, kind: 'select', option: this.vault.resolve(option) };
      }
      case 'scroll':
        return { ...base, kind: 'scroll' };
      case 'key':
        return { ...base, kind: 'key' };
      default:
        throw new Error(`Action "${response.action}" cannot be executed on the page`);
    }
  }
}

/** A button we will not press without a human saying so. */
export function isIrreversible(element: WireElement | undefined): boolean {
  if (!element) return false;
  const label = `${element.text ?? ''} ${element.label ?? ''}`.toLowerCase();
  if (element.type === 'submit') return true;
  return IRREVERSIBLE_HINTS.some((hint) => label.includes(hint));
}

export function describeAction(response: StepResponse): string {
  switch (response.action) {
    case 'type':
      // The token is safe to display; the resolved value is not.
      return `type ${response.text} into element ${response.element_id}`;
    case 'click':
      return `click element ${response.element_id}`;
    case 'click_xy':
      return `click at (${response.x}, ${response.y})`;
    case 'select':
      return `select "${response.option}" in element ${response.element_id}`;
    case 'scroll':
      return `scroll ${response.direction ?? 'down'}`;
    case 'key':
      return `press ${response.key}`;
    case 'navigate':
      return response.url && response.url !== 'back' ? `open ${response.url}` : 'go back';
    case 'wait':
      return `wait ${response.ms ?? 800} ms`;
    case 'ask_user':
      return 'ask the user';
    case 'done':
      return 'done';
    default:
      return response.action;
  }
}

/** Fake profile for the demo button. Re-exported so the panel has one import. */
export { DEMO_PROFILE };
