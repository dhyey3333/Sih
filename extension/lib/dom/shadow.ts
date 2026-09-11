/**
 * Traversal that does not stop at a shadow boundary.
 *
 * `document.querySelectorAll` cannot see inside a shadow root, and a `TreeWalker`
 * will not cross into one either. Design systems built on web components — and a
 * growing number of government and banking portals that use them — therefore look
 * to the DOM layer like a page with no form on it at all: the fields are invisible,
 * so nothing is classified, nothing is redacted, and the agent has nothing to act
 * on. The vision layer would still cover a face, but an Aadhaar number typed into a
 * `<gov-input>` would go out in the screenshot.
 *
 * **Closed shadow roots stay invisible**, and nothing can change that from a content
 * script — `attachShadow({mode: 'closed'})` withholds the root from every caller by
 * design. That is a real limit, not an oversight, and it is stated in the docs.
 */

/** Every open shadow root under `root`, in document order, including nested ones. */
export function shadowRootsUnder(root: ParentNode, limit = 200): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const queue: ParentNode[] = [root];

  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()!;
    for (const el of current.querySelectorAll('*')) {
      const shadow = el.shadowRoot;
      if (!shadow) continue;
      found.push(shadow);
      queue.push(shadow);
      if (found.length >= limit) break;
    }
  }

  return found;
}

/**
 * `querySelectorAll` that descends into open shadow roots.
 *
 * Ordering is document order *within* each root, light DOM first. An element inside
 * a shadow root therefore sorts after its host's siblings rather than where it is
 * painted. Element ids only need to be stable and to refer to the right node, so
 * this costs nothing except that "first field in document order" means "first in the
 * light DOM, then the first in each component".
 */
export function deepQueryAll(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  for (const shadow of shadowRootsUnder(root)) {
    out.push(...shadow.querySelectorAll(selector));
  }
  return out;
}
