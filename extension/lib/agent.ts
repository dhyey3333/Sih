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
 */

import { DEMO_PROFILE } from './demo-profile';
import { planLocally } from './local-planner';
import { sendToBackground, type ActionResult, type PerceiveResult, type ResolvedAction } from './messaging';
import { runPipeline, type PipelineOutput } from './pipeline';
import {
  IRREVERSIBLE_HINTS,
  type HistoryEntry,
  type StepRequest,
  type StepResponse,
  type WireElement,
} from './protocol';
import type { Vault } from './pii/vault';
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
          knownValues: this.vault.needles(),
        });
        this.throwIfStopped();

        const output = await this.sanitize(perceived, task, step);
        callbacks.onPerceived(output);

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
          callbacks.onLog(
            `${response.planner ?? 'server'} → ${describeAction(response)}` +
              (response.reason ? ` — ${response.reason}` : ''),
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
          const proceed = await callbacks.confirm(question);
          this.throwIfStopped();

          if (!proceed) {
            this.history.push({ action: 'ask_user', ok: false, error: 'declined by user' });
            callbacks.onStatus('idle', 'stopped by you');
            callbacks.onLog('You declined. Stopping.');
            return;
          }
          // Approval of an ask_user that names an element means "do it".
          if (response.element_id === undefined) {
            this.history.push({ action: 'ask_user', ok: true });
            continue;
          }
          const approved: StepResponse = { ...response, action: 'click' };
          await this.executeStep(approved, output.request.elements, callbacks, report, true);
          await sleep(this.options.settleMs ?? 700);
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
    const response = await fetch(`${this.options.serverUrl.replace(/\/$/, '')}/v1/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

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
  ): Promise<void> {
    const element = elements.find((e) => e.id === response.element_id);

    // Gate 2: irreversible actions need a human, whatever the model says.
    if (!preApproved && response.action === 'click' && isIrreversible(element)) {
      const label = element?.text ?? element?.label ?? `element ${response.element_id}`;
      const proceed = await callbacks.confirm(`Press "${label}"? This cannot be undone.`);
      this.throwIfStopped();
      if (!proceed) {
        this.history.push({
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
      this.history.push({
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

    this.history.push({
      action: response.action,
      element_id: response.element_id,
      // The token, never the resolved value — history goes back to the server.
      text: response.text,
      ok: result.ok,
      error: result.error,
    });

    report.result = result;
    callbacks.onStep(report);
    if (!result.ok) callbacks.onLog(`Action failed: ${result.error}`, 'err');
  }

  private async activeTabId(): Promise<number> {
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
      case 'select':
        return { ...base, kind: 'select' };
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
