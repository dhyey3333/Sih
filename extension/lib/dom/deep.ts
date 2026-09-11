/**
 * Traversal that does not stop at a boundary the platform puts in the way.
 *
 * Two of those exist, and both used to make a whole class of page invisible to the
 * DOM layer — not "partly covered", *invisible*: no field classified, nothing
 * redacted, nothing for the agent to act on, while the values sat in the screenshot
 * exactly as before.
 *
 *  1. **Shadow roots.** `document.querySelectorAll` does not enter one and a
 *     `TreeWalker` will not cross into one. Most design systems, and a growing
 *     number of government and banking portals, build their forms from web
 *     components.
 *  2. **Same-origin frames.** A great many portals put the form itself in an
 *     `<iframe>`. The content script runs in the top frame only, so the form was
 *     simply not there as far as perception was concerned.
 *
 * What cannot be reached, and is reported rather than glossed over:
 *
 *  * **Closed shadow roots.** `attachShadow({mode: 'closed'})` withholds the root
 *    from every caller by design.
 *  * **Cross-origin frames.** Same-origin policy, correctly. `opaqueFrames()`
 *    returns their rects so the pipeline can paint over a region it was unable to
 *    inspect, rather than shipping pixels it never read.
 *
 * ## Coordinates
 *
 * A `Scope` carries the offset from *its* viewport to the **top-level** viewport, in
 * CSS pixels. A shadow root shares its host document's coordinate space, so it
 * inherits the offset unchanged; a frame's content starts at the frame's content-box
 * origin, so it adds one. Every rect read inside a scope must have that offset added
 * exactly once — the same discipline `Rect` already asks for with `dpr`.
 */

export interface Scope {
  root: ParentNode & Node;
  /** CSS pixels to add to a rect read inside this scope. */
  dx: number;
  dy: number;
}

export interface DeepMatch {
  el: Element;
  dx: number;
  dy: number;
}

const MAX_SCOPES = 200;

/**
 * Every reachable scope under `root`, starting with `root` itself: open shadow
 * roots, same-origin frame documents, and both nested inside each other.
 */
export function scopesUnder(root: ParentNode & Node): Scope[] {
  const scopes: Scope[] = [{ root, dx: 0, dy: 0 }];

  for (let i = 0; i < scopes.length && scopes.length < MAX_SCOPES; i++) {
    const scope = scopes[i]!;

    for (const el of scope.root.querySelectorAll('*')) {
      if (scopes.length >= MAX_SCOPES) break;

      // A shadow root is laid out in its host's coordinate space.
      if (el.shadowRoot) {
        scopes.push({ root: el.shadowRoot, dx: scope.dx, dy: scope.dy });
        continue;
      }

      // Tag test: a frame nested inside a frame belongs to the outer frame's realm,
      // where `instanceof HTMLIFrameElement` is false.
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const inner = sameOriginDocument(el as FrameLike);
        if (!inner) continue;
        const origin = contentOrigin(el);
        scopes.push({ root: inner, dx: scope.dx + origin.x, dy: scope.dy + origin.y });
      }
    }
  }

  return scopes;
}

/** `querySelectorAll` across every reachable scope, each match carrying its offset. */
export function deepQueryAll(root: ParentNode & Node, selector: string): DeepMatch[] {
  const out: DeepMatch[] = [];
  for (const scope of scopesUnder(root)) {
    for (const el of scope.root.querySelectorAll(selector)) {
      out.push({ el, dx: scope.dx, dy: scope.dy });
    }
  }
  return out;
}

/**
 * Rects, in top-level viewport CSS pixels, of every frame we could **not** look
 * inside. The pipeline paints over these: a region that was never inspected must not
 * be sent as pixels, because "we found nothing in it" would be a claim we cannot make.
 */
export function opaqueFrames(root: ParentNode & Node): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];

  for (const scope of scopesUnder(root)) {
    for (const el of scope.root.querySelectorAll('iframe, frame, embed, object')) {
      if (
        (el.tagName === 'IFRAME' || el.tagName === 'FRAME') &&
        sameOriginDocument(el as FrameLike)
      ) {
        continue; // readable, and therefore already scanned
      }

      const rect = el.getBoundingClientRect();
      // Tracking pixels and 0×0 frames carry nothing anyone can read.
      if (rect.width < 24 || rect.height < 24) continue;

      out.push({
        x: rect.left + scope.dx,
        y: rect.top + scope.dy,
        w: rect.width,
        h: rect.height,
      });
    }
  }

  return out;
}

/**
 * The frame's document, or null when it is cross-origin.
 *
 * Reading `contentDocument` across origins throws in some engines and returns null in
 * others, so both are treated as "cannot see in there".
 */
type FrameLike = Element & { contentDocument?: Document | null };

function sameOriginDocument(frame: FrameLike): Document | null {
  try {
    const doc = frame.contentDocument;
    return doc?.body ? doc : null;
  } catch {
    return null;
  }
}

/** Top-left of a frame's *content* box, in its parent's coordinates. */
function contentOrigin(frame: Element): { x: number; y: number } {
  const rect = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  return {
    x: rect.left + parseFloat(style.borderLeftWidth || '0') + parseFloat(style.paddingLeft || '0'),
    y: rect.top + parseFloat(style.borderTopWidth || '0') + parseFloat(style.paddingTop || '0'),
  };
}
