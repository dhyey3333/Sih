/**
 * Content script: the only part of PrivAgent that touches the page.
 *
 * Two jobs:
 *   1. Hand back a DOM snapshot (built by lib/dom/snapshot.ts).
 *   2. Execute an action the agent decided on, with tokens already resolved.
 *
 * It never talks to the network, and it never sees a token — the vault lives in
 * the side panel and hands this script finished text.
 */

import { buildSnapshot } from '../lib/dom/snapshot';
import { fail, ok, type ActionResult, type ContentRequest, type ResolvedAction } from '../lib/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false,
  runAt: 'document_idle',
  main() {
    /** id → element for the current snapshot. Rebuilt on every snapshot. */
    const registry = new Map<number, Element>();

    browser.runtime.onMessage.addListener((message: ContentRequest) => {
      try {
        switch (message.kind) {
          case 'ping':
            return Promise.resolve(ok({ url: location.href }));
          case 'snapshot':
            return Promise.resolve(
              ok(
                buildSnapshot({
                  registry,
                  maxElements: message.maxElements ?? 160,
                  knownValues: message.knownValues,
                }),
              ),
            );
          case 'execute':
            return Promise.resolve(ok(executeAction(registry, message.action)));
          default:
            return Promise.resolve(fail(`Unknown message: ${JSON.stringify(message)}`));
        }
      } catch (error) {
        return Promise.resolve(fail(error));
      }
    });
  },
});

function resolveElement(registry: Map<number, Element>, id: number | undefined): Element {
  if (id === undefined) throw new Error('Action is missing element_id');
  const el = registry.get(id);
  if (!el) throw new Error(`Element ${id} is not in the current snapshot`);
  if (!el.isConnected) throw new Error(`Element ${id} was removed from the page`);
  return el;
}

/**
 * React, Vue and friends track input state internally and ignore a plain
 * `el.value = x`. Going through the prototype's native setter updates the real
 * DOM value; the synthetic `input`/`change` events then let the framework observe
 * it. This is the single most common reason a browser agent "types" into a field
 * and the app behaves as if it is still empty.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatchInputEvents(el: Element, value: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function executeAction(registry: Map<number, Element>, action: ResolvedAction): ActionResult {
  switch (action.kind) {
    case 'click': {
      const el = resolveElement(registry, action.elementId);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      (el as HTMLElement).focus?.({ preventScroll: true });
      (el as HTMLElement).click();
      return { ok: true, detail: `clicked element ${action.elementId}` };
    }

    case 'click_xy': {
      const { x = 0, y = 0 } = action;
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`Nothing at (${x}, ${y})`);
      (target as HTMLElement).click();
      return { ok: true, detail: `clicked at (${x}, ${y})` };
    }

    case 'type_xy': {
      // For a control the vision layer found in pixels. A canvas app has no element
      // to focus, so click the point and let the page decide what receives the keys —
      // usually a hidden input the app maintains for exactly this.
      const { x = 0, y = 0 } = action;
      const text = action.text ?? '';
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!target) throw new Error(`Nothing at (${x}, ${y})`);
      target.click();
      target.focus?.({ preventScroll: true });

      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        setNativeValue(active, text);
        dispatchInputEvents(active, text);
      } else {
        // Nothing focusable took it: synthesise key events at the point instead.
        for (const char of text) {
          const init: KeyboardEventInit = { key: char, bubbles: true, cancelable: true };
          target.dispatchEvent(new KeyboardEvent('keydown', init));
          target.dispatchEvent(new KeyboardEvent('keypress', init));
          target.dispatchEvent(new KeyboardEvent('keyup', init));
        }
      }
      // Length only — never the text itself.
      return { ok: true, detail: `typed ${text.length} chars at (${x}, ${y})` };
    }

    case 'focus': {
      const el = resolveElement(registry, action.elementId);
      (el as HTMLElement).focus?.({ preventScroll: false });
      return { ok: true, detail: `focused element ${action.elementId}` };
    }

    case 'type': {
      const el = resolveElement(registry, action.elementId);
      const text = action.text ?? '';
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      (el as HTMLElement).focus?.({ preventScroll: true });

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const next = action.replace === false ? el.value + text : text;
        setNativeValue(el, next);
        dispatchInputEvents(el, text);
      } else if (el.getAttribute('contenteditable') !== null) {
        (el as HTMLElement).textContent =
          action.replace === false ? `${el.textContent ?? ''}${text}` : text;
        dispatchInputEvents(el, text);
      } else {
        throw new Error(`Element ${action.elementId} is not editable`);
      }
      // Length only — never the text itself (CLAUDE.md: never log raw PII).
      return { ok: true, detail: `typed ${text.length} chars into element ${action.elementId}` };
    }

    case 'select': {
      const el = resolveElement(registry, action.elementId);
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error(`Element ${action.elementId} is not a <select>`);
      }
      const wanted = (action.option ?? '').trim().toLowerCase();
      const option =
        [...el.options].find((o) => o.value.toLowerCase() === wanted) ??
        [...el.options].find((o) => o.text.trim().toLowerCase() === wanted) ??
        [...el.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
      if (!option) throw new Error(`No option matching "${action.option}"`);
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `selected "${option.text.trim()}"` };
    }

    case 'scroll': {
      const amount = action.amount ?? Math.round(window.innerHeight * 0.8);
      const deltas: Record<string, [number, number]> = {
        down: [0, amount],
        up: [0, -amount],
        right: [amount, 0],
        left: [-amount, 0],
      };
      const [dx, dy] = deltas[action.direction ?? 'down'] ?? [0, amount];
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
      return { ok: true, detail: `scrolled ${action.direction ?? 'down'} ${Math.abs(dy || dx)}px` };
    }

    case 'key': {
      const key = action.key ?? 'Enter';
      const target = (
        action.elementId !== undefined ? resolveElement(registry, action.elementId) : document.activeElement
      ) as HTMLElement | null;
      if (!target) throw new Error('No focused element for key press');
      const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { ok: true, detail: `pressed ${key}` };
    }

    default:
      throw new Error(`Unsupported action: ${(action as ResolvedAction).kind}`);
  }
}
