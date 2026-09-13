/**
 * On-device UI-element detector for the SIH26171 extension.
 *
 * Replaces content.js's `document.querySelectorAll("button, input, ...")`
 * runtime call with genuine pixel-based detection: takes a screenshot,
 * runs it through a small YOLO-style ONNX model in-browser, returns
 * bounding boxes + element types. No DOM access at inference time -- this
 * is the piece that actually earns "on-device visual perception".
 *
 * Preprocessing/decode logic here is a direct port of
 * extension/validate_decode.py, which was run against the real exported
 * model + a real screenshot in Python first (confirmed: correct tensor
 * shapes in/out, and in-bounds, sensibly-scaled box coordinates -- see
 * README's Step 4 verification notes for the actual run output). The
 * letterbox approach matters specifically because Ultralytics YOLO
 * letterboxes images internally during training by default; a naive
 * stretch-to-320x320 resize (which an earlier draft of this file used)
 * would silently feed the model out-of-distribution input and hurt
 * accuracy, even though it "runs" without erroring.
 */

import * as ort from "./vendor/ort.wasm.min.mjs";

const CLASS_NAMES = ["button", "input", "link", "image"]; // must match labeling/generate_dataset.py, in order
const IMG_SIZE = 320; // must match --imgsz used in training/train.py
const CONF_THRESH = 0.25;
const IOU_THRESH = 0.45;

ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
// Single-threaded: MV3 service workers can't spawn the dedicated Worker
// threads onnxruntime-web's multi-threaded WASM build wants, so we pin
// this rather than let it silently fail to parallelize.
ort.env.wasm.numThreads = 1;

let sessionPromise = null;

function loadSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL("vendor/ui_detector.onnx"), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    // NOTE on WebGPU: onnxruntime-web supports a "webgpu" execution
    // provider that would run this faster on supporting devices. It's
    // deliberately not wired in here -- getting the two builds'
    // (ort.webgpu.* vs ort.wasm.*) WASM-fallback-binary wiring exactly
    // right is version-specific and easy to get subtly wrong, and a
    // silently-broken "fast path" is worse than a working, honestly
    // WASM-only default for a hackathon deadline. Documented as the
    // clear next upgrade in README Step 4 if there's time before judging.
  }
  return sessionPromise;
}

/**
 * Letterbox-resize a screenshot into the model's fixed square input size,
 * preserving aspect ratio with grey padding, then convert to a normalized
 * CHW float32 tensor. This must match training-time preprocessing (see
 * file header) or accuracy silently degrades without erroring.
 *
 * Takes a Blob (what chrome.tabs.captureVisibleTab already gives you
 * after one fetch+blob step) and uses createImageBitmap, NOT `new
 * Image()` -- the latter is a DOM API that does not exist in a Manifest
 * V3 service worker's global scope (no window/document there) and would
 * throw at runtime.
 */
async function preprocessScreenshot(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  const scale = Math.min(IMG_SIZE / w, IMG_SIZE / h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const padX = Math.floor((IMG_SIZE - nw) / 2);
  const padY = Math.floor((IMG_SIZE - nh) / 2);

  const canvas = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(114,114,114)"; // standard YOLO letterbox pad color
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  ctx.drawImage(bitmap, padX, padY, nw, nh);

  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE); // RGBA, HWC, uint8

  const chw = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
  const plane = IMG_SIZE * IMG_SIZE;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255; // R plane
    chw[plane + i] = data[i * 4 + 1] / 255; // G plane
    chw[2 * plane + i] = data[i * 4 + 2] / 255; // B plane
  }

  return {
    tensor: new ort.Tensor("float32", chw, [1, 3, IMG_SIZE, IMG_SIZE]),
    scale, padX, padY,
  };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-9);
}

function nms(boxes, scores, thresh) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  let remaining = order;
  while (remaining.length) {
    const i = remaining[0];
    keep.push(i);
    remaining = remaining.slice(1).filter((j) => iou(boxes[i], boxes[j]) < thresh);
  }
  return keep;
}

/**
 * Decode raw YOLOv8 head output (1, 4+numClasses, numBoxes) into
 * original-screenshot-space boxes + class labels + confidence, with NMS
 * applied. Line-for-line match with validate_decode.py's decode(), which
 * was run against the real exported model to confirm the shapes and
 * undo-letterbox math are correct.
 */
function decode(outputTensor, scale, padX, padY) {
  const dims = outputTensor.dims; // [1, 4+numClasses, numBoxes]
  const numAttrs = dims[1];
  const numBoxes = dims[2];
  const data = outputTensor.data;

  const boxesXyxy = [];
  const confs = [];
  const classIds = [];

  for (let i = 0; i < numBoxes; i++) {
    let bestCls = -1, bestScore = -Infinity;
    for (let c = 4; c < numAttrs; c++) {
      const score = data[c * numBoxes + i];
      if (score > bestScore) { bestScore = score; bestCls = c - 4; }
    }
    if (bestScore <= CONF_THRESH) continue;

    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const w = data[2 * numBoxes + i];
    const h = data[3 * numBoxes + i];

    let x1 = cx - w / 2, y1 = cy - h / 2, x2 = cx + w / 2, y2 = cy + h / 2;
    // undo letterbox pad + scale back to the real screenshot's coordinates
    x1 = (x1 - padX) / scale;
    y1 = (y1 - padY) / scale;
    x2 = (x2 - padX) / scale;
    y2 = (y2 - padY) / scale;

    boxesXyxy.push([x1, y1, x2, y2]);
    confs.push(bestScore);
    classIds.push(bestCls);
  }

  if (boxesXyxy.length === 0) return [];

  const keepIdx = nms(boxesXyxy, confs, IOU_THRESH);
  return keepIdx.map((i) => {
    const [x1, y1, x2, y2] = boxesXyxy[i];
    return {
      cls: CLASS_NAMES[classIds[i]],
      conf: confs[i],
      rect: { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) },
    };
  });
}

/**
 * Main entry point, called from background.js in place of the old
 * buildInteractableSummary() DOM scan. Takes a screenshot Blob, returns
 * the same shape of element list the rest of the pipeline (redaction,
 * Set-of-Mark drawing, server call) already expects -- so downstream code
 * barely has to change, only the SOURCE of the boxes changes, from DOM
 * rects to model detections.
 */
export async function detectElements(screenshotBlob) {
  const t0 = performance.now();
  const session = await loadSession();
  const t1 = performance.now();

  const { tensor, scale, padX, padY } = await preprocessScreenshot(screenshotBlob);
  const t2 = performance.now();

  const outputs = await session.run({ [session.inputNames[0]]: tensor });
  const outputTensor = outputs[session.outputNames[0]];
  const t3 = performance.now();

  const detections = decode(outputTensor, scale, padX, padY);
  const t4 = performance.now();

  let mark = 1;
  const interactables = detections.map((d) => ({
    mark: mark++,
    tag: d.cls,          // "button" | "input" | "link" | "image" -- from PIXELS, not DOM tag names
    label: null,         // vision model has no access to text semantics, only geometry+class -- by design
    sensitive: false,    // decided by the OCR+regex redaction pass downstream, not here
    confidence: Math.round(d.conf * 100) / 100,
    rect: d.rect,
  }));

  return {
    interactables,
    timings: {
      model_load_ms: Math.round(t1 - t0), // ~0 after first call, session is cached
      preprocess_ms: Math.round(t2 - t1),
      inference_ms: Math.round(t3 - t2),
      decode_ms: Math.round(t4 - t3),
      vision_inference_ms: Math.round(t4 - t0), // total, this is the number that matters for the rubric
      boxes_detected: interactables.length,
    },
  };
}
