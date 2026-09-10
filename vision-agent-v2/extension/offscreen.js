/**
 * Runs entirely inside the offscreen document, NOT the service worker.
 *
 * Why this file exists at all: ONNX Runtime Web's WASM backend calls
 * dynamic import() internally while setting itself up, and the HTML spec
 * explicitly disallows import() inside a ServiceWorkerGlobalScope (see
 * https://github.com/w3c/ServiceWorker/issues/1356) - this is a platform
 * restriction, not something fixable in our code. Calling detectElements()
 * directly from background.js throws "no available backend found" for
 * exactly this reason. Chrome's documented fix is an offscreen document:
 * a real (if invisible) page context, where dynamic import() is allowed
 * like any normal webpage. This file is that page's only job - receive a
 * screenshot from the service worker, run the model, send back boxes.
 */
import { detectElements } from "./vision-detector.js";
import { ocrRedact } from "./ocr-redactor.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "DETECT_ELEMENTS") {
    (async () => {
      try {
        const blob = await (await fetch(msg.screenshotDataUrl)).blob();
        const result = await detectElements(blob);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // keep the message channel open for the async sendResponse above
  }

  if (msg.type === "OCR_REDACT") {
    (async () => {
      try {
        const blob = await (await fetch(msg.screenshotDataUrl)).blob();
        const result = await ocrRedact(blob);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return false; // not for us - let other listeners handle it
});
