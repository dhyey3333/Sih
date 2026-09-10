/**
 * Vision-based (OCR) sensitive-text redaction for the SIH26171 extension.
 *
 * Why this exists, on top of content.js's DOM scan: the DOM scan can only
 * flag what it can see in markup - type="password", a card-shaped
 * autocomplete hint, a name attribute matching /card|cvv|aadhaar/. That
 * covers well-behaved forms, but misses:
 *   - sensitive numbers rendered as plain text (a bank statement page, a
 *     confirmation screen showing "Card ending 4111 1111 1111 1111")
 *   - custom/canvas-based or heavily-JS-framework'd inputs that never set
 *     a recognizable type/autocomplete/name attribute at all
 *   - a card/Aadhaar number that's actually part of an <img> (e.g. a
 *     scanned document or ID photo embedded in the page)
 * OCR reads the actual rendered pixels, the same way a human glancing at
 * the screen would, so it catches all of the above - this is what makes
 * the redaction layer "work everywhere", not just on forms whose authors
 * used textbook HTML attributes.
 *
 * Runs entirely in this offscreen document (see offscreen.js for why it
 * can't run in the background service worker - Tesseract.js also spins up
 * a Worker internally, same ServiceWorkerGlobalScope restriction as
 * onnxruntime-web). Everything is bundled locally under vendor/tesseract/
 * and vendor/tessdata/ - same "no remote CDN" CSP constraint as the ONNX
 * runtime, and the same privacy property: the raw screenshot never leaves
 * this device, OCR included.
 */

// Runs both inside the extension's offscreen document (chrome.runtime
// available -> load the vendored worker/core/lang files by extension
// URL, matching the "no remote CDN" CSP constraint) AND in a plain
// Node.js benchmark script (chrome undefined). Node can't run the
// browser/UMD bundle above at all (it references DOM/Worker globals
// tesseract.js's browser build assumes exist) - confirmed by actually
// trying it and hitting "ReferenceError: Worker is not defined" during
// development, not assumed - so in Node we dynamically import the
// separate Node-native build from the "tesseract.js" package instead,
// and use THAT for OCR while still using the SAME classifyLines() /
// regexes below either way. This keeps the benchmark script honestly
// testing the real classification logic, not a re-implementation of it,
// even though the OCR engine underneath differs by environment.
const inExtension = typeof chrome !== "undefined" && !!chrome.runtime?.getURL;
const { createWorker } = inExtension
  ? (await import("./vendor/tesseract/tesseract.esm.min.js")).default
  : await import("tesseract.js");

const VENDOR_BASE = inExtension ? chrome.runtime.getURL("vendor/tesseract/") : null;
const TESSDATA_BASE = inExtension
  ? chrome.runtime.getURL("vendor/tessdata/")
  : new URL("./vendor/tessdata/", import.meta.url).pathname;

// --- Regex classifiers -----------------------------------------------
// Same intent as content.js's SENSITIVE_NAME_PATTERNS, but applied to
// OCR'd on-screen TEXT rather than DOM attribute names. Deliberately
// conservative (a false negative just means the DOM-scan layer is the
// only thing that caught it; a false positive means a non-sensitive
// field gets redacted, which is the safe direction to err in).
const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/; // covers 13-19 digit PANs, with common space/dash grouping
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/; // Aadhaar: 12 digits, conventionally grouped in 4s
const CVV_LABEL_RE = /\b(cvv|cvc|security code)\b/i;
const PIN_LABEL_RE = /\bpin\b/i;
const PASSWORD_LABEL_RE = /\bpassword\b/i;
const SHORT_CODE_RE = /^\d{3,6}$/; // a CVV/PIN value itself, once we've found its label nearby

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    const opts = {
      langPath: TESSDATA_BASE,
      gzip: true, // eng.traineddata is vendored gzip-compressed
      cacheMethod: "none", // no IndexedDB caching needed - we always load from local vendor files, not a network fetch worth caching
    };
    if (inExtension) {
      // Only override worker/core paths inside the extension - Node has
      // no equivalent of chrome.runtime.getURL and doesn't need one,
      // tesseract.js's own Node code path resolves those itself.
      opts.workerPath = `${VENDOR_BASE}worker.min.js`;
      opts.corePath = `${VENDOR_BASE}tesseract-core-simd-lstm.wasm.js`;
    }
    workerPromise = createWorker("eng", 1 /* OEM_LSTM_ONLY */, opts);
  }
  return workerPromise;
}

function unionRect(rects) {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

// Tesseract.js v7's word/line bbox shape is {x0, y0, x1, y1} (corners),
// NOT {x, y, width, height} - convert once here so the rest of this file
// can use the same rect shape as everything else in the pipeline
// (vision-detector.js, content.js).
function wordRect(w) {
  const b = w.bbox;
  return { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

/**
 * Classifies OCR lines into sensitive regions. Operates per-line so a
 * multi-word value ("4111 1111 1111 1111" as 4 separate OCR word tokens,
 * or "CVV" as one word and "123" as the next) can be matched as a whole
 * and its region built from the union of the words that make it up,
 * instead of only flagging a single word in isolation.
 */
function classifyLines(lines) {
  const regions = [];

  for (const line of lines) {
    const text = (line.text || "").trim();
    if (!text) continue;
    const words = line.words || [];

    if (CARD_NUMBER_RE.test(text) || AADHAAR_RE.test(text)) {
      // Redact every digit-heavy word on this line rather than trying to
      // slice the exact matched substring back into word tokens - a
      // whole line that reads as a card/Aadhaar number is almost always
      // ONLY that number (plus maybe a label), so this stays precise in
      // practice without fragile substring-to-bbox math.
      const numericWords = words.filter((w) => /\d/.test(w.text) && w.text.replace(/[^\d]/g, "").length >= 3);
      if (numericWords.length > 0) {
        regions.push({ ...unionRect(numericWords.map(wordRect)), reason: "ocr: card/Aadhaar-shaped number" });
        continue;
      }
    }

    if (PASSWORD_LABEL_RE.test(text)) {
      // If a password's plaintext is actually rendered on screen (a
      // "show password" toggle, a confirmation screen, etc.), redact the
      // whole line - safer than guessing which token is the value.
      regions.push({ ...unionRect(words.map(wordRect)), reason: "ocr: password label on screen" });
      continue;
    }

    if (CVV_LABEL_RE.test(text) || PIN_LABEL_RE.test(text)) {
      const shortCodeWords = words.filter((w) => SHORT_CODE_RE.test(w.text.trim()));
      if (shortCodeWords.length > 0) {
        regions.push({ ...unionRect(shortCodeWords.map(wordRect)), reason: "ocr: CVV/PIN value near label" });
      } else {
        // Couldn't isolate just the value - redact the whole line rather
        // than leaking a code we can't precisely locate.
        regions.push({ ...unionRect(words.map(wordRect)), reason: "ocr: CVV/PIN label (value not isolated)" });
      }
    }
  }

  return regions;
}

export {
  classifyLines,
  CARD_NUMBER_RE,
  AADHAAR_RE,
  CVV_LABEL_RE,
  PIN_LABEL_RE,
  PASSWORD_LABEL_RE,
  SHORT_CODE_RE,
};

// Exposed for the benchmark script, which processes many test images in
// one process and needs to cleanly shut the worker down at the end -
// the extension side never calls this (the offscreen document's worker
// lives for as long as the document does, recreated on demand).
export async function terminateWorker() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
/**
 * Main entry point, mirrors detectElements()'s shape. Takes the raw
 * screenshot Blob, returns sensitive regions in the SAME device-pixel
 * space as the screenshot itself (no letterboxing/resizing happens here,
 * unlike the vision detector - Tesseract reads the image at native
 * resolution) so background.js can merge them directly with the
 * vision-detected boxes with zero extra scaling.
 */
export async function ocrRedact(screenshotBlob) {
  const t0 = performance.now();
  const worker = await getWorker();
  const t1 = performance.now();

  // Accepts a browser Blob (extension path) OR a Node Buffer/Uint8Array
  // (benchmark script path) - both have arrayBuffer() in modern
  // environments' Blob, but the benchmark script passes a file path
  // string directly, which tesseract.js's Node build also accepts as-is.
  const input =
    typeof screenshotBlob === "string" ? screenshotBlob : new Uint8Array(await screenshotBlob.arrayBuffer());
  // { blocks: true } is required in Tesseract.js v7 - by default recognize()
  // only returns flat `text`, not the block/paragraph/line/word tree with
  // per-word bounding boxes that classifyLines() needs. Verified against
  // this exact shape (data.blocks[].paragraphs[].lines[].words[], word
  // bbox as {x0,y0,x1,y1}) by actually running this against a synthetic
  // test image with known card/CVV/Aadhaar text during development -
  // real OCR output, not assumed from docs.
  const { data } = await worker.recognize(input, {}, { blocks: true });
  const t2 = performance.now();

  const lines = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  const regions = classifyLines(lines);
  const t3 = performance.now();

  return {
    regions,
    timings: {
      worker_load_ms: Math.round(t1 - t0), // ~0 after first call, worker is cached
      ocr_ms: Math.round(t2 - t1),
      classify_ms: Math.round(t3 - t2),
      total_ocr_ms: Math.round(t3 - t0),
      lines_scanned: lines.length,
      sensitive_regions_found: regions.length,
    },
  };
}
