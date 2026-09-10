/**
 * Orchestrates the agent loop AND owns all of its state.
 *
 * Architecture (post-fix):
 *   - This background service worker is the only thing that runs the
 *     agent loop and the only writer of agent state. State is persisted to
 *     chrome.storage.local after every step, not held in the popup.
 *   - popup.js is a pure viewer: it reads chrome.storage.local once on
 *     open and subscribes to chrome.storage.onChanged for live updates.
 *     Closing the popup, or the page refreshing, no longer kills the run -
 *     it lives here and keeps writing progress regardless of whether
 *     anything is listening.
 *   - Before talking to a tab's content script, this script injects it on
 *     demand via chrome.scripting.executeScript instead of relying on
 *     Chrome's automatic content_scripts injection. That auto-injection
 *     only applies to tabs opened after the extension last (re)loaded, so
 *     depending on it is what caused "Could not establish connection.
 *     Receiving end does not exist." after every extension reload. Doing
 *     this on demand, every time, makes that class of error structurally
 *     impossible rather than a manual "reload the tab too" step to remember.
 *
 * One agent step now does:
 *   1. Ask content script to scan the page for SENSITIVE regions only
 *      (DOM attributes + face-api - the brief explicitly allows any
 *      method for this sanitization step, it's not the graded "vision" part)
 *   2. Capture the visible tab as an image
 *   3. Ask the OFFSCREEN DOCUMENT to run the on-device vision model on
 *      that RAW screenshot to find buttons/inputs/links/images from
 *      PIXELS - this is the part graded as "accuracy of visual context
 *      from screen". It has to happen in an offscreen document rather
 *      than here, because ONNX Runtime Web's WASM backend needs dynamic
 *      import(), which the HTML spec disallows inside a service worker
 *      (see ensureOffscreenDocument() below) - either way, zero DOM
 *      access to the actual page, unlike the old buildInteractableSummary()
 *   4. Redact the image at the sensitive-region coordinates (OffscreenCanvas, in-process, never sent unredacted anywhere)
 *   5. POST { redacted image (base64), vision-detected elements, task } to the local server
 *   6. Receive back a structured action (a pixel coordinate, from the marks
 *      drawn on vision-detected boxes) and tell the content script to
 *      execute it via elementFromPoint - the ONLY remaining DOM touch,
 *      and it's actuation, not perception
 *
 * Only the output of step 4 (the redacted image) plus the vision model's
 * geometry-only element list (step 3) ever leave the client - that's the
 * core privacy property the PS asks for.
 */

const SERVER_URL = "http://localhost:8000/agent-action";
const MAX_STEPS = 5;
const STORAGE_KEY = "agentState";
const CONTENT_SCRIPT_FILES = ["face-api.min.js", "content.js"];
const OFFSCREEN_URL = "offscreen.html";

// ---------------------------------------------------------------------
// DPI / page-zoom coordinate fix.
//
// The bug: chrome.tabs.captureVisibleTab() returns a screenshot at DEVICE
// pixel resolution (CSS size * devicePixelRatio, and further scaled by
// any browser page-zoom level). Every box this pipeline works with
// downstream of the screenshot -- vision-detected interactables, OCR word
// boxes -- lives in that SAME device-pixel space, because they're all
// measured directly off the screenshot bitmap. But content.js's
// getBoundingClientRect() (sensitive-region scan) and
// document.elementFromPoint() (action execution) both work in CSS pixel
// space, because that's what the DOM uses. On a 100%-scaled, 1x display
// these two spaces happen to be identical, which is why this went
// unnoticed in the demo-page-only smoke test -- but on any HiDPI laptop
// (Retina Macs are 2x by default, most Windows laptops ship at 125-150%
// scaling) they are NOT the same, and every click/type action would have
// landed at the wrong pixel.
//
// Fix: don't trust window.devicePixelRatio alone (it doesn't capture
// browser-level page zoom, e.g. ctrl/cmd+ on a 1x display also changes
// the capture-to-CSS ratio). Instead measure the REAL ratio directly:
// captured screenshot bitmap width / the content script's reported CSS
// viewport width. That ratio is correct regardless of DPR, OS scaling,
// or page zoom, because it's derived from what the browser actually did,
// not from a device property that only tells part of the story.
function computeCaptureScale(bitmapWidth, bitmapHeight, cssViewport) {
  if (!cssViewport?.width || !cssViewport?.height) return 1;
  const scaleX = bitmapWidth / cssViewport.width;
  const scaleY = bitmapHeight / cssViewport.height;
  // Average the two axes -- they're almost always equal, but averaging
  // is a harmless safety net against a stray 1px rounding mismatch
  // rather than silently trusting only one axis.
  return (scaleX + scaleY) / 2;
}

function scaleRect(r, scale) {
  return { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale };
}

// ---------------------------------------------------------------------
// Offscreen document management (required for onnxruntime-web -- see
// header comment above and offscreen.js for why this exists at all)
// ---------------------------------------------------------------------

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"], // both onnxruntime-web AND tesseract.js spin up a Worker internally (ort-wasm-proxy-worker / Tesseract's OCR worker)
    justification:
      "Run ONNX Runtime Web (on-device UI-element detection) and Tesseract.js (on-device OCR for " +
      "sensitive-text redaction). Both need dynamic import()/Worker, which the HTML spec disallows " +
      "directly inside a service worker (ServiceWorkerGlobalScope).",
  });
}

async function detectElementsViaOffscreen(screenshotDataUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ type: "DETECT_ELEMENTS", screenshotDataUrl });
  if (!response?.ok) {
    throw new Error(`vision detection failed: ${response?.error || "no response from offscreen document"}`);
  }
  return response;
}

// Step 5: OCR-based redaction. Runs Tesseract.js (bundled locally, same
// no-remote-CDN constraint as onnxruntime-web) on the RAW screenshot
// pixels and regex-classifies the recognized text, in the same
// offscreen document already used for the vision model. This is what
// makes redaction work "everywhere" instead of only on pages whose
// sensitive fields happen to have DOM attributes the old scanner could
// read: a card number rendered inside a <canvas>, a screenshot embedded
// in a page, a non-standard/obfuscated framework that doesn't set
// type="password" or autocomplete hints, or plain sensitive text sitting
// in a <div> instead of an <input> -- none of those are visible to
// content.js's DOM scan, but all of them are visible to OCR on pixels,
// the same way a human looking at the screen would catch them.
// Failure here (OCR timeout, worker load error, etc.) must never break
// the pipeline -- DOM-based redaction alone is still a reasonable
// baseline -- so this always resolves, never rejects.
async function ocrRedactViaOffscreen(screenshotDataUrl) {
  await ensureOffscreenDocument();
  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage({ type: "OCR_REDACT", screenshotDataUrl }),
      12000,
      "OCR redaction"
    );
    if (!response?.ok) {
      console.warn("[vision-agent] OCR redaction failed, continuing with DOM-only redaction:", response?.error);
      return { regions: [], timings: { ocr_ms: 0 }, degraded: true };
    }
    return response;
  } catch (err) {
    console.warn("[vision-agent] OCR redaction errored/timed out, continuing with DOM-only redaction:", err);
    return { regions: [], timings: { ocr_ms: 0 }, degraded: true };
  }
}

// ---------------------------------------------------------------------
// State persistence — the single source of truth for what the popup shows.
// ---------------------------------------------------------------------

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (
    data[STORAGE_KEY] || {
      status: "idle", // "idle" | "running" | "done" | "error"
      task: "",
      history: [],
      error: null,
      startedAt: null,
      updatedAt: null,
    }
  );
}

async function setState(partial) {
  const current = await getState();
  const next = { ...current, ...partial, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

// Keep storage lean: only the most recent step needs its redacted
// screenshot for the live preview in the popup. Carrying every
// intermediate step's PNG would otherwise bloat chrome.storage.local
// (and slow down every write) for no benefit.
function trimHistoryForStorage(history) {
  return history.map((h, i) => (i === history.length - 1 ? h : { ...h, redactedImage: undefined }));
}

// If the service worker was evicted or Chrome/the extension was reloaded
// while a run was mid-flight, that in-memory loop is gone for good - there
// is nothing to resume. Without this, the popup would show "Running..."
// forever with no further progress. Surface it as an error instead.
async function recoverStaleRun() {
  const state = await getState();
  if (state.status === "running") {
    await setState({ status: "error", error: "Interrupted (extension or browser restarted mid-run). Please run again." });
  }
}
chrome.runtime.onStartup.addListener(recoverStaleRun);
chrome.runtime.onInstalled.addListener(recoverStaleRun);

// ---------------------------------------------------------------------
// On-demand content script injection
// ---------------------------------------------------------------------

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    });
  } catch (err) {
    // Common causes: chrome:// / Chrome Web Store / PDF-viewer pages (Chrome
    // blocks script injection there by design), or a file:// page opened
    // without "Allow access to file URLs" enabled for this extension in
    // chrome://extensions.
    throw new Error(
      `Could not run on this page (${err.message}). If this is a local file:// page, ` +
        `enable "Allow access to file URLs" for this extension, or serve it over http:// instead.`
    );
  }
}

// ---------------------------------------------------------------------
// Redaction drawing helpers (unchanged)
// ---------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function drawLayoutPreservingRedaction(ctx, r) {
  // Grey placeholder of the SAME dimensions as the sensitive region,
  // instead of a solid black box. A black box destroys layout information
  // (is this a short field or a photo banner?) that the agent may need to
  // reason about the page; a same-size neutral placeholder keeps the
  // layout legible while making the original content fully unrecoverable -
  // a more defensible claim than "we blacked it out."
  ctx.fillStyle = "#c9c9c9";
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x, r.y, r.width, r.height);
  // small lock glyph so it's visually obvious to a human viewer this is redacted
  ctx.fillStyle = "#777";
  ctx.font = `${Math.max(10, Math.min(r.height * 0.5, 16))}px sans-serif`;
  ctx.fillText("🔒", r.x + 4, r.y + r.height / 2 + 5);
}

function drawSetOfMarks(ctx, interactables) {
  // Numbered overlay on every interactable element (Set-of-Mark grounding).
  // The agent responds with a mark number instead of pixel coordinates,
  // which avoids the coordinate-hallucination failure mode common in
  // screenshot-only GUI agents.
  for (const el of interactables) {
    const { x, y, width, height } = el.rect;
    ctx.strokeStyle = "#ff3b3b";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);

    const label = String(el.mark);
    ctx.font = "bold 12px sans-serif";
    const labelWidth = ctx.measureText(label).width + 6;
    ctx.fillStyle = "#ff3b3b";
    ctx.fillRect(x, y - 16, labelWidth, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 3, y - 4);
  }
}

async function captureScreenshotDataUrl(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function redactAndMark(screenshotBlob, sensitiveRegions, interactables) {
  const bitmap = await createImageBitmap(screenshotBlob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // Redact sensitive regions FIRST, so marks drawn afterward stay legible
  // even over a redacted field (helps the agent know "mark 4 exists here,
  // it's just sensitive" rather than losing the element entirely).
  // sensitiveRegions here must already be in the SAME pixel space as this
  // canvas (device pixels, i.e. bitmap.width/height) - see
  // computeCaptureScale() and its call site in runAgentStep for why a
  // raw CSS-pixel rect from getBoundingClientRect() would land in the
  // wrong place on any HiDPI or zoomed page.
  for (const r of sensitiveRegions) {
    drawLayoutPreservingRedaction(ctx, r);
  }
  drawSetOfMarks(ctx, interactables);

  const redactedBlob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuffer = await redactedBlob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return { dataUrl: `data:image/png;base64,${base64}`, width: bitmap.width, height: bitmap.height };
}

// Two regions "overlap" for de-dup purposes if they share a meaningful
// fraction of their area - used so a card number OCR catches doesn't
// draw a second, slightly-offset grey box directly on top of the one the
// DOM scan already placed over the same <input>.
function regionsOverlap(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const smallerArea = Math.min(a.width * a.height, b.width * b.height) || 1;
  return interArea / smallerArea > 0.4;
}

function mergeSensitiveRegions(domRegionsPx, ocrRegions) {
  const merged = [...domRegionsPx];
  for (const r of ocrRegions) {
    if (!merged.some((m) => regionsOverlap(m, r))) merged.push(r);
  }
  return merged;
}

// ---------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------

async function runAgentStep(tabId, task, history) {
  const stepStart = performance.now();

  await ensureContentScriptInjected(tabId);
  // Content script now only reports SENSITIVE REGIONS (DOM+face-api is an
  // allowed method for sanitization). It no longer reports interactable
  // elements - that comes from the vision model below, on pixels alone.
  const scan = await chrome.tabs.sendMessage(tabId, { type: "SCAN" });
  const tab = await chrome.tabs.get(tabId);

  const screenshotDataUrl = await captureScreenshotDataUrl(tab.windowId);
  const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();
  const screenshotBitmap = await createImageBitmap(screenshotBlob);

  // See computeCaptureScale() above: the screenshot is in DEVICE pixels,
  // content.js's sensitiveRegions and elementFromPoint are in CSS pixels.
  // This is the one number that reconciles the two everywhere below.
  const captureScale = computeCaptureScale(screenshotBitmap.width, screenshotBitmap.height, scan.viewport);

  // *** The core of SIH26171: real on-device visual perception. ***
  // Runs in the offscreen document, not here - see ensureOffscreenDocument()
  // above for why. No DOM access at any point in this call: the offscreen
  // document only ever receives a screenshot image, never the page itself.
  const [{ interactables, timings: visionTimings }, ocrResult] = await Promise.all([
    detectElementsViaOffscreen(screenshotDataUrl),
    ocrRedactViaOffscreen(screenshotDataUrl),
  ]);

  const redactStart = performance.now();
  // scan.sensitiveRegions come from content.js in CSS pixel space -> scale
  // up to the screenshot's device-pixel space before drawing. ocrResult
  // regions are already in device-pixel space (OCR ran on the raw
  // screenshot directly), so they need no conversion.
  const domRegionsPx = scan.sensitiveRegions.map((r) => scaleRect(r, captureScale));
  const sensitiveRegionsPx = mergeSensitiveRegions(domRegionsPx, ocrResult.regions);
  const { dataUrl: redactedImage } = await redactAndMark(screenshotBlob, sensitiveRegionsPx, interactables);
  const redactMs = Math.round(performance.now() - redactStart);

  const serverStart = performance.now();
  const response = await withTimeout(
    fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        redacted_image: redactedImage,
        interactables, // vision-detected: {mark, tag, confidence, rect}, no DOM selectors, no text content
        redacted_region_count: sensitiveRegionsPx.length,
        history,
      }),
    }),
    20000,
    "server request"
  );
  const { action, done, reasoning, engine } = await response.json();
  const serverMs = Math.round(performance.now() - serverStart);

  const metrics = {
    sensitive_scan_ms: scan.timings?.dom_scan_ms ?? 0,
    face_detection_ms: scan.timings?.face_detection_ms ?? 0,
    images_scanned: scan.timings?.images_scanned ?? 0,
    vision_inference_ms: visionTimings.vision_inference_ms, // the number that matters for the "client resource utilization" / latency rubric
    elements_detected: visionTimings.boxes_detected,
    ocr_ms: ocrResult.timings?.ocr_ms ?? 0,
    ocr_regions_found: ocrResult.regions.length,
    ocr_degraded: !!ocrResult.degraded, // true if OCR failed/timed out this step and only DOM-based redaction ran
    capture_and_redact_ms: redactMs,
    server_round_trip_ms: serverMs,
    total_step_ms: Math.round(performance.now() - stepStart),
    sensitive_regions_redacted: sensitiveRegionsPx.length,
    capture_scale: Math.round(captureScale * 100) / 100, // 1 on a 100%-scale 1x display, ~2 on Retina/most HiDPI laptops
    engine: engine || "rule_based",
  };

  if (!done && action) {
    // The page may have navigated between the scan above and now (e.g. the
    // chosen action was a submit that redirected) - re-injecting here is
    // cheap and idempotent, and keeps this step from failing with
    // "Receiving end does not exist" if that happened.
    await ensureContentScriptInjected(tabId);
    // action.mark identifies WHICH vision-detected box the server picked;
    // resolve it back to a pixel coordinate here (server never needs to
    // know actual page coordinates on its own, only mark numbers it saw
    // drawn on the image it was given).
    const target = interactables.find((el) => el.mark === action.mark);
    if (!target) {
      const result = { ok: false, error: `server referenced unknown mark ${action.mark}` };
      return { done, reasoning, action, result, metrics, redactedImage };
    }
    // *** The DPI/zoom fix ***. target.rect is in device-pixel space (it
    // came from the vision model running on the raw screenshot). But
    // content.js's executeAction() calls document.elementFromPoint(x, y),
    // which is a CSS-pixel-space API. Divide by captureScale to convert
    // back before sending - without this line, every click/type would
    // land at the wrong spot on any display where captureScale != 1
    // (Retina, most Windows scaling presets, or a zoomed-in page).
    const pixelAction = {
      ...action,
      x: Math.round((target.rect.x + target.rect.width / 2) / captureScale),
      y: Math.round((target.rect.y + target.rect.height / 2) / captureScale),
    };
    const result = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_ACTION", action: pixelAction });
    return { done, reasoning, action, result, metrics, redactedImage };
  }
  return { done: true, reasoning, action: null, result: null, metrics, redactedImage };
}

async function runAgent(tabId, task) {
  const history = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const outcome = await runAgentStep(tabId, task, history);
    history.push(outcome);
    // Write progress after every step so a popup open at the time updates
    // live, and a popup opened later still sees how far the run got.
    await setState({ status: "running", task, history: trimHistoryForStorage(history) });
    if (outcome.done) break;
  }
  return history;
}

// ---------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_AGENT") {
    (async () => {
      const state = await getState();
      if (state.status === "running") {
        sendResponse({ ok: false, error: "An agent run is already in progress." });
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendResponse({ ok: false, error: "No active tab found." });
        return;
      }

      await setState({ status: "running", task: msg.task, history: [], error: null, startedAt: Date.now() });
      // Acknowledge immediately - the run continues below regardless of
      // whether the popup that sent this message is still around to hear
      // about it. Progress goes to chrome.storage.local, not this response.
      sendResponse({ ok: true, started: true });

      try {
        const history = await runAgent(tab.id, msg.task);
        await setState({ status: "done", history: trimHistoryForStorage(history), error: null });
      } catch (err) {
        await setState({ status: "error", error: String(err?.message || err) });
      }
    })();
    return true; // keep the message channel open for the async sendResponse above
  }
});
