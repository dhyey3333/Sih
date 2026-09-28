/**
 * Learning on submit, the page half (D40).
 *
 * Watches for the user — never the agent, never the page's own script — typing into
 * a form and submitting it, reads what they typed, and shows one prompt: "Remember
 * what you typed?" The decision about *what* is worth offering is lib/pii/offer.ts;
 * this file only reads the DOM and draws the prompt.
 *
 * Three rules keep a hostile page from using it:
 *   - Only fields that received a *trusted* keystroke or choice are read. The agent
 *     types with synthetic events, so an agent-filled form is never offered back.
 *   - A value is offered only if it is still what the user typed. A page that swaps a
 *     field's value after the user typed it — to plant its own number in their vault —
 *     gets nothing offered for that field.
 *   - The prompt's buttons ignore untrusted clicks: a page cannot say yes for the user.
 * The prompt lives in a closed shadow root and names fields, never values.
 */

import type { LearnOffer } from '../messaging';
import { classifyField } from '../pii/dom-heuristics';
import { offerFromFields, type FieldReading, type LearnItem } from '../pii/offer';
import { accessibleName, roleOf } from './accessibility';
import { descriptorFor } from './snapshot';

/** Words on a button that sends a form, including the SPA "Continue" that never submits one. */
const SUBMIT_WORDS =
  /\b(submit|save|continue|next|proceed|register|sign\s*up|apply|send|confirm|update|log\s*in|sign\s*in|finish|done)\b|जमा|आगे|सहेजें|भेजें/i;

const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export interface LearnHooks {
  /** Hand the items to the background; resolves to an offer to show, or null. */
  offer: (items: LearnItem[]) => Promise<LearnOffer | null>;
  answer: (offer: LearnOffer, yes: boolean) => Promise<void>;
}

function fieldOf(event: Event): HTMLElement | null {
  const target = event.composedPath()[0];
  return target instanceof Element && FIELD_TAGS.has(target.tagName) ? (target as HTMLElement) : null;
}

const CHOICE_TYPES = new Set(['radio', 'checkbox', 'file', 'range', 'color']);

function isTextLike(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !CHOICE_TYPES.has(((el as HTMLInputElement).type ?? '').toLowerCase());
}

function currentValue(el: HTMLElement): string {
  if (el.tagName === 'SELECT') {
    const select = el as HTMLSelectElement;
    return select.selectedIndex >= 0 ? (select.options[select.selectedIndex]?.text ?? '').trim() : '';
  }
  const input = el as HTMLInputElement;
  if (input.type === 'radio') return input.checked ? accessibleName(input) : '';
  if (input.type === 'checkbox') return '';
  return input.value ?? '';
}

function read(el: HTMLElement, value: string): FieldReading | null {
  const input = el as HTMLInputElement;
  const type = (input.type ?? '').toLowerCase();
  if (type === 'password' || type === 'checkbox') return null;
  const label = type === 'radio' ? undefined : accessibleName(el);
  const reading: FieldReading = {
    role: roleOf(el),
    value,
    ...(label ? { label } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    ...(type ? { inputType: type } : {}),
  };
  if (type === 'radio') {
    const group = el.getAttribute('name');
    if (!group) return null;
    reading.group = group.slice(0, 60);
  }
  const classified = classifyField(descriptorFor(el, label ?? ''));
  if (classified) reading.sensitive = classified.type;
  return reading;
}

export function installLearnOnSubmit(hooks: LearnHooks): { showPending: (offer: LearnOffer) => void } {
  /** Field → the value the user's last trusted keystroke left in it. */
  const typed = new Map<HTMLElement, string>();
  let lastOfferAt = 0;
  /** "Not now" means not on this page again, not a prompt at every step of a wizard. */
  let declined = false;

  const note = (event: Event) => {
    if (!event.isTrusted) return;
    const el = fieldOf(event);
    if (!el) return;
    // For a text field only a keystroke counts. The `change` the browser fires when a
    // text field loses focus is trusted too — and carries whatever value the field
    // holds by then, including one the page wrote after the user typed. That laundered
    // a planted value into the offer in our own test; a choice (select, radio) is the
    // one place `change` *is* the user's act.
    if (event.type === 'change' && isTextLike(el)) return;
    typed.set(el, currentValue(el));
  };
  document.addEventListener('input', note, true);
  document.addEventListener('change', note, true);

  const offer = (scope: Element | null) => {
    if (declined || Date.now() - lastOfferAt < 1500) return; // a click and the submit it causes are one
    const readings: FieldReading[] = [];
    for (const [el, value] of typed) {
      if (!el.isConnected || (scope && !scope.contains(el))) continue;
      // Still what the user typed? If the page changed it since, it is not theirs to offer.
      if (currentValue(el) !== value) continue;
      const reading = read(el, value);
      if (reading) readings.push(reading);
    }
    const items = offerFromFields(readings);
    if (items.length === 0) return;
    lastOfferAt = Date.now();
    void hooks.offer(items).then((o) => o && show(o)).catch(() => {});
  };

  document.addEventListener('submit', (event) => {
    offer(event.target instanceof Element ? event.target : null);
  }, true);

  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) return;
    const button = target.closest('button, [role="button"], input[type="submit"], input[type="button"]');
    if (!button) return;
    const words = `${button.textContent ?? ''} ${(button as HTMLInputElement).value ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
    if (!SUBMIT_WORDS.test(words)) return;
    offer(button.closest('form'));
  }, true);

  const show = (o: LearnOffer) =>
    showLearnPrompt(o, async (yes) => {
      if (!yes) declined = true;
      await hooks.answer(o, yes);
    });

  return { showPending: show };
}

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

const PROMPT_CSS = `
  :host { all: initial; }
  .card {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: min(340px, calc(100vw - 40px)); box-sizing: border-box;
    padding: 14px 16px; border-radius: 14px;
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #e8ebf2; background: #161a22; border: 1px solid #2a3140;
    box-shadow: 0 12px 32px rgba(0,0,0,.35);
    animation: in .25s ease-out;
  }
  @keyframes in { from { opacity: 0; translate: 0 10px; } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  .head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; }
  .mark { width: 18px; height: 18px; flex: none; color: #5b9cff; }
  p { margin: 6px 0 12px; color: #aab2c2; }
  .row { display: flex; gap: 8px; }
  button {
    flex: 1; padding: 8px 10px; border-radius: 9px; border: 1px solid #2a3140;
    font: 600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
    color: #e8ebf2; background: #1f2530;
  }
  button.yes { color: #fff; background: #2f6bff; border-color: #2f6bff; }
  button:focus-visible { outline: 2px solid #5b9cff; outline-offset: 2px; }
`;

const SHIELD =
  'M12 2.5 4.5 5.8v5.9c0 4.6 3.1 8.9 7.5 10 4.4-1.1 7.5-5.4 7.5-10V5.8L12 2.5Z';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function showLearnPrompt(offer: LearnOffer, onAnswer: (yes: boolean) => Promise<void>): void {
  document.querySelector('privagent-learn')?.remove();
  const host = document.createElement('privagent-learn');
  // Closed: the page cannot reach in, and the prompt names fields, never values.
  const root = host.attachShadow({ mode: 'closed' });

  const ns = 'http://www.w3.org/2000/svg';
  const mark = document.createElementNS(ns, 'svg');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('class', 'mark');
  mark.setAttribute('fill', 'none');
  mark.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', SHIELD);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  mark.append(path);

  const yes = el('button', { className: 'yes', type: 'button', textContent: 'Remember' });
  const no = el('button', { type: 'button', textContent: 'Not now' });
  const text = el('p', {
    textContent: `PrivAgent can fill your ${offer.summary} for you next time. It stays on this device, encrypted — nothing is sent.`,
  });
  const card = el('div', { className: 'card' }, el('div', { className: 'head' }, mark, 'Remember what you typed?'), text, el('div', { className: 'row' }, yes, no));
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'PrivAgent: remember what you typed?');
  root.append(el('style', { textContent: PROMPT_CSS }), card);
  (document.body ?? document.documentElement).append(host);

  // Unanswered, it steps aside; the offer itself expires in the background.
  const timer = setTimeout(() => host.remove(), 25_000);
  const settle = (answer: boolean) => async (event: MouseEvent) => {
    if (!event.isTrusted) return; // a page cannot answer for the user
    clearTimeout(timer);
    yes.disabled = no.disabled = true;
    await onAnswer(answer).catch(() => {});
    if (!answer) {
      host.remove();
      return;
    }
    text.textContent = 'Saved on this device. PrivAgent will fill these in for you.';
    card.querySelector('.row')?.remove();
    setTimeout(() => host.remove(), 2600);
  };
  yes.addEventListener('click', settle(true));
  no.addEventListener('click', settle(false));
}
