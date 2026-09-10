# SIH26171 -- On-device vision pipeline

The real perception pipeline: a small model that finds buttons, inputs,
links, and images directly from screenshot pixels (no DOM access),
replacing the `querySelectorAll`-based runtime detection in the original
extension. Every stage below was actually run in this session, not just
written -- see the honest verification notes per step for exactly what
was and wasn't confirmed.

## Step 1 -- Generate labeled data (run on your own machine for real scale)

```
cd labeling
pip install playwright
playwright install chromium
python3 generate_dataset.py --urls urls.txt --out dataset
```

Edit `urls.txt` first -- it has ~20 starter URLs, but you want 150-300+
for a real dataset, mixing login pages, signup forms, e-commerce,
dashboards, blogs, so the model generalizes instead of memorizing one
site's look. Add your own extension's demo page too.

Produces `dataset/images/*.png` + `dataset/labels/*.txt` (YOLO format),
fully automatically, zero manual annotation -- it repurposes the DOM scan
your original extension used to do at runtime, running it once offline
instead, to generate labels.

**Verified in this session:** ran against your demo page + a real GitHub
page; visually confirmed (boxes drawn back over the screenshots) that
every button/field/link/image was correctly located and typed. Most
other public sites were blocked by this sandbox's network allowlist --
not a pipeline issue, just run it with normal internet access.

## Step 2 -- Train (Colab, free GPU: Runtime > Change runtime type > T4 GPU)

```
!pip install ultralytics
# upload/unzip your dataset/ folder from Step 1 into the Colab environment
!python3 prepare_yolo_dataset.py --src dataset --out yolo_dataset
!python3 train.py --data yolo_dataset/data.yaml --epochs 50
```

50 epochs on a few hundred images should take well under an hour on a T4.
Watch `mAP50` in the printed validation results -- your real accuracy
number for the "accuracy of visual context" grading criterion.

**Verified in this session:** ran the full train -> validate loop for
real (transfer learning from COCO-pretrained YOLOv8n, downloaded
automatically). mAP was 0 -- expected and not a bug, since there were
only 1-2 training images available here. The training loop itself,
loss computation, and validation reporting all ran correctly.

## Step 3 -- Export to ONNX (verified working)

```python
from ultralytics import YOLO
model = YOLO('runs/detect/ui_detector/weights/best.pt')
model.export(format='onnx', imgsz=320, simplify=True)
```

**Verified in this session:** ran twice, produced a valid `best.onnx`
(11.6MB) both times, confirmed loadable by `onnxruntime` in Python with
the expected input shape `[1,3,320,320]` and output shape `[1,8,2100]`
(4 box coords + 4 classes, 2100 anchors at imgsz=320).

## Step 4 -- Browser integration (built: `extension/vision-detector.js` + `extension/offscreen.js`)

**Real bug found and fixed after your first test run:** ONNX Runtime
Web's WASM backend calls dynamic `import()` internally, and the HTML
spec disallows `import()` inside a Manifest V3 service worker's
`ServiceWorkerGlobalScope` (this is a platform restriction, not
something fixable in app code -- see
https://github.com/w3c/ServiceWorker/issues/1356). Calling the model
directly from `background.js` throws `"no available backend found"`.
Chrome's documented fix is an **offscreen document**: a hidden page with
a real DOM, which service workers are allowed to delegate to.
`extension/offscreen.html` + `extension/offscreen.js` are that page --
`background.js` now creates it on demand and sends it each screenshot
via `chrome.runtime.sendMessage`, gets vision-detected boxes back the
same way. Zero DOM access to the actual page happens anywhere in this
flow, on either side of that message.

`onnxruntime-web` (WASM execution provider, bundled locally in
`extension/vendor/` -- Manifest V3's CSP forbids loading executable code
from a remote CDN). `detectElements(screenshotBlob)` letterbox-resizes
the screenshot to 320x320 (matching Ultralytics' own training-time
preprocessing -- a naive stretch-resize would silently feed the model
out-of-distribution input), runs it through `ui_detector.onnx`, decodes
YOLO's raw output (confidence filter + per-class NMS), and returns boxes
in original-screenshot pixel space.

`background.js` now calls this on the raw screenshot BEFORE redaction,
and sends the vision-detected boxes to the server instead of the old
DOM-scanned list. `content.js`'s `buildInteractableSummary()` (the
DOM-query approach) is gone from the runtime path entirely -- it only
exists now as `labeling/generate_dataset.py`'s offline labeling logic.
The DOM is still touched in exactly two places, both explicitly allowed
by the brief: (1) sensitive-field detection for redaction, and (2)
`executeAction()` resolving a vision-given pixel coordinate to a real
element via `document.elementFromPoint(x, y)` to click/type -- actuation,
not perception.

**Verified in this session, honestly:**
- All extension JS files pass `node --check` (syntax valid).
- `extension/validate_decode.py` -- the exact same letterbox-preprocess +
  YOLO-decode + NMS math `vision-detector.js` implements -- was actually
  **run** (not just written) against the real exported `best.onnx` and a
  real screenshot from Step 1. Confirmed: correct tensor shapes in/out,
  and with the confidence threshold temporarily zeroed to force output,
  327 detections with plausible in-bounds coordinates, proving the
  preprocessing/decoding pipeline is mechanically correct. At the real
  threshold it correctly returns 0 detections, since this model has had
  no real training yet.
- One real bug was caught and fixed during this process: an earlier
  version of `vision-detector.js` used `new Image()` for preprocessing,
  which does not exist in a Manifest V3 service worker (no DOM there) --
  it's been replaced with `createImageBitmap()`, which is available in
  service workers and is what `background.js` already used elsewhere.

**Not verified (needs a real Chrome load, impossible in this sandbox):**
- `chrome://extensions` -> "Load unpacked" -> select `extension/` ->
  confirm no manifest/CSP errors on load.
- Replace `extension/vendor/ui_detector.onnx` with your REAL trained
  model from Step 2/3 -- right now it's this session's untrained
  smoke-test model, not something that will detect anything useful yet.
- Run the popup against a real page, confirm boxes line up with what's
  actually clickable, and that `elementFromPoint` reliably resolves the
  right element at that pixel (watch for: overlapping/stacked elements at
  the same screen position, where an imprecise box could make
  `elementFromPoint` return the wrong element).
- Confirm the 14MB `vendor/ort-wasm-simd-threaded.wasm` loads correctly
  under the `wasm-unsafe-eval` CSP directive now in `manifest.json`.

**Deliberately not done, documented instead of faked:** a WebGPU
execution-provider path. `onnxruntime-web` supports one, and it would run
faster on supporting devices, but wiring its WASM-fallback binary
correctly is version-specific -- a silently-broken "fast path" would be
worse than an honest, working WASM-only default under a hackathon
deadline. Clear next upgrade if there's spare time before judging.

## Step 5 -- OCR redaction + DPI fix + benchmarking (built and run for real)

### 5a. Real bug fixed first: DPI/zoom coordinate mismatch

`chrome.tabs.captureVisibleTab()` returns screenshots at DEVICE-pixel
resolution (CSS size × `devicePixelRatio`, further scaled by page zoom).
Every downstream box (vision-detected interactables, OCR word boxes)
lives in that same space, because they're measured directly off the
screenshot bitmap. But `content.js`'s `getBoundingClientRect()`
(sensitive-region scan) and `document.elementFromPoint()` (action
execution) both work in CSS-pixel space. On a 100%-scale 1x display these
happen to be identical, which is why it went unnoticed against the
single-machine demo-page smoke test -- but on Retina Macs (2x by
default), most Windows laptops (125-150% scaling presets), or a
browser-zoomed page, every click/type action would have landed at the
wrong pixel.

Fixed in `background.js` with `computeCaptureScale()`: rather than trust
`window.devicePixelRatio` alone (which misses browser-level page zoom),
it measures the REAL ratio directly -- captured bitmap width ÷ the
content script's reported CSS viewport width -- and applies it in both
directions: scaling DOM-scanned sensitive regions UP into device-pixel
space before drawing redaction, and scaling vision-detected click targets
DOWN into CSS-pixel space before sending to `elementFromPoint`.

### 5b. OCR-based redaction (`extension/ocr-redactor.js`)

DOM-attribute-based redaction misses sensitive text that isn't wrapped in
a recognizable `<input type=password>`/autocomplete hint: plain text on a
confirmation screen, a canvas-rendered or heavily-JS-framework'd field, a
card number that's part of an embedded image. OCR reads the actual
rendered pixels, so it catches those too -- this is what makes redaction
"work everywhere" rather than only on forms whose authors used textbook
HTML attributes.

Runs Tesseract.js in the same offscreen document as the ONNX model (same
`ServiceWorkerGlobalScope` restriction applies to its internal Worker use
as onnxruntime-web's). Bundled fully locally under `extension/vendor/tesseract/`
and `extension/vendor/tessdata/` (~16MB: worker, WASM core, `eng.traineddata`)
-- same "no remote CDN" CSP constraint as the ONNX runtime, same privacy
property (the raw screenshot never leaves the device, OCR included).
Regex classifiers (card/Aadhaar/CVV/PIN/password, mirroring
`content.js`'s `SENSITIVE_NAME_PATTERNS` but applied to OCR'd on-screen
text instead of DOM attribute names) run per OCR'd line, merging
constituent word boxes into a redaction region.

**Verified in this session, honestly:**
- Actually ran the real vendored files (not the CDN) against a synthetic
  test image with known card/CVV/Aadhaar/name text, using Node +
  `tesseract.js`. Caught a real API-shape bug doing this: Tesseract.js v7
  needs `{blocks: true}` passed to `recognize()` and returns
  `blocks→paragraphs→lines→words` with `{x0,y0,x1,y1}` word boxes, not the
  `{lines: [...]}` shape with `{x,y,width,height}` boxes an earlier draft
  assumed from memory -- fixed and re-verified against real OCR output.
- Built a proper labeled benchmark (§5d) and ran it for real: **100%
  precision, 100% recall** on a 16-case synthetic test set (8 sensitive:
  card/Aadhaar/CVV/PIN/password variants, 8 safe: name/email/phone/order
  ID/address/zip/generic text) -- see
  `training/redaction_benchmark_report.json`. Average OCR time: ~76-130ms
  per single-line test image on this sandbox's CPU (real full-page
  screenshots, with more text and higher resolution, will be slower --
  the popup's live `ocr_ms` metric is the number that matters on your
  actual demo machine, not this).
- Honest caveat this benchmark does NOT cover: 16 clean, synthetically
  rendered, single-font lines is a controlled test, not messy real-world
  OCR conditions (low contrast, small fonts, rotated/skewed text,
  screenshots with UI chrome around the text). Real-page recall will be
  lower than 100% -- run `training/benchmark_redaction.mjs` against
  screenshots of YOUR actual target pages before judging if you want a
  number that reflects that.
- A quick false-positive sanity check on adjacent 13-19 digit non-card
  numbers (a long ticket/order ID) showed the card regex CAN false-positive
  on those -- documented, not hidden: redaction erring toward
  over-redaction is the safer failure direction for a privacy tool, but
  it's a real precision cost worth knowing about.

### 5c. Fully local, no CDN -- confirmed the way it matters

`eng.traineddata` (~2MB gzip) was vendored by downloading it once into
`extension/vendor/tessdata/`, not left to fetch from a CDN at runtime --
consistent with the ONNX model's existing "everything local" story and
the MV3 CSP's `script-src 'self'` constraint (Tesseract's `worker.min.js`
is also a same-origin extension resource, not loaded remotely).

### 5d. Benchmark scripts (real, runnable, not aspirational)

```
# OCR-redaction precision/recall (Node, uses the SAME classifyLines()
# and regexes the extension ships, imported directly -- not a
# reimplementation that could drift out of sync)
npm install                      # root package.json, tesseract.js dev dependency for this script only
cd labeling && python3 generate_redaction_testset.py --out ../training/redaction_testset
cd ../training && node benchmark_redaction.mjs --testset redaction_testset

# Detection precision/recall/latency (Python, reuses validate_decode.py's
# preprocess()/decode() verbatim against a labeled YOLO dataset)
python3 benchmark_detection.py --dataset ../labeling/sample_dataset --model ../extension/vendor/ui_detector.onnx
```

Both were run for real in this session (not just written):
`training/redaction_benchmark_report.json` and
`training/detection_benchmark_report.json` are actual output, not sample
data. The detection benchmark, run against `labeling/sample_dataset` (one
real page, labeled via Step 1's pipeline) with the shipped
untrained smoke-test model, correctly shows 0 recall -- exactly the
"Elements detected: 0, expected not a bug" result from the earlier smoke
test, now with a repeatable script instead of a one-off log line. Point
`--model` at your real trained `best.onnx` and `--dataset` at a real
labeled set (Step 1, run with real internet access) for numbers that
mean something for judging.

### 5e. Popup dashboard + exportable report

Added `ocr_ms`, `ocr_regions_found`, `ocr_degraded` (true if OCR failed
mid-run -- redaction always falls back to DOM-only rather than blocking
the pipeline), and `capture_scale` (the DPI-fix ratio; 1 on a 100%-scale
1x display, ~2 on Retina/most HiDPI laptops) to the live metrics grid.
Added an **Export benchmark JSON** button that downloads the exact
per-step metrics from the run just performed -- real telemetry you can
hand judges alongside, or show live during, the demo (see `DEMO.md`).

**Not done / honestly out of scope for this session:** a memory-usage
metric. `performance.memory` is Chrome-only, imprecise, and not
straightforwardly available from a Manifest V3 service worker/offscreen
document without more plumbing than this session had budget for --
flagged rather than faked with a made-up number.

## Live demo guidance

See `DEMO.md` for how to run this in front of judges on a site they pick,
including exactly where the "real AI" is in this pipeline (Anthropic's
Claude API, called from `server/main.py`) and what to do if judging-room
wifi can't reach it.

