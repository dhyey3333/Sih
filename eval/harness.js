/**
 * In-page measurement.
 *
 * Runs against the *shipped* modules — `__privagent` is a build of exactly the code
 * in `extension/lib/`, not a reimplementation — so these numbers describe the
 * extension rather than a model of it.
 *
 * Returns one object per page. The caller aggregates.
 */
async function runEval(options) {
  const { buildSnapshot, detectionsFromFields, detectionsFromText, fuseDetections, Vault, DEMO_PROFILE, VisionLayer, deepQueryAll } =
    window.__privagent;

  const started = performance.now();

  /* ---------- ground truth, straight from the page ---------- */

  /**
   * Ground-truth boxes hug the *text*, not the annotated element.
   *
   * A `<td data-pii>` is mostly padding, so scoring pixel coverage against the cell
   * rect would report a low recall for a redaction that in fact covers every glyph.
   * The extension redacts what is legible, so that is what gets measured.
   */
  const truthRect = (el) => {
    if (el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'SVG') {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2);
    range.detach?.();
    if (rects.length === 0) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    const x0 = Math.min(...rects.map((r) => r.left));
    const y0 = Math.min(...rects.map((r) => r.top));
    const x1 = Math.max(...rects.map((r) => r.right));
    const y1 = Math.max(...rects.map((r) => r.bottom));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  // Deep, for the same reason the snapshot is: annotations inside a web component
  // are unreachable to a plain querySelectorAll, and scoring against an empty truth
  // set would report a perfect page.
  const truth = deepQueryAll(document, '[data-pii]')
    .map((el) => ({
      type: el.getAttribute('data-pii'),
      // The literal value on screen, used by the leak test. Never leaves this page.
      text: (el.tagName === 'IMG' ? '' : (el.value ?? el.textContent ?? '')).trim(),
      rect: truthRect(el),
      tag: el.tagName.toLowerCase(),
    }))
    .filter((t) => t.rect.w >= 2 && t.rect.h >= 2 && t.rect.y + t.rect.h > 0 && t.rect.y < innerHeight);

  /* ---------- a stand-in capture ---------- */

  // Playwright's screenshot is taken outside the page, so it cannot be fed back in.
  // Compositing the page's own images onto a flat ground gives the vision layer
  // exactly what it needs (image pixels at their real rects) without that round trip.
  const dpr = devicePixelRatio || 1;
  const width = Math.round(innerWidth * dpr);
  const height = Math.round(innerHeight * dpr);
  const shot = document.createElement('canvas');
  shot.width = width;
  shot.height = height;
  const ctx = shot.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, width, height);
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    try {
      ctx.drawImage(img, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
    } catch {
      /* a tainted image cannot be composited; the DOM layer still covers it */
    }
  }

  /* ---------- the pipeline, both configurations ---------- */

  const measure = async (withVision) => {
    const vault = new Vault();
    if (options.profile) {
      for (const [key, value] of Object.entries(DEMO_PROFILE)) vault.setProfile(key, value);
    }

    const t0 = performance.now();
    const snapshot = buildSnapshot({ knownValues: vault.needles() });
    const snapshotMs = performance.now() - t0;

    let visionDetections = [];
    let visionStats = null;
    let warmStats = null;
    if (withVision) {
      const vision = new VisionLayer({ ocr: options.ocr !== false });
      vision.setAssetBase(options.assetBase);
      await vision.warmUp();

      const cold = await vision.detect(shot, width, height, snapshot, vault);
      visionDetections = cold.detections;
      visionStats = cold.stats;

      // A second pass on the same screen, which is what every step after the first
      // in an agent loop actually looks like: the images have not changed, so OCR
      // comes from cache. Reporting only the cold number would overstate the cost
      // of a twelve-step task by an order of magnitude.
      const warm = await vision.detect(
        shot, width, height, { ...snapshot, url: snapshot.url + '#warm' }, vault,
      );
      warmStats = warm.stats;

      await vision.dispose();
    }

    const t1 = performance.now();
    const raw = [
      ...detectionsFromFields(snapshot.elements, vault),
      ...detectionsFromText(snapshot, vault),
      ...visionDetections,
    ];
    const detections = fuseDetections(raw, { pad: 3, bounds: snapshot.viewport });
    const detectMs = performance.now() - t1;

    return { vault, snapshot, detections, visionStats, warmStats, snapshotMs, detectMs };
  };

  /* ---------- scoring ---------- */

  const containment = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x) * Math.max(0, y2 - y);
    if (inter === 0) return 0;
    return inter / Math.min(a.w * a.h, b.w * b.h);
  };

  const score = (detections) => {
    const matched = new Set();
    let covered = 0;
    const missed = [];

    for (const item of truth) {
      const hits = detections.filter((d) => containment(item.rect, d.bbox) >= 0.5);
      for (const d of hits) matched.add(d.id);
      if (hits.length > 0) covered++;
      else missed.push(`${item.tag}:${item.type}`);
    }

    const falsePositives = detections.filter((d) => !matched.has(d.id));
    const tp = covered;
    const fp = falsePositives.length;
    const fn = truth.length - covered;
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    return {
      groundTruth: truth.length,
      detections: detections.length,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null,
      missed,
      falsePositiveTypes: falsePositives.map((d) => d.type),
    };
  };

  /**
   * Pixel-level redaction coverage: of all ground-truth PII area on screen, how much
   * ends up under a redaction box, and how much redacted area covers nothing.
   * Rasterised on a coarse grid — exact enough at this scale and far cheaper than
   * per-pixel masks.
   */
  const maskMetrics = (detections) => {
    const cell = 4;
    const cols = Math.ceil(innerWidth / cell);
    const rows = Math.ceil(innerHeight / cell);
    const stamp = (grid, rect) => {
      const x0 = Math.max(0, Math.floor(rect.x / cell));
      const y0 = Math.max(0, Math.floor(rect.y / cell));
      const x1 = Math.min(cols, Math.ceil((rect.x + rect.w) / cell));
      const y1 = Math.min(rows, Math.ceil((rect.y + rect.h) / cell));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * cols + x] = 1;
    };

    const truthGrid = new Uint8Array(cols * rows);
    const maskGrid = new Uint8Array(cols * rows);
    for (const t of truth) stamp(truthGrid, t.rect);
    for (const d of detections) stamp(maskGrid, d.bbox);

    let inter = 0;
    let truthArea = 0;
    let maskArea = 0;
    for (let i = 0; i < truthGrid.length; i++) {
      truthArea += truthGrid[i];
      maskArea += maskGrid[i];
      inter += truthGrid[i] & maskGrid[i];
    }
    return {
      pixelRecall: truthArea === 0 ? null : inter / truthArea,
      pixelPrecision: maskArea === 0 ? null : inter / maskArea,
      screenRedactedPct: maskArea / (cols * rows),
    };
  };

  const withVision = await measure(true);
  const domOnly = await measure(false);

  /* ---------- the leak test ---------- */

  // Render the redaction the way the extension does, then read the result back with
  // OCR and look for the real values. This is the only check that answers "did
  // anything actually survive redaction", as opposed to "did we draw a box".
  let leak = null;
  if (options.leakTest !== false) {
    const { renderRedacted, drawSetOfMarks } = window.__privagent;
    const rendered = renderRedacted(shot, width, height, withVision.detections, { dpr });
    drawSetOfMarks(
      rendered.canvas,
      withVision.snapshot.elements.map((e) => ({ id: e.id, bbox: e.bbox })),
      { dpr: rendered.scale },
    );

    const ocr = new window.__privagent.OcrEngine();
    ocr.setAssetBase(options.assetBase);
    const t = performance.now();
    // One pass over the whole redacted frame — the opposite of how the extension
    // uses OCR, and correct here: we are looking for anything at all that survived.
    const read = await ocr.readRegion(rendered.canvas, { x: 0, y: 0, w: rendered.canvas.width, h: rendered.canvas.height }, 1);
    const ocrMs = performance.now() - t;
    await ocr.dispose();

    // The findings carry recognised values; compare them against ground truth.
    const normalise = (s) => s.toLowerCase().replace(/[\s\-().]/g, '');
    const recovered = [];
    for (const item of truth) {
      if (!item.text || item.text.length < 5) continue;
      const needle = normalise(item.text);
      const hit = read.findings.some((f) => normalise(f.value).includes(needle));
      if (hit) recovered.push(item.type);
    }

    leak = {
      ocrMs: Math.round(ocrMs),
      note: 'full-frame OCR, harness only — the extension never OCRs a whole page',
      charsRecoverable: read.charsRead,
      piiFindingsInRedactedImage: read.findings.length,
      groundTruthValuesRecovered: recovered,
      leaked: recovered.length,
    };
  }

  return {
    url: location.pathname,
    viewport: { w: innerWidth, h: innerHeight, dpr },
    gpu: await describeAdapter(),
    withVision: {
      ...score(withVision.detections),
      ...maskMetrics(withVision.detections),
      visionStats: withVision.visionStats,
    },
    domOnly: { ...score(domOnly.detections), ...maskMetrics(domOnly.detections) },
    timings: {
      // The pipeline's own cost, which is what the product pays per step.
      snapshotMs: Math.round(withVision.snapshotMs * 10) / 10,
      detectMs: Math.round(withVision.detectMs * 10) / 10,
      visionMs: withVision.visionStats ? withVision.visionStats.inferenceMs : null,
      ocrMs: withVision.visionStats ? (withVision.visionStats.ocrMs ?? 0) : null,
      pipelineMs:
        Math.round(
          (withVision.snapshotMs +
            withVision.detectMs +
            (withVision.visionStats ? withVision.visionStats.inferenceMs : 0) +
            (withVision.visionStats ? withVision.visionStats.ocrMs ?? 0 : 0)) * 10,
        ) / 10,
      // The same pipeline on an unchanged screen — steps 2..n of a task.
      warmVisionMs: withVision.warmStats ? withVision.warmStats.inferenceMs : null,
      warmOcrMs: withVision.warmStats ? (withVision.warmStats.ocrMs ?? 0) : null,
      warmPipelineMs: withVision.warmStats
        ? Math.round((withVision.snapshotMs + withVision.detectMs +
            withVision.warmStats.inferenceMs + (withVision.warmStats.ocrMs ?? 0)) * 10) / 10
        : null,
      // Everything the harness did, including a second pass and the leak test.
      harnessTotalMs: Math.round((performance.now() - started) * 10) / 10,
    },
    leak,
  };
}


/**
 * Which GPU adapter WebGPU actually handed us.
 *
 * Headless browsers routinely fall back to a *software* adapter (SwiftShader,
 * lavapipe), which is far slower than the WASM path and would otherwise make the
 * backend comparison read backwards. Reporting it turns a misleading number into a
 * labelled one.
 */
async function describeAdapter() {
  if (!navigator.gpu) return { available: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false };
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
    const text = `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.description ?? ''}`.toLowerCase();
    return {
      available: true,
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      description: info.description ?? null,
      software: /swiftshader|lavapipe|llvmpipe|software|microsoft basic/.test(text),
    };
  } catch {
    return { available: false };
  }
}
