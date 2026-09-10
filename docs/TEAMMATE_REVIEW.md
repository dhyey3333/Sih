# M0 — Review of `reference/teammate`

Source: `github.com/dhyey3333/Sih` @ `5135607` (2026-09-10), subdirectory `vision-agent-v2`,
copied to `reference/teammate/`. Read-only. `reference/` is gitignored, so nothing here is
part of our build.

~2,250 lines of hand-written JS/Python plus ~41 MB of vendored binaries.

## What's there

| Area | Files | State |
|---|---|---|
| Extension | `extension/` — `background.js` (483), `content.js` (254), `vision-detector.js` (218), `ocr-redactor.js` (218), `popup.js` (215), `offscreen.js` (46) | Working MV3 prototype, Chrome-only, plain JS, no build step |
| Vendored runtime | `vendor/ort-wasm-simd-threaded.wasm` (13 MB), `ort.wasm.min.mjs`, onnxruntime-web 1.29 | Bundled correctly for MV3's no-remote-code rule |
| Vendored OCR | `vendor/tesseract/` + `tessdata/eng.traineddata.gz` | Tesseract.js, offline |
| Face model | `models/tiny_face_detector_*` (189 KB) + `face-api.min.js` | face-api.js TinyFaceDetector |
| Custom detector | `vendor/ui_detector.onnx` (12 MB) | Trained on 1–2 images — **mAP 0**, per its own report |
| Server | `server/main.py` (229) | FastAPI, Set-of-Mark protocol, Anthropic VLM + rule-based fallback |
| Data engine | `labeling/generate_dataset.py` (164), `urls.txt` (177 URLs) | Playwright, DOM-derived YOLO labels |
| Training | `training/train.py`, `prepare_yolo_dataset.py`, two benchmark scripts | Ultralytics wrapper, ran end-to-end |

Their README is unusually honest about what was and wasn't verified — worth keeping that habit.

## The central design difference

They went **fully vision-based on purpose**, dropping DOM access entirely. Their `main.py`
states the cost plainly: the server "can no longer tell 'email field' from 'name field' …
only 'this is generically an input'".

We take the opposite default: **DOM first, vision for what the DOM cannot see.** The reasons
are measurable rather than aesthetic.

- *Accuracy.* `autocomplete="cc-csc"` is a declaration by the page author. No detector trained
  on screenshots will beat it, and the field semantics it gives us are what let the VLM fill a
  form correctly rather than guess from box geometry.
- *Latency and resources.* Our DOM pass over the demo site takes **2–19 ms** with no model
  loaded. Their pipeline pays a 13 MB WASM load plus per-frame ONNX and OCR before it can say
  anything at all.
- *Precision.* Checksums (Verhoeff, Luhn) run on DOM text and cut false positives that a
  pixel-only model cannot rule out.

Their approach is the right one for the cases where the DOM is empty — canvas apps, PDFs,
`<img>` content, cross-origin frames. That is precisely the scope we've given the vision layer
in M4. So this is a difference of *default*, not a disagreement, and the review is not a
verdict that their work was wrong.

## Reuse

**Take.**
1. The vendored onnxruntime-web WASM set. It is the correct 1.29 build, laid out for MV3, and
   solves the `wasm-unsafe-eval` / no-remote-code problem we would otherwise re-solve in M4.
2. The vendored Tesseract.js + `eng.traineddata`. Offline OCR with no network fetch.
3. `labeling/generate_dataset.py` and `urls.txt` as the starting point for `ml/synth`. The idea
   of running the DOM scan **once, offline** to produce free labels is exactly PLAN §6.1, and
   177 curated URLs is real work already done.
4. Their honest per-step "verified / not verified" README convention.

**Adapt.**
5. `ocr-redactor.js` — the redaction benchmark (16 cases, P/R/F1 = 1.0, avg 76 ms OCR) is a
   genuine result. Port the crop-then-OCR-then-validate flow into `lib/vision/`, but drive it
   from our validators so the PII taxonomy stays single-sourced.
6. Set-of-Mark numbering. We reached the same design independently; theirs confirms it works
   against a real VLM.

**Drop.**
7. `vendor/ui_detector.onnx`. Its own `detection_benchmark_report.json` records mAP 0 on a
   1-image dataset. It is a plumbing artefact, not a model. M5 retrains from scratch.
8. `face-api.min.js` + TinyFaceDetector. face-api.js is unmaintained and drags in TensorFlow.js
   alongside our onnxruntime-web. One inference runtime, not two: use YuNet or BlazeFace as ONNX.
9. Plain-JS, Chrome-only, no-build extension structure. We need Firefox and type safety.
10. `CORSMiddleware(allow_origins=["*"])` on the server — fine for a hackathon laptop, not
    something to carry forward.
11. `server/__pycache__/` committed to the repo.

## Things to raise with them

- **The mAP 0 detector is currently the thing the pipeline depends on.** Worth flagging early;
  it needs the full data-generation run on a machine with real internet, not a fix in code.
- **Dropping DOM access loses field semantics**, and field semantics are what the form-filling
  demo is built on. Hybrid gets both.
- Their OCR redaction numbers are the strongest verified result in the repo. Keep that test set
  — it should become part of our `eval/` leak test.

## Net

Roughly a day of integration work saved on the WASM/OCR vendoring and the data generator, one
model to discard, and one architectural decision worth discussing as a team before M4.
