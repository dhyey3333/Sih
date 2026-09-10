/**
 * Ground-truth extraction, evaluated inside the rendered page.
 *
 * The labels come from the page's own DOM, which is the whole trick: the annotation
 * that drives training is the same `data-pii` attribute the demo site and the eval
 * harness use, so training labels and evaluation ground truth cannot drift apart,
 * and no human ever draws a box.
 *
 * Boxes are returned in CSS pixels relative to the viewport. The caller multiplies
 * by the device pixel ratio to reach screenshot pixels.
 */
() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = [];

  const push = (kind, value, rect) => {
    // Clip to the viewport: the screenshot only contains what is on screen, and a
    // label hanging off the edge teaches the model to hallucinate one there.
    const x0 = Math.max(0, rect.left);
    const y0 = Math.max(0, rect.top);
    const x1 = Math.min(vw, rect.right);
    const y1 = Math.min(vh, rect.bottom);
    if (x1 - x0 < 4 || y1 - y0 < 4) return;
    out.push({ kind, value, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };

  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  /**
   * Where the text actually sits inside a text input.
   *
   * The element's own rect is the *control*, which is the right target for a
   * password field but far too generous for a value: an empty input and a filled
   * one have identical rects, so labelling the whole box would teach the model that
   * every input contains a secret. Measuring the glyphs keeps `pii_text` tight
   * around what has to be painted over.
   */
  const textExtent = (input) => {
    const value = input.value || '';
    if (!value.trim()) return null;
    const style = getComputedStyle(input);
    const canvas = textExtent._canvas || (textExtent._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    const rect = input.getBoundingClientRect();
    const padLeft = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    const padRight = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
    const available = rect.width - padLeft - padRight;
    const measured = Math.min(ctx.measureText(value).width, available);
    if (measured < 4) return null;

    const fontSize = parseFloat(style.fontSize);
    const height = fontSize * 1.25;
    return {
      left: rect.left + padLeft,
      right: rect.left + padLeft + measured,
      top: rect.top + (rect.height - height) / 2,
      bottom: rect.top + (rect.height + height) / 2,
    };
  };

  /** Tight per-line boxes for an element's text content. */
  const textRects = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2);
    range.detach?.();
    return rects;
  };

  for (const el of document.querySelectorAll('[data-pii],[data-ui]')) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const ui = el.dataset.ui;
    const pii = el.dataset.pii;
    const tag = el.tagName;

    if (ui) push('ui', ui, rect);

    if (!pii) continue;

    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG') {
      // An image is one region; there is no text layout to follow.
      push('pii', pii, rect);
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (el.type === 'password') {
        // Handled by the `ui` push above as password_field; the dots are not PII.
        continue;
      }
      const extent = textExtent(el);
      if (extent) push('pii', pii, extent);
    } else {
      const rects = textRects(el);
      if (rects.length === 0) push('pii', pii, rect);
      else for (const r of rects) push('pii', pii, r);
    }
  }

  // Canvas-drawn UI records its own boxes relative to its canvas element.
  for (const label of window.__synthLabels || []) {
    const canvas = document.getElementById(label.canvasId);
    if (!canvas || !visible(canvas)) continue;
    const base = canvas.getBoundingClientRect();
    push('class', label.cls, {
      left: base.left + label.x,
      top: base.top + label.y,
      right: base.left + label.x + label.w,
      bottom: base.top + label.y + label.h,
    });
  }

  return out;
}
