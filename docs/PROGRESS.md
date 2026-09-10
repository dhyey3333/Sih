# Progress

Status board. Updated at the end of every milestone (CLAUDE.md).

| Milestone | State |
|---|---|
| M0 Teammate review | ✅ `docs/TEAMMATE_REVIEW.md` |
| M1 Skeleton | ✅ WXT extension building for Chrome + Firefox |
| M2 DOM privacy layer | ✅ validators, vault, sanitizer, fusion, redaction, egress guard, side panel |
| M3 Agent loop | ✅ FastAPI server, provider-agnostic VLM, action executor, confirm-before-submit |
| M4 Vision layer v1 | ✅ YuNet face detection via onnxruntime-web (WebGPU → WASM), image-region flagging, change detection |
| M5 Custom detector | ✅ synthetic data engine, training, ONNX export, integrated; OCR on image regions |
| M6 Eval harness | ✅ `uv run python -m eval.run_all` rebuilds every number |
| M7 Polish | ✅ redesigned side panel, L0 local-only steps, Firefox lint pass, submission + demo docs |

---

## 2026-09-10 — M0, M1, M2

### Built

**Extension** (`extension/`, WXT 0.21.4 + TypeScript, MV3, Chrome + Firefox from one codebase)

- `entrypoints/background.ts` — orchestrator. Captures the tab (throttled to Chrome's ~2/s
  limit), routes messages, injects the content script into tabs that were already open.
- `entrypoints/content.ts` — snapshot + action executor. Framework-safe typing through the
  native value setter.
- `entrypoints/sidepanel/` — the demo surface: task box, original ↔ "what the server sees"
  toggle, detection list, payload inspector, latency bars, egress-guard banner, profile form.
- `lib/pii/` — `checksums` (Verhoeff, Luhn, PAN holder-type), `validators` (13 rules),
  `dom-heuristics` (autocomplete + label/name/placeholder), `sanitize`, `vault`, `egress`.
- `lib/dom/` — `accessibility` (accessible names, roles, visibility), `text-blocks`
  (block grouping + `Range` → pixel rects), `snapshot`.
- `lib/redact/` — `fuse` (containment-based merging, priority, padding), `render` (solid fill,
  face pixelation, token labels, Set-of-Mark badges).
- `lib/pipeline.ts` — detect → tokenize → fuse → redact → sanitize → guard.
- `lib/eval/score-page.ts` + `scripts/domcheck.ts` — the same perception code, built as a plain
  page bundle so any `data-pii`-annotated page can be scored automatically.

**Demo site** (`demo-site/`) — three pages, every sensitive element annotated `data-pii="TYPE"`
as ground truth. All data fake; Aadhaar numbers are Verhoeff-valid and cards Luhn-valid so the
detectors are genuinely exercised.

### Verification

- `npm test` — **159 tests pass** (7 files).
- `npx tsc --noEmit` — clean.
- `npm run build` and `npm run build:firefox` — both succeed. Chrome emits `side_panel` +
  `sidePanel` permission; Firefox emits `sidebar_action` + `background.scripts`.
- Bundle: **66 KB total**, no models loaded yet.

### Measured — PII detection on the demo site

Real browser, 1280×1600 viewport, demo profile loaded, scored against `data-pii` ground truth
by `lib/eval/score-page.ts`.

| Page | Ground truth | DOM-reachable P | R | F1 | Vision-required | Perceive time |
|---|---|---|---|---|---|---|
| `kyc.html` | 18 | **1.000** | **1.000** | **1.000** | 0/2 | 18.7 ms |
| `profile.html` | 13 | **1.000** | **1.000** | **1.000** | 0/1 | 3.1 ms |
| `bank.html` | 14 | **1.000** | **0.929** | 0.963 | — | 11.9 ms |
| **Total** | **45** | **1.000** | **0.976** | **0.988** | **0/3** | — |

- **Precision 1.000** — zero false positives, including against deliberate decoys: a 12-digit
  order number, a Luhn-invalid card, "Control panel" (vs the PAN rule), a non-birth date, a
  helpline number and a result count.
- **The one miss** is `"Rajesh Iyer"`, a *third party's* name in the saved-cards table. There is
  no NER model, and the vault only knows the user's own details (D4). Reported, not hidden.
- **0/3 vision-required** (2 faces, 1 ID-card scan) is expected before M4 and is exactly what
  the vision layer is for. Including them, overall recall is **0.911**.
- Without a profile loaded, recall falls to **0.905** — the gap is entirely names and addresses,
  which is the measurement behind D4.

### Measured — client resources

| Stage | Time |
|---|---|
| DOM snapshot | 1.8–19.5 ms |
| PII detection | 0.1–0.5 ms |
| Box fusion | 0.0–0.7 ms |
| Egress guard | < 1 ms (16 tests, 50 KB payloads) |
| **Total perception** | **2–20 ms, no model loaded** |

Screenshot capture adds ~50–150 ms and is throttled to Chrome's ~2 captures/second.

### Two bugs found by measuring, not by reading

1. **snake_case field names defeated every keyword rule.** `_` is a word character in JS regex,
   so `\baadhaar\b` never matched `name="aadhaar_no"` — and `name`/`id` attributes are
   `snake_case` or `camelCase` far more often than prose. `fieldContext()` now splits on
   separators and case transitions first.
2. **Names were tokenized in the JSON but left legible in the screenshot.** The vault's
   known-value matching ran only in the text sanitizer, not in the detector that produces
   redaction boxes — the worse of the two leaks. Fixed by D5.

A third issue was a bad *label*, not a bad detector: the demo site marked a "District" field as
non-PII. A district is address data; the ground truth was corrected, not the rule.

### Not done yet

- No vision model — faces and the ID-card scan are **not** redacted (M4).
- No server, no agent loop, no action execution end-to-end (M3).
- The scoring numbers above are produced by driving a browser by hand. M6 automates this into
  `uv run python -m eval.run_all`.
- `uv` is not installed on this machine; needed before `server/` and `ml/` work starts.
  Note also that Python here is 3.14, and Ultralytics/PyTorch wheels lag new Python releases —
  M5 training will want a 3.11/3.12 environment.

---

## 2026-09-10 — M3 Agent loop

### Built

**Server** (`server/`, FastAPI + Pydantic on Python 3.12, deps via `uv`)

- `app/schemas.py` — mirrors `lib/protocol.ts`.
- `app/validators.py` + `app/egress.py` — an *independent* implementation of the
  high-confidence validators, run on every inbound payload. If raw PII arrives, the
  request is rejected with `422` rather than forwarded to a third-party model.
- `app/prompt.py` — the system prompt that teaches the model the redaction scheme:
  what `⟦TYPE_N⟧` and `⟦PROFILE.KEY⟧` mean, never to guess a redacted value, to act
  through element ids, and never to press an irreversible button.
- `app/vlm.py` — provider-agnostic OpenAI-compatible client (vLLM / Ollama /
  hosted), with a tolerant JSON extractor for small models that wrap output in prose.
- `app/planner.py` — deterministic planner. Completes the demo with no key, no GPU
  and no network, and is the guaranteed fallback when the VLM fails.
- `app/main.py` — `GET /health`, `POST /v1/step`.

**Extension**

- `lib/agent.ts` — the loop, with three gates that do not trust the model:
  unresolvable tokens are refused, irreversible actions stop for a human, and the
  step budget is bounded.
- Side panel — Run/Stop, a confirmation gate, the server settings and connection
  check, and a note saying which planner decided each step.
- `demo-site/apply.html` — an **empty** form, so the agent has something to fill.
  (`kyc.html` is pre-filled: that one is the privacy demo, this one the agent demo.)

### Verification

- `uv run pytest` — **62 tests pass**.
- `npm test` — **187 tests pass** (8 files). 249 across the repo.
- `npx tsc --noEmit` clean; both browser targets build.

### Measured — end-to-end, real browser against the live server

Task: *"Fill this form with my profile and stop before submitting"* on `apply.html`.

**9 steps, 9 fields filled, every one sent as a token and resolved locally, then
`done` without touching Submit.**

```
step 0  ⟦PROFILE.FULL_NAME⟧ → full_name        step 5  ⟦PROFILE.PAN⟧      → panNumber
step 1  ⟦PROFILE.EMAIL⟧     → email            step 6  ⟦PROFILE.ADDRESS⟧  → address
step 2  ⟦PROFILE.PHONE⟧     → mobile_no        step 7  ⟦PROFILE.PINCODE⟧  → pincode
step 3  ⟦PROFILE.DOB⟧       → date_of_birth    step 8  ⟦PROFILE.UPI⟧      → vpa
step 4  ⟦PROFILE.AADHAAR⟧   → aadhaar_no       step 9  done — stopped before submit
```

The server saw only tokens. Not one real value crossed the network.

| Stage | Time |
|---|---|
| detect PII | 0.7 ms |
| fuse boxes | 1.5 ms |
| redact pixels | 192.7 ms |
| tokenize | 10.4 ms |
| egress guard | 9.7 ms (142 strings) |
| **client total** | **215.7 ms** |
| network round trip | 52 ms |
| server (guard 3.8 + planner 0.7) | 4.8 ms |

Payload: **42 KB** JPEG at 1024×1280, from a 2560×3200 capture.

### One optimization, one bug, both found by measuring

1. **Redaction was 490 ms** — rendering and encoding an 8-megapixel canvas dominated
   the whole pipeline. Capping the output at 1280 px on the long edge took it to
   **193 ms** and the payload from **145 KB to 42 KB**, at no cost in usefulness
   (D11). This also required fixing the `click_xy` coordinate space.
2. **A zero-size capture** (minimized window, backgrounded tab) threw an opaque
   `drawImage … width or height of 0` from inside canvas. It now fails with a
   message the UI can actually show the user.

Also corrected: the planner claimed "filled 8 fields" after filling 9, because the
client sends only a recent history window. It no longer asserts a count (D12).

### Not done yet

- **No vision layer.** On `kyc.html` the profile photo and the ID-card scan are still
  fully legible — name, date of birth and Aadhaar number are readable inside the
  image. The DOM cannot see into an `<img>`; that is exactly M4's job, and it is the
  most visible remaining gap.
- No VLM has been exercised against a live endpoint — the loop above ran on the
  deterministic planner. The VLM path has unit tests but needs a real model booked
  against it before the demo.
- `eval/` is still manual (M6).

---

## 2026-09-10 — M4 Vision layer v1

### Built

- `lib/vision/runtime.ts` — onnxruntime-web setup. WebGPU first, WASM fallback, WASM
  binary bundled (MV3 forbids remote code), `numThreads = 1` (no SharedArrayBuffer in
  extension pages), session created once and released on `pagehide`.
- `lib/vision/yunet.ts` — letterbox pre-processing (BGR, 0–255, NCHW — an OpenCV model,
  not an ImageNet one), three-stride decode, NMS.
- `lib/vision/change.ts` — 48×48 greyscale signature; skips the model when the screen
  has not moved.
- `lib/vision/index.ts` — two-pass detection plus DOM image-region flagging.
- `scripts/fetch-assets.mjs` — stages the 27 MB WASM from `node_modules` (gitignored);
  the 227 KB model is committed so a fresh clone runs offline.
- Side panel — vision on/off toggle and a live status line: backend, model size, load
  time, inference time, faces found, frames skipped.

### Verification

- `npm test` — **204 tests** (9 files), including 14 covering the coordinate math.
- `uv run pytest` — 62. **266 across the repo.**
- Typecheck clean; Chrome and Firefox both build at **28.52 MB**, exactly one `.wasm`.

### Measured — the model

MacBook, WebGPU adapter available, 1280×900 frame, steady state after warm-up.

| Backend | Session load | Inference p50 | Range |
|---|---|---|---|
| WebGPU | 312 ms | **50 ms** | 44–69 ms |
| WASM | 1,497 ms | **181 ms** | 158–315 ms |

Model 227 KB. WebGPU is 3.6× faster; the WASM figure is the real one for Firefox,
which has no WebGPU today.

### Measured — recall vs face size

Real photographic portrait (public-domain, Wikimedia), drawn at four on-screen sizes.

| Image width | Whole-frame pass | + close-up pass |
|---|---|---|
| 420 px | 0.905 | 0.905 |
| 200 px | 0.832 | 0.832 |
| 96 px | **missed** | **0.898** |
| 48 px | **missed** | **0.694** |

The 96 px miss was the important finding: that is exactly the size of a profile
avatar. Letterboxing the whole frame into 640×640 leaves a small face with almost no
pixels. Re-running on the image's own DOM rect upscales it instead (D14).

Geometry verified independently at dpr 2 with two images at different positions and
scales — both boxes landed inside their source images.

### Measured — the M4 acceptance criterion

`kyc.html`, demo profile loaded, 1280×1600 viewport:

| | Detections |
|---|---|
| DOM + text layers only | 16 |
| with the vision layer | **18** |

The two new ones are precisely the gap M3 closed with an apology:

- `⟦FACE_1⟧` over the profile photo — found by the model *and* the image hint
  independently (`detail: "avatar-like+vision"`), fused into one box, **pixelated**.
- `⟦ID_DOCUMENT_1⟧` over the ID-card scan — **blacked out**.

The card's name, date of birth and Aadhaar number were fully legible in the M3
screenshot. They are not any more.

### Two bugs the build caught, and one the measurement did

1. **52 MB of wasm for one model.** ORT ships four different WASM binaries and each
   JS entry references exactly one; `onnxruntime-web` needs *jsep*, while
   `onnxruntime-web/webgpu` needs *asyncify*. I staged one and imported the other.
2. **A duplicated 27 MB binary.** The default ORT entry is the "bundle" build, so Vite
   emitted its own hashed copy alongside the staged one — 54 MB total. Aliasing to the
   non-bundled build fixed it; the alias then had to be anchored, because the
   replacement starts with the package name and matched its own output until the build
   died. Now 28.5 MB with exactly one `.wasm`.
3. **Avatars were invisible to the detector** — see the table above.

### Not done yet

- **No OCR.** Text rendered inside an image is detected as a *region* (the whole card
  is redacted) but is not read, so PII inside an unflagged image — a screenshot of a
  bank statement, say — is not individually tokenized. That is M5.
- The custom multi-class detector (`password_field`, `payment_card`, `qr_code`,
  canvas-app widgets) is M5; today the vision layer only knows faces.
- Image-region flagging relies on alt text, class names and filenames. An ID card
  named `IMG_2043.jpg` is caught only if a face is visible in it.
- Still no live VLM run, and `eval/` is still manual (M6).

### Suggested commit

---

## 2026-09-11 — M7 Polish

### Built

**Side panel, redesigned.** The comparison *is* the product, so it became the hero: a
draggable wipe between your screen and what the server receives, in place rather than
side by side. Everything else is progressive disclosure underneath it. Also: a
single-accent palette where the accent means "safe", tabular numerals so the metrics
do not jitter, one easing curve throughout, a system-style confirmation sheet, full
light/dark support and `prefers-reduced-motion`.

**L0 — steps that never leave the device** (`lib/local-planner.ts`). The last
unimplemented piece of PLAN §3.5. If the page has *declared* what a field is
(`autocomplete="email"`) and the vault holds a matching value, there is nothing for a
model to reason about, so nothing is sent — no screenshot, no network, no third party.

Two hard limits, because "handled locally" must not mean "acted rashly":
- **It never clicks.** Every click, and therefore everything irreversible, goes
  through the normal path and its confirmation gate.
- **It acts only on the page author's declaration**, never on our own `kw:`
  heuristics. Those are good enough to redact on — over-redacting is safe — and not
  good enough to type on.

**Submission and demo docs.** `docs/SUBMISSION.md` maps every judging criterion to the
measurement behind it. `docs/DEMO.md` is a five-minute script with the failure modes
and the questions to expect.

### Verification

- `npm test` — **256 tests** (12 files). 62 server + 20 ml. **338 across the repo.**
- Typecheck clean; both targets build at 47.9 MB.
- `web-ext lint` on the Firefox build: **0 errors**, 7 warnings.
- `uv run python -m eval.run_all`: precision 1.000, recall 0.978, **leak test 0**.

### Measured — L0 on the empty application form

Nine fillable fields. Driving the local planner alone, with the network unavailable:

```
step 0  ⟦PROFILE.FULL_NAME⟧ → full_name   (page declares autocomplete=name)
step 1  ⟦PROFILE.EMAIL⟧     → email       (autocomplete=email)
step 2  ⟦PROFILE.PHONE⟧     → mobile_no   (autocomplete=tel)
step 3  ⟦PROFILE.ADDRESS⟧   → address     (autocomplete=street-address)
step 4  ⟦PROFILE.PINCODE⟧   → pincode     (autocomplete=postal-code)
step 5  escalate to server
```

**Five of nine fields filled with zero network requests.** It then correctly escalates
for Aadhaar, PAN, DOB and UPI — HTML's autocomplete vocabulary has no token for any of
them, so they only ever carry a `kw:` reason and are refused at L0 by design. That
split is the feature: the certain half is free, the uncertain half gets a model.

### On the Firefox lint warnings

0 errors. Of the 7 warnings, 4 are `DANGEROUS_EVAL` inside vendored WASM loaders
(Tesseract's worker, ORT's loader) — that is what `wasm-unsafe-eval` in our CSP is
for, and it is unavoidable for any on-device inference.

The other 2 say `data_collection_permissions` needs Firefox 140 while our floor is
115. Deliberate: an unknown manifest key is ignored by older Firefox, so keeping 115
costs nothing and keeps the extension installable a year further back. 115 is the real
floor — it is where `storage.session` landed, and we refuse to write PII to disk.

### Still open, and worth saying out loud

- **The custom detector is undertrained** — 12 epochs at 384 px on a laptop.
- **No real-screenshot test set.** Every number is from the demo site or synthetic
  pages. Hand-labelled real pages, never trained on, is the test we have not run.
- **No live VLM run.** The VLM path has unit tests; the end-to-end runs used the
  deterministic planner.
- **45.7 MB packed**, 58% of it the ONNX runtime.
- **A backup demo video has not been recorded.** `docs/DEMO.md` says to; do it.

### Suggested commit

```
feat: redesigned side panel, L0 local-only steps, and submission docs
```


---

## 2026-09-11 — M5 custom detector + OCR, M6 eval harness

### Built

**OCR** (`extension/lib/vision/ocr.ts`) — Tesseract.js over image, canvas and video
regions only, never full-page. The only layer that finds PII in an image the page
never labelled. Recognised text that is not PII is discarded immediately.

**Synthetic data engine** (`ml/synth/`) — 19 page recipes composed from 14 section
builders, randomised palette, font, density, viewport, DPR and scroll. Playwright
renders each and reads the ground truth back out of the DOM with
`getBoundingClientRect()`. **1,140 images, 15,056 boxes, zero manual annotation.**

**Training + export** (`ml/train.py`) — Ultralytics YOLO11n, evaluates on val *and*
test, exports ONNX at opset 17 with a static shape.

**Integration** (`extension/lib/vision/ui-detector.ts`) — two jobs: redaction classes
fuse with the other layers, and `text_input`/`button` become *elements* with ids above
`VISION_ID_BASE`, which the agent acts on by coordinate. That is what makes a
canvas-rendered app operable at all.

**Eval harness** (`eval/`) — one command, driving a real browser over the shipped
modules.

### Verification

- `npm test` — **231 tests** (11 files). `uv run pytest` — 62 (server) + 20 (ml).
  **313 across the repo.**
- Typecheck clean; both browser targets build.

### Measured — the whole pipeline, regenerated by one command

`uv run python -m eval.run_all` → `eval/results/RESULTS.md`

| Page | Items | Precision | Recall | F1 | Pixel recall |
|---|---|---|---|---|---|
| `kyc.html` | 18 | 1.000 | 1.000 | 1.000 | 100.0% |
| `profile.html` | 13 | 1.000 | 1.000 | 1.000 | 100.0% |
| `bank.html` | 14 | 1.000 | 0.929 | 0.963 | 95.5% |
| **all** | **45** | **1.000** | **0.978** | **0.989** | — |

**Leak test: 0.** The redacted image is rendered exactly as the extension renders it,
then read back with OCR; zero ground-truth values are recoverable from any page. This
is the number that answers "did anything survive", as opposed to "did we draw a box".

Latency, cold first look vs every step after (OCR caches per region):

| Page | Cold | Warm |
|---|---|---|
| `kyc.html` | 1,760 ms | **165 ms** |
| `profile.html` | 550 ms | **132 ms** |
| `bank.html` | 202 ms | **138 ms** |

### Measured — the custom detector

12 epochs at 384 px on an M-series MPS. **A smoke run**, not a shippable model: a real
one needs a GPU, more epochs and 960 px.

| Split | mAP50 | mAP50-95 | Precision | Recall |
|---|---|---|---|---|
| val | **0.809** | 0.585 | 0.923 | 0.763 |
| test | 0.716 | 0.409 | 0.651 | 0.707 |

Per class on val: `text_input` 0.987, `id_document` 0.948, `button` 0.929,
`pii_text` 0.817, `signature` 0.774, `payment_card` 0.401.

The val/test gap is the by-recipe split doing its job — held-out recipes carry a
different class mix, and the score drops honestly rather than flattering us.

On a held-out validation image the integrated detector finds 8/9 inputs, 2/2 buttons
and 8/8 `pii_text` at 91 ms, with boxes visually confirmed on the right pixels. It
also puts a false `pii_text` box on a decoy (`Reference code ₹121,243`) and misses an
email — which is what 12 epochs buys.

### Resources

| Asset | Size |
|---|---|
| ORT WASM (WebGPU + WASM in one) | 26.5 MB |
| Tesseract core + English data | 4.6 MB |
| UI detector ONNX | 10.0 MB |
| YuNet ONNX | 0.2 MB |
| **Packed extension** | **45.7 MB** |

Large, and worth saying plainly: the ORT runtime is 58% of it and the detector another
21%. FP16 export and a smaller ORT build are the obvious levers.

### Four bugs found by measuring

1. **Wrong pixel format for the YOLO model.** The detector reused YuNet's letterbox,
   which emits BGR 0–255 for OpenCV. Ultralytics wants RGB 0–1. Fed the wrong one it
   returned **2,187 boxes all at confidence exactly 1.0** — saturated nonsense that
   looks like a working detector until you plot the boxes. `PixelFormat` now makes the
   choice explicit at every call site.
2. **Software WebGPU is 50× slower than WASM.** A machine with no usable GPU still
   advertises a WebGPU adapter, backed by a software rasteriser. Measured on
   SwiftShader: ~4,000 ms per YuNet frame against ~79 ms on WASM. `checkWebgpu()` now
   inspects the adapter and declines it, which took the harness's per-page vision cost
   from **18,409 ms to 329 ms**. Real users on VMs and locked-down laptops hit this.
3. **A random 12-digit order number is Verhoeff-valid one time in ten.** Roughly that
   share of the dataset's negatives were labelled "not PII" while the extension
   correctly detects them — silently teaching the detector that real Aadhaar numbers
   are safe. Decoys are now re-checked against the real checksums.
4. **The first eval report was misleading in three ways** and was fixed rather than
   shipped: ground truth measured element rects instead of text rects (reporting 20%
   pixel recall for a redaction that covered every glyph), the latency column
   conflated the harness's own cost with the product's, and the backend table printed
   software-WebGPU numbers with no indication they were software.

### Not done yet

- **The detector is a smoke run.** 12 epochs at 384 px on a laptop. Needs a GPU.
- **No real-screenshot test set.** Everything is synthetic or the demo site. A
  hand-labelled set of real pages, never trained on, is the honest test.
- **Class imbalance**: ~5,700 `button` boxes against ~140 `qr_code`.
- Still no live VLM run.

### Suggested commit

```
feat: synthetic data engine, custom detector, and a one-command eval harness
```

---

```
feat: on-device vision layer — YuNet face detection via WebGPU

M4. onnxruntime-web with the WASM binary bundled for MV3, WebGPU preferred and
WASM as the real fallback for Firefox. YuNet (227 KB) finds faces in the capture;
a second close-up pass on small image regions recovers avatars the whole-frame
pass cannot see. DOM image hints flag ID scans and signatures. A 48x48 greyscale
signature skips the model when the screen has not changed.

Faces are pixelated, ID documents blacked out — the two things left legible at
the end of M3. On the demo page detections go 16 -> 18, and the ID card's name,
DOB and Aadhaar number are no longer readable.

WebGPU 50 ms p50 / WASM 181 ms, 227 KB model, 28.5 MB packed. 204 extension
tests, 62 server tests, both targets build.
```

---

```
feat: agent loop — FastAPI server, provider-agnostic VLM, confirm-before-submit

M3. POST /v1/step takes sanitized, tokenized context and returns one UI action.
An independent inbound guard rejects any payload containing raw PII rather than
forwarding it to a third-party model. The VLM client speaks OpenAI-compatible to
vLLM, Ollama or a hosted endpoint; a deterministic planner completes the demo
with no key, no GPU and no network.

Client-side the agent loop adds three gates that do not trust the model:
unresolvable tokens are refused, irreversible actions stop for a human, and the
step budget is bounded.

Verified end to end in a real browser: 9 fields filled from tokens alone,
stopping before Submit. 215 ms client, 52 ms network, 4.8 ms server, 42 KB
payload. Capping the sent image at 1280px cut redaction from 490 ms to 193 ms.

62 server tests, 187 extension tests, typecheck clean, both targets build.
```

### M0–M2 commit (f62c6aa)

```
feat: on-device DOM privacy layer with measured 1.000 precision / 0.976 recall

M0–M2. WXT extension building for Chrome and Firefox, side panel with an
original ↔ sanitized preview and payload inspector, and the full DOM-side
privacy filter: 13 validators with Verhoeff/Luhn/PAN checksums, autocomplete
and label heuristics, stable tokenizer, in-memory vault, box fusion, canvas
redaction with Set-of-Mark, and an egress guard that blocks on any hit.

Scored against data-pii ground truth on the demo site: precision 1.000,
recall 0.976 over 42 DOM-reachable items, 2-20 ms per page with no model
loaded. Faces and the ID-card scan are not yet redacted; that is M4.

159 tests, typecheck clean, both browser targets build.
```
