/**
 * Typed message bus.
 *
 * Three contexts talk to each other: the side panel (UI + models), the background
 * service worker (orchestrator, the only thing allowed to capture a tab) and the
 * content script (the only thing that can touch the page). Everything is
 * request/response so callers can await a result instead of wiring up listeners.
 */

import type { DomSnapshot, PiiType, StageTimings } from './protocol';

export interface ResolvedAction {
  /** Token-free: the vault has already swapped tokens for real values. */
  /**
   * `type_xy` exists for controls the vision detector found in pixels: there is no
   * DOM element to focus, so the content script clicks the point first and types
   * into whatever that focused.
   */
  kind: 'click' | 'click_xy' | 'type' | 'type_xy' | 'select' | 'scroll' | 'key' | 'focus';
  elementId?: number;
  x?: number;
  y?: number;
  text?: string;
  option?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  key?: string;
  /** Clear the field before typing. */
  replace?: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Human-readable description of what happened, for the activity log. */
  detail?: string;
}

export interface PerceiveResult {
  snapshot: DomSnapshot;
  /**
   * `data:image/jpeg;base64,...` of the visible tab, in **device** pixels.
   * The side panel measures it on decode; the background has no DOM to do so.
   */
  imageDataUrl: string;
  tabId: number;
  timings: StageTimings;
}

/** Side panel → background. */
export type BackgroundRequest =
  | { kind: 'perceive'; tabId?: number; knownValues?: Array<{ value: string; type: PiiType }> }
  | { kind: 'execute'; tabId: number; action: ResolvedAction }
  | { kind: 'activeTab' }
  | { kind: 'navigate'; tabId: number; url: string };

/** Background → content script. */
export type ContentRequest =
  | {
      kind: 'snapshot';
      maxElements?: number;
      /**
       * Values from the vault to locate on screen, so the user's own name and
       * address get a redaction box and not just a token. See docs/DECISIONS.md.
       */
      knownValues?: Array<{ value: string; type: PiiType }>;
    }
  | { kind: 'execute'; action: ResolvedAction }
  | { kind: 'ping' };

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

export function ok<T>(data: T): Response<T> {
  return { ok: true, data };
}

export function fail(error: unknown): Response<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Unwrap a Response, throwing on failure so callers can use try/catch. */
export function unwrap<T>(response: Response<T> | undefined): T {
  if (!response) throw new Error('No response — the receiving context is not loaded');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export async function sendToBackground<T>(request: BackgroundRequest): Promise<T> {
  return unwrap<T>(await browser.runtime.sendMessage(request));
}

export async function sendToTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  return unwrap<T>(await browser.tabs.sendMessage(tabId, request));
}
