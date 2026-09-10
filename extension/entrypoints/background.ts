/**
 * Background orchestrator.
 *
 * The only context allowed to call `tabs.captureVisibleTab`, so every screenshot
 * goes through here. It holds no PII: it moves a JPEG and a DOM snapshot from the
 * page to the side panel, and moves finished actions back. The vault, the
 * sanitizer and the egress guard all live in the side panel (docs/DECISIONS.md).
 */

import {
  fail,
  ok,
  type BackgroundRequest,
  type ContentRequest,
  type PerceiveResult,
} from '../lib/messaging';
import type { DomSnapshot, PiiType, StageTimings } from '../lib/protocol';

/**
 * Chrome throttles `captureVisibleTab` to roughly two calls per second and starts
 * rejecting past that, which would break the agent loop mid-task. Serialising
 * captures behind a minimum interval is cheaper than handling the failure.
 */
const MIN_CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineBackground(() => {
  // Chrome: the toolbar button opens the side panel directly.
  // Firefox: WXT emits `sidebar_action`, which the browser gives its own button,
  // so we only wire up a toggle for the action click.
  const sidePanel = (globalThis as { chrome?: { sidePanel?: { setPanelBehavior?: (o: object) => Promise<void> } } })
    .chrome?.sidePanel;
  if (sidePanel?.setPanelBehavior) {
    sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      /* not fatal: the user can still open the panel from the extensions menu */
    });
  }

  browser.action?.onClicked?.addListener(() => {
    const sidebarAction = (browser as { sidebarAction?: { toggle?: () => void } }).sidebarAction;
    sidebarAction?.toggle?.();
  });

  browser.runtime.onMessage.addListener((message: BackgroundRequest) => {
    switch (message.kind) {
      case 'perceive':
        return perceive(message.tabId, message.knownValues).then(ok).catch(fail);
      case 'execute':
        return sendToContent(message.tabId, { kind: 'execute', action: message.action })
          .then(ok)
          .catch(fail);
      case 'activeTab':
        return activeTab().then(ok).catch(fail);
      case 'navigate':
        return browser.tabs
          .update(message.tabId, { url: message.url })
          .then(() => ok({ url: message.url }))
          .catch(fail);
      default:
        return Promise.resolve(fail(`Unknown request: ${JSON.stringify(message)}`));
    }
  });
});

async function activeTab(): Promise<{ id: number; url: string; title: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

/**
 * A declared content script is only injected on navigation, so a tab that was
 * already open when the extension loaded has none. Rather than telling the user
 * to reload, inject it on demand and retry.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { kind: 'ping' } satisfies ContentRequest);
    return;
  } catch {
    // Not loaded yet — fall through and inject.
  }

  if (!browser.scripting?.executeScript) {
    throw new Error('Content script not loaded. Reload the page and try again.');
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
  } catch (error) {
    throw new Error(
      `Cannot read this page. Browser-internal pages (chrome://, about:, the web store) ` +
        `are off-limits to extensions. (${error instanceof Error ? error.message : error})`,
    );
  }

  await browser.tabs.sendMessage(tabId, { kind: 'ping' } satisfies ContentRequest);
}

async function sendToContent<T>(tabId: number, request: ContentRequest): Promise<T> {
  await ensureContentScript(tabId);
  const response = (await browser.tabs.sendMessage(tabId, request)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
    | undefined;
  if (!response) throw new Error('Content script did not respond');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function captureTab(windowId: number): Promise<string> {
  const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();

  // JPEG at 85: small enough to keep the upload off the critical path, high
  // enough that the VLM can still read button labels off the image.
  return browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
}

/**
 * One perception pass: screenshot + DOM snapshot of the active tab.
 *
 * The two are captured as close together as possible. If the page scrolls between
 * them, the DOM rects and the pixels disagree and redaction boxes land in the
 * wrong place, so the snapshot is requested first and the capture follows
 * immediately — the snapshot is the slower of the two.
 */
async function perceive(
  explicitTabId?: number,
  knownValues?: Array<{ value: string; type: PiiType }>,
): Promise<PerceiveResult> {
  const startedAt = performance.now();
  const timings: StageTimings = {};

  const tab = explicitTabId
    ? await browser.tabs.get(explicitTabId)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

  if (!tab?.id) throw new Error('No active tab');
  if (tab.url && /^(chrome|edge|about|moz-extension|chrome-extension|devtools):/i.test(tab.url)) {
    throw new Error(
      'Browser-internal pages cannot be read by extensions. Open a normal web page and try again.',
    );
  }

  const snapshotStart = performance.now();
  const snapshot = await sendToContent<DomSnapshot>(tab.id, { kind: 'snapshot', knownValues });
  timings.snapshot = round(performance.now() - snapshotStart);

  const captureStart = performance.now();
  const imageDataUrl = await captureTab(tab.windowId!);
  timings.capture = round(performance.now() - captureStart);
  timings.total = round(performance.now() - startedAt);

  return { snapshot, imageDataUrl, tabId: tab.id, timings };
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
