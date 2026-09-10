# Progress

Status board. Updated at the end of every milestone (CLAUDE.md).

| Milestone | State |
|---|---|
| M0 Teammate review | ✅ `docs/TEAMMATE_REVIEW.md` |
| M1 Skeleton | ✅ WXT extension building for Chrome + Firefox |
| M2 DOM privacy layer | ✅ validators, vault, sanitizer, fusion, redaction, egress guard, side panel |
| M3 Agent loop | ✅ FastAPI server, provider-agnostic VLM, action executor, confirm-before-submit |
| M4 Vision layer v1 | ✅ YuNet face detection via onnxruntime-web (WebGPU → WASM), image-region flagging, change detection |
| M5 Custom detector | ⬜ next — synthetic data → train → ONNX → integrate; OCR on image regions |
| M6 Eval harness | ⬜ one command rebuilds every number |
| M7 Polish | ⬜ disclosure levels, latency, Firefox pass, demo script, backup video |

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
