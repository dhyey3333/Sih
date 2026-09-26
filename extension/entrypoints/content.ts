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

import { formatForInput } from '../lib/dom/input-format';
import { StableIds, buildSnapshot } from '../lib/dom/snapshot';
import { fail, ok, type ActionResult, type ContentRequest, type ResolvedAction } from '../lib/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false,
  runAt: 'document_idle',
  main() {
    /** id → element for the current snapshot. Rebuilt on every snapshot. */
    const registry = new Map<number, Element>();
    /** One per document: an element keeps its id while it exists (lib/dom/snapshot.ts). */
    const stableIds = new StableIds();

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
                  stableIds,
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
 * Tag tests rather than `instanceof`. An element inside a same-origin frame belongs
 * to that frame's realm, where our `HTMLInputElement` is a different class — so
 * `instanceof` is false for every field we traverse into, and a frame-hosted form
 * would report "not editable" on the first keystroke. (Same bug, same fix, as the
 * snapshot's: lib/dom/deep.ts.)
 */
const isInput = (el: Element): el is HTMLInputElement => el.tagName === 'INPUT';
const isTextArea = (el: Element): el is HTMLTextAreaElement => el.tagName === 'TEXTAREA';
const isSelect = (el: Element): el is HTMLSelectElement => el.tagName === 'SELECT';

/**
 * React, Vue and friends track input state internally and ignore a plain
 * `el.value = x`. Going through the prototype's native setter updates the real
 * DOM value; the synthetic `input`/`change` events then let the framework observe
 * it. This is the single most common reason a browser agent "types" into a field
 * and the app behaves as if it is still empty.
 *
 * The setter comes from the element's *own* prototype chain, so a field in a
 * same-origin frame is set with its own realm's setter.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  el.value = value;
}

function dispatchInputEvents(el: Element, value: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function labelTextOf(el: Element): string {
  const input = el as HTMLInputElement;
  const own = [...(input.labels ?? [])].map((l) => l.textContent ?? '').join(' ');
  const wrapping = el.closest('label')?.textContent ?? '';
  return `${own} ${wrapping} ${input.value ?? ''} ${el.getAttribute('aria-label') ?? ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The radio in `radio`'s group whose label or value matches `wanted`. */
function matchingRadio(radio: HTMLInputElement, wanted: string): HTMLInputElement | null {
  const root = radio.form ?? (radio.getRootNode() as Document | ShadowRoot);
  const group = [...root.querySelectorAll('input[type="radio"]')].filter(
    (r) => (r as HTMLInputElement).name === radio.name,
  ) as HTMLInputElement[];
  const w = wanted.trim().toLowerCase();
  return (
    group.find((r) => r.value.toLowerCase() === w) ??
    group.find((r) => labelTextOf(r) === w) ??
    group.find((r) => labelTextOf(r).includes(w)) ??
    null
  );
}

function canScroll(el: Element, dy: number, dx: number): boolean {
  const style = getComputedStyle(el);
  const scrollableY = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
  const scrollableX = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
  if (dy > 0) return scrollableY && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  if (dy < 0) return scrollableY && el.scrollTop > 0;
  if (dx > 0) return scrollableX && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  if (dx < 0) return scrollableX && el.scrollLeft > 0;
  return false;
}

/**
 * Where a scroll should land.
 *
 * Many portals scroll an inner panel — a modal, a table body, an app shell — while
 * the window itself does not move at all, so `window.scrollBy` reports success and
 * nothing on screen changes. Preference order: the nearest scrollable ancestor of
 * the named element; the window, if it can still move that way; the largest visible
 * scrollable region on the page.
 */
function scrollTarget(start: Element | null, dx: number, dy: number): Element | null {
  for (let el = start; el; el = el.parentElement) {
    if (canScroll(el, dy, dx)) return el;
  }
  const root = document.scrollingElement ?? document.documentElement;
  const windowCan =
    dy > 0 ? window.innerHeight + window.scrollY < root.scrollHeight - 1
    : dy < 0 ? window.scrollY > 0
    : dx > 0 ? window.innerWidth + window.scrollX < root.scrollWidth - 1
    : window.scrollX > 0;
  if (windowCan) return null;

  let best: Element | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll('*')) {
    if (!canScroll(el, dy, dx)) continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
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
      if (active && (isInput(active) || isTextArea(active))) {
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

      if (isInput(el) || isTextArea(el)) {
        // A date control only accepts ISO dates; the profile stores them day-first.
        const fitted = isInput(el) ? formatForInput(el.type, text) : text;
        const next = action.replace === false ? el.value + fitted : fitted;
        setNativeValue(el, next);
        dispatchInputEvents(el, fitted);
        if (isInput(el) && next !== '' && el.value === '') {
          // The browser rejected the value (wrong format for this control) and left
          // the field empty. Say so, rather than report success over an empty field.
          // Only emptiness counts: a masked input that re-spaces "223456789018" as
          // "2234 5678 9018" has changed the value too, and that one worked.
          throw new Error(`Element ${action.elementId} rejected the value for an input of type "${el.type}"`);
        }
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
      const wanted = (action.option ?? '').trim().toLowerCase();
      if (!wanted) throw new Error('select needs an option');

      // A radio group is a select written as buttons. The action names any radio in
      // the group; the matching one is clicked, which is what a person would do.
      if (isInput(el) && el.type === 'radio') {
        const radio = matchingRadio(el, wanted);
        if (!radio) throw new Error(`No radio button matching "${action.option}"`);
        radio.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        radio.click();
        return { ok: true, detail: `chose "${action.option}"` };
      }

      if (!isSelect(el)) throw new Error(`Element ${action.elementId} is not a <select>`);
      const option =
        [...el.options].find((o) => o.value.toLowerCase() === wanted) ??
        [...el.options].find((o) => o.text.trim().toLowerCase() === wanted) ??
        [...el.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
      if (!option) throw new Error(`No option matching "${action.option}"`);
      // Native setter plus both events: React's onChange for a <select> is driven by
      // its value tracker, which a plain \`el.value =\` bypasses.
      setNativeValue(el, option.value);
      dispatchInputEvents(el, option.value);
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
      const start = action.elementId !== undefined ? registry.get(action.elementId) ?? null : null;
      const target = scrollTarget(start, dx, dy);
      if (target) {
        target.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
        return { ok: true, detail: `scrolled a page region ${action.direction ?? 'down'} ${Math.abs(dy || dx)}px` };
      }
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
      const down = target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));

      // A synthetic Enter runs the page's own key handlers but never the browser's
      // default action, so a plain form would not submit. Do what the browser would.
      // Submitting is irreversible: the agent has already asked the user before
      // sending an Enter that lands here (lib/agent.ts, gate 2).
      const form = (target as HTMLInputElement).form;
      if (key === 'Enter' && down && form && !isTextArea(target)) {
        form.requestSubmit();
        return { ok: true, detail: 'pressed Enter and submitted the form' };
      }
      return { ok: true, detail: `pressed ${key}` };
    }

    default:
      throw new Error(`Unsupported action: ${(action as ResolvedAction).kind}`);
  }
}
