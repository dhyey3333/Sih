/**
 * Accessible names and roles.
 *
 * The label is what the VLM actually reasons over — "Aadhaar number" vs "field 7"
 * is the difference between a working agent and a guessing one — and it is also
 * the context the PII heuristics use. Worth getting right rather than falling
 * back to `element.textContent`.
 *
 * This is a pragmatic subset of the ARIA accname spec: the steps that matter on
 * real forms, in spec order, without the parts that need a full accessibility tree.
 */

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=textbox]',
  '[role=searchbox]',
  '[role=combobox]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=option]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function interactiveSelector(): string {
  return INTERACTIVE_SELECTOR;
}

/**
 * Tag test instead of `instanceof`.
 *
 * An element inside an `<iframe>` belongs to *that frame's* realm, so it is an
 * instance of the frame's `HTMLInputElement`, not of ours — `instanceof` is false
 * for every field in a frame we traverse into (lib/dom/deep.ts). That failure is
 * silent and looks exactly like "the page has no fields", which is the worst shape
 * a bug can take here.
 */
function isTag(el: Element, tag: string): boolean {
  return el.tagName === tag;
}

/** The form properties we read, without asserting which realm the class came from. */
type FormLike = Element & { type?: string; placeholder?: string; value?: string };

function textOf(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** aria-labelledby, resolved against the element's root (handles shadow DOM). */
function labelledByText(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => textOf(root.querySelector?.(`#${CSS.escape(id)}`)))
    .filter(Boolean)
    .join(' ');
}

/** <label for="..."> plus any wrapping <label>. */
function associatedLabelText(el: Element): string {
  const parts: string[] = [];

  if (el.id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    for (const label of root.querySelectorAll?.(`label[for="${CSS.escape(el.id)}"]`) ?? []) {
      parts.push(textOf(label));
    }
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    // Exclude the control's own text so a wrapped <input> doesn't label itself.
    const clone = wrapping.cloneNode(true) as HTMLElement;
    for (const control of clone.querySelectorAll('input, select, textarea')) control.remove();
    parts.push(textOf(clone));
  }

  return parts.filter(Boolean).join(' ');
}

/**
 * A visible text node immediately before the field. Common on hand-rolled forms
 * that never wire up `for`/`id`, which is most Indian government form templates.
 */
function proximityLabelText(el: Element): string {
  const previous = el.previousElementSibling;
  if (previous && !previous.matches(INTERACTIVE_SELECTOR)) {
    const text = textOf(previous);
    if (text && text.length <= 80) return text;
  }

  const parent = el.parentElement;
  if (parent) {
    const own = textOf(parent).slice(0, 80);
    if (own && own.length <= 80) return own;
  }
  return '';
}

/** Anything the user types into: its text content is data, not a name. */
function isTextEntry(el: Element): boolean {
  return (
    el.getAttribute('contenteditable') !== null ||
    el.getAttribute('role') === 'textbox' ||
    isTag(el, 'INPUT') ||
    isTag(el, 'TEXTAREA')
  );
}

export function accessibleName(el: Element): string {
  const ariaLabelledBy = labelledByText(el);
  if (ariaLabelledBy) return ariaLabelledBy;

  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  const associated = associatedLabelText(el);
  if (associated) return associated;

  const form = el as FormLike;
  if (isTag(el, 'INPUT')) {
    if (form.placeholder) return form.placeholder;
    if ((form.type === 'submit' || form.type === 'button' || form.type === 'reset') && form.value) {
      return form.value;
    }
  }
  if (isTag(el, 'TEXTAREA') && form.placeholder) return form.placeholder;

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  // Buttons and links carry their name as content; inputs never do — and neither
  // does a contenteditable, whose content is its *value*. Letting one name itself
  // makes an address box report "14/2 Sardar Patel Marg" as its label, which reads
  // as a field with no label at all and silently defeats every keyword rule.
  if (!isTextEntry(el)) {
    const own = textOf(el);
    if (own && own.length <= 200) return own;
  }

  return proximityLabelText(el);
}

/** Coarse role, matching what the server prompt describes. */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.toLowerCase();

  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (el.getAttribute('contenteditable') !== null) return 'textbox';

  if (isTag(el, 'INPUT')) {
    switch ((el as FormLike).type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'submit':
      case 'button':
      case 'reset':
      case 'image':
        return 'button';
      case 'range':
        return 'slider';
      case 'file':
        return 'file';
      default:
        return 'textbox';
    }
  }
  return tag;
}

/**
 * Visible *and* on screen. `checkVisibility` handles display/visibility/opacity and
 * `content-visibility` in one call; the rect test then drops elements scrolled out
 * of view, which we cannot see in the screenshot anyway.
 *
 * `dx`/`dy` shift the element's rect into the top-level viewport — non-zero only for
 * something found inside a same-origin frame (lib/dom/deep.ts). Visibility has to be
 * judged against the viewport the screenshot covers, not the frame's own.
 */
export function isVisibleInViewport(
  el: Element,
  viewport: { w: number; h: number },
  dx = 0,
  dy = 0,
): boolean {
  const checkable = el as Element & { checkVisibility?: (opts?: object) => boolean };
  if (typeof checkable.checkVisibility === 'function') {
    if (!checkable.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
  }

  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const top = rect.top + dy;
  const left = rect.left + dx;
  return top + rect.height > 0 && left + rect.width > 0 && top < viewport.h && left < viewport.w;
}
