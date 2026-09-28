/**
 * Background orchestrator.
 *
 * The only context allowed to call `tabs.captureVisibleTab`, so every screenshot
 * goes through here. It moves a JPEG and a DOM snapshot from the page to the side
 * panel, and moves finished actions back. The sanitizer and the egress guard live in
 * the side panel (docs/DECISIONS.md). The one time it holds a value is learning on
 * submit (D40): what the user typed waits here, in memory, until they answer the
 * page's "Remember what you typed?" — the panel may not be open to hold it.
 */

import {
  fail,
  ok,
  type BackgroundRequest,
  type ContentRequest,
  type LearnOffer,
  type PerceiveResult,
  type VaultChangedNotice,
} from '../lib/messaging';
import { describeOffer, newToVault, type LearnItem } from '../lib/pii/offer';
import { Vault } from '../lib/pii/vault';
import { loadBackup, persistBackup } from '../lib/pii/vault-persist';
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

  browser.action?.onClicked?.addListener((tab) => {
    const sidebarAction = (browser as { sidebarAction?: { toggle?: () => void } }).sidebarAction;
    if (sidebarAction?.toggle) {
      sidebarAction.toggle();
      return;
    }
    // Neither a side panel (Chrome, Edge, Brave) nor a sidebar (Firefox): Opera, and
    // any Chromium fork that dropped the API. Open the same panel as a window beside
    // the page, pinned to the tab it was opened from, so the agent acts on the page
    // and not on its own window.
    if (!sidePanel?.setPanelBehavior && tab?.id !== undefined) {
      void browser.windows.create({
        url: browser.runtime.getURL(`/sidepanel.html?tab=${tab.id}`),
        type: 'popup',
        width: 440,
        height: 860,
      });
    }
  });

  // An offer is for the tab it was made in; a closed tab's offer goes with it.
  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(offerKey(tabId)).catch(() => {});
  });

  browser.runtime.onMessage.addListener((message: BackgroundRequest, sender) => {
    const tabId = sender.tab?.id;
    switch (message.kind) {
      case 'learn-offer':
        if (tabId === undefined) return Promise.resolve(fail('An offer comes from a page'));
        return receiveOffer(tabId, message.items).then(ok).catch(fail);
      case 'learn-pending':
        if (tabId === undefined) return Promise.resolve(ok(null));
        return pendingOffer(tabId).then(ok).catch(fail);
      case 'learn-accept':
        if (tabId === undefined) return Promise.resolve(fail('An offer comes from a page'));
        return acceptOffer(tabId, message.id).then(ok).catch(fail);
      case 'learn-dismiss':
        if (tabId === undefined) return Promise.resolve(ok(null));
        return dismissOffer(tabId, message.id).then(() => ok(null)).catch(fail);
      case 'perceive':
        return perceive(message.tabId, message.knownValues).then(ok).catch(fail);
      case 'execute':
        return sendToContent(message.tabId, { kind: 'execute', action: message.action })
          .then(ok)
          .catch(fail);
      case 'activeTab':
        return activeTab().then(ok).catch(fail);
      case 'navigate':
        // "back" is the browser's own history step: it keeps whatever the page's
        // back-navigation keeps, which a reload of the previous URL would not.
        if (message.url === 'back') {
          return browser.tabs.goBack(message.tabId).then(() => ok({ url: 'back' })).catch(fail);
        }
        return browser.tabs
          .update(message.tabId, { url: message.url })
          .then(() => ok({ url: message.url }))
          .catch(fail);
      default:
        return Promise.resolve(fail(`Unknown request: ${JSON.stringify(message)}`));
    }
  });
});

/* ------------------------------------------------------------------ *
 * Learning on submit (D40)
 *
 * The page's prompt shows only field names; the values wait here, in session
 * storage — memory only, never on disk, and not readable by content scripts — until
 * the user says yes or no, or two minutes pass. Held per tab, because a form that
 * submits by navigating takes its page, and the prompt, with it: the next page in
 * the same tab asks for the offer and shows the prompt there.
 * ------------------------------------------------------------------ */

const OFFER_TTL_MS = 2 * 60_000;
const offerKey = (tabId: number) => `privagent.offer.${tabId}`;

interface HeldOffer {
  id: string;
  items: LearnItem[];
  at: number;
}

async function vaultNow(): Promise<Vault> {
  const vault = new Vault();
  vault.restore(await loadBackup());
  return vault;
}

async function heldOffer(tabId: number): Promise<HeldOffer | undefined> {
  const stored = await browser.storage.session.get(offerKey(tabId));
  const held = stored?.[offerKey(tabId)] as HeldOffer | undefined;
  if (held && Date.now() - held.at > OFFER_TTL_MS) {
    await browser.storage.session.remove(offerKey(tabId));
    return undefined;
  }
  return held;
}

const toOffer = (held: HeldOffer): LearnOffer => ({
  id: held.id,
  summary: describeOffer(held.items),
  count: held.items.length,
});

/** Only what the vault does not already hold is offered; nothing new, no prompt. */
async function receiveOffer(tabId: number, items: LearnItem[]): Promise<LearnOffer | null> {
  const fresh = newToVault(items, await vaultNow());
  if (fresh.length === 0) return null;
  const held: HeldOffer = { id: crypto.randomUUID(), items: fresh, at: Date.now() };
  await browser.storage.session.set({ [offerKey(tabId)]: held });
  return toOffer(held);
}

async function pendingOffer(tabId: number): Promise<LearnOffer | null> {
  const held = await heldOffer(tabId);
  return held ? toOffer(held) : null;
}

async function acceptOffer(tabId: number, id: string): Promise<{ saved: number }> {
  const held = await heldOffer(tabId);
  if (!held || held.id !== id) throw new Error('That offer has expired');
  await browser.storage.session.remove(offerKey(tabId));

  const vault = await vaultNow();
  for (const item of held.items) vault.learn(item.label, item.value, item.type);
  // A yes is the agreement to keep it: sealed on the device from here on (D36).
  await persistBackup(vault.backup(), true);
  // The panel, if open, reloads what it holds. If it is closed nothing is listening.
  browser.runtime.sendMessage({ kind: 'vault-changed' } satisfies VaultChangedNotice).catch(() => {});
  return { saved: held.items.length };
}

async function dismissOffer(tabId: number, id: string): Promise<void> {
  const held = await heldOffer(tabId);
  if (held?.id === id) await browser.storage.session.remove(offerKey(tabId));
}

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
