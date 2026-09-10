# Design decisions

Big choices and the reasoning behind them, so the team can defend them to judges.
Newest last. Each entry: what we chose, what we rejected, and what would change our mind.

---

## D1 — DOM first, vision for what the DOM cannot see

**Decision.** The privacy filter runs a deterministic DOM/text layer as its primary detector.
The vision layer covers `<img>`, `<canvas>`, `<video>`, PDFs and cross-origin frames.

**Rejected.** Pixel-only perception (the approach in `reference/teammate`).

**Why.** Three measurable reasons.
- *Accuracy.* `autocomplete="cc-csc"` and `input[type=password]` are declarations by the page
  author. No screenshot model beats them, and they carry field *semantics* — "email field" vs
  "name field" — which is what lets the VLM fill a form instead of guessing from geometry.
- *Resources* (20% of the score). The DOM pass over the demo site costs **2–19 ms** and loads
  no model. A pixel-only path pays a 13 MB WASM load plus per-frame inference before it can
  say anything.
- *Precision* (20% of the score). Verhoeff and Luhn checksums apply to DOM text and eliminate
  false positives that a pixel model cannot rule out.

**What would change our mind.** If real-world targets turn out to be predominantly canvas- or
PDF-rendered, the balance shifts. The architecture already supports that: both layers feed the
same fusion step.

---

## D2 — Solid fill for text, pixelation only for faces

**Decision.** Every text-like PII type is painted over with an opaque box. Only `FACE` is
pixelated.

**Why.** Blurred or pixelated *text* is recoverable. The glyph alphabet is small and known, so
deconvolution or a super-resolution model reverses it; this is a documented attack, not a
theoretical one. Faces have no small alphabet to brute-force, and a solid black box over every
avatar would destroy the layout context the VLM needs ("there is a person's photo here").

**Consequence.** `REDACTION_STYLE` in `lib/protocol.ts` is the single place this is encoded, and
`FACE` is the only entry that is not `block`.

---

## D3 — The vault lives in the side panel, not the background worker

**Decision.** The vault, the sanitizer and the egress guard all run in the side panel. The
background worker only moves bytes; the content script only touches the page.

**Rejected.** Vault in the background service worker.

**Why.** The side panel is the only extension context with a DOM (canvas, for redaction) and
WebGPU (for M4's models). Splitting the pipeline across two contexts would mean shipping
screenshots back and forth. An MV3 service worker is also killed and restarted at the browser's
discretion, which is a poor host for session state.

**Cost.** The session is scoped to the panel being open. Closing it drops every token and value —
which we treat as a feature, and state in the UI.

---

## D4 — Profile-seeded matching instead of an NER model

**Decision.** Names and free-text addresses are detected by literal matching against the user's
own profile, not by a named-entity model.

**Why.** No regex can distinguish "Ananya Iyer" from any other two capitalised words, and a
browser-sized NER model costs megabytes and milliseconds to still get it wrong on Indian names.
The user already tells us their name — that turns an open-ended ML problem into a string search.

**Measured.** On the demo site this is the difference between **0.976 and 0.905 recall**
(`docs/PROGRESS.md`). The gap is entirely names and addresses.

**Limits, stated plainly.** It only catches *the user's own* details. A third party's name on
screen — "Rajesh Iyer" in the demo's saved-cards table — is not detected, and shows up as the
single miss in our numbers. A small NER model is the M5+ answer if time allows; we report the
miss rather than hide it.

---

## D5 — Vault values are sent into the content script to locate them on screen

**Decision.** `perceive` carries `knownValues` (the vault's values plus types) to the content
script, which finds them in page text and returns pixel rects.

**Rejected.** (a) Keeping values strictly in the panel and doing without redaction boxes for
names. (b) Shipping the page's entire visible text back to the panel for matching there.

**Why.** (a) is unacceptable: it tokenizes the name in the JSON but leaves it *legible in the
screenshot*, which is the worse leak of the two. (b) doubles the data moved per step and still
cannot produce rects, because only the page context can build a `Range`.

**Why it is safe.** Content scripts run in an isolated world that page JavaScript cannot read.
And the decisive point: if the value is displayed on the page, the page already has it — the
needle reveals nothing new. If it is *not* on the page, the isolation protects it.

---

## D6 — Context may cross into a sibling label element, but only a real label

**Decision.** A text block's context includes the previous sibling when that sibling looks like
a label (short, and a `<dt>`/`<th>`/`<label>`-ish tag), plus the column `<th>` for a `<td>`.

**Why.** Displayed PII is almost always `label`-then-`value` in two elements —
`<dt>Date of birth</dt><dd>14/03/2001</dd>`. Without this, every context-dependent rule
correctly declines to fire and recall on profile and statement pages collapses. Measured:
this change alone took `profile.html` from 0.667 to 1.000 recall.

**Why the restriction.** The first version accepted any previous sibling. A paragraph mentioning
"one-time password" then lent OTP context to the *next* paragraph and turned an unrelated
4-digit number into a false detection. `looksLikeALabel()` exists because of that measured
regression, not on principle.

---

## D7 — The egress guard skips the screenshot field

**Decision.** `screen.image_jpeg_b64` is excluded from the guard's text scan.

**Why.** Running text validators over base64 JPEG bytes is meaningless — PII inside an image is
not ASCII in the compressed stream. Worse, across a megabyte of random-looking digits a
Luhn-valid 16-digit run appears by chance, so the guard would block every request.

**How the image is protected instead.** Pixel-level redaction, verified by the OCR leak test in
`eval/`: OCR the redacted image and count ground-truth PII strings still recoverable. Target zero.
The guard covers strings; the leak test covers pixels. Neither substitutes for the other.

---

## D8 — Passwords are never read out of the page

**Decision.** The content script returns `••••••••` or `''` for `input[type=password]`, never the
value. No token is minted for it; the wire element carries `filled: true|false`.

**Why.** The agent never has a legitimate reason to *read* a password — only to know whether the
field is done. Not copying it means it cannot leak from the extension, the vault, or a log, and
there is no token for a hallucinating model to ask us to type somewhere else.

---

## D9 — Profile stored in `storage.session`, not `storage.local`

**Decision.** The profile persists in `browser.storage.session` (memory-backed, wiped when the
browser closes) rather than on disk.

**Why.** `storage.local` writes PII to disk in plaintext. CLAUDE.md allows persistence only if
WebCrypto-encrypted, and that work belongs in M7. Until then, not writing it at all is the safer
default and costs the user one re-entry per browser session.

---

## D10 — Provider-agnostic VLM with a deterministic mock

**Decision.** The server talks to any OpenAI-compatible endpoint via `VLM_BASE_URL` /
`VLM_MODEL` / `VLM_API_KEY`, and ships a deterministic rule-based planner used when no endpoint
is configured.

**Why.** It keeps vLLM, Ollama and hosted open-weights endpoints swappable, which the problem
statement requires ("any offline deployable model"). The mock means the whole loop and its tests
run offline with no key — and, as `reference/teammate` also concluded, it means the demo does
not die if the venue Wi-Fi does.

---

## D11 — The sent image is capped at 1280 px on the long edge

**Decision.** The redaction renderer downscales to a maximum long edge of 1280 px
before painting boxes and encoding.

**Why.** Measured. A 1280×1600 viewport at dpr 2 is a 2560×3200 canvas, and rendering
plus JPEG-encoding it took **490 ms** — more than twice everything else in the pipeline
combined, and the dominant term in end-to-end latency (15% of the score). Capping the
long edge took it to **193 ms** and the payload from **145 KB to 42 KB**.

**What it costs.** Nothing measurable. VLMs downscale to roughly this size internally
anyway, so the model was never going to see those pixels. Redaction boxes are computed
from DOM rects in CSS pixels and scaled at draw time, so their accuracy does not depend
on the output resolution at all.

**Consequence.** `screen.width/height` on the wire are the *rendered* dimensions, and
any `click_xy` the server returns is in that space. The agent divides by
`PipelineOutput.imageScale` before handing a coordinate to the page.

---

## D12 — The deterministic planner does not report a field count

**Decision.** The `done` summary says "filled every field I could", not "filled N fields".

**Why.** The client sends only the last 8 history entries, so any count the server
derives under-reports a longer run — it claimed 8 after filling 9. Rather than grow the
payload to make a cosmetic number correct, the server stops asserting it and the client,
which knows the true total, logs it.

*(D10 applies from M3; recorded during M2 because it shaped the protocol.)*

---

## D13 — YuNet for face detection

**Decision.** `face_detection_yunet_2023mar.onnx` from the OpenCV Zoo — **227 KB**.

**Rejected.** face-api.js + TinyFaceDetector (what `reference/teammate` used), and a
general-purpose detector fine-tuned for faces.

**Why.** face-api.js is unmaintained and drags TensorFlow.js in alongside our
onnxruntime-web — two inference runtimes in one extension, for one model. A general
detector would be 10–40× the size for a job this specific. YuNet is purpose-built,
is the model OpenCV itself ships, and at 227 KB it is smaller than most of the icons
on a modern web page.

**Measured** (MacBook, 1280×900 frame, steady state after warm-up):

| Backend | Session load | Inference p50 | Range |
|---|---|---|---|
| WebGPU | 312 ms | **50 ms** | 44–69 ms |
| WASM | 1,497 ms | **181 ms** | 158–315 ms |

WebGPU is 3.6× faster, and the WASM number is not a footnote: Firefox has no WebGPU
today, so 181 ms is the real figure on one of the two browsers we must support.

---

## D14 — A second, close-up pass on small images

**Decision.** After the whole-frame pass, re-run the model on up to four *small*
image regions (≤320 device px on the long edge) that no face was found in.

**Why.** Measured, and it was a genuine hole. Letterboxing a 1280×900 frame into the
model's 640×640 input halves everything — and on a retina capture it quarters it. A
real photographic face was found in a 200 px image and **missed entirely at 96 px**,
which is exactly what a profile avatar is. Cropping to the image's own DOM rect and
letterboxing *that* upscales the face instead of shrinking it:

| Image width | Whole-frame only | With close-up pass |
|---|---|---|
| 420 px | 0.905 | 0.905 (no extra pass needed) |
| 200 px | 0.832 | 0.832 (no extra pass needed) |
| 96 px | **missed** | **0.898** |
| 48 px | **missed** | **0.694** |

**What it costs.** ~50–90 ms per extra pass, only when a small image had no hit.
Capped at four per frame so a photo gallery cannot stall the agent loop. The DOM
supplies the crop rects for free, which is what makes this cheap enough to do at all.

---

## D15 — Ship ORT's "jsep" build, and only once

**Decision.** Import `onnxruntime-web` (the default entry) and stage
`ort-wasm-simd-threaded.jsep.wasm` in `public/ort/`. Vite is aliased to ORT's
*non-bundled* ESM build.

**Why, in painful detail,** because this is easy to get wrong and expensive when you do:

- ORT 1.29 ships four different WASM binaries, and each JS entry point references
  exactly one. `onnxruntime-web` → **jsep** (27 MB, WebGPU + WASM in one file).
  `onnxruntime-web/webgpu` → **asyncify** (25 MB). Importing one and staging the
  other ships 52 MB and loads neither.
- The default export is the *bundle* build, which inlines the wasm loader and makes
  Vite emit its own hashed copy of the binary — on top of the one in `public/`. The
  first working build was **54 MB, half of it a duplicate**. Aliasing to the
  non-bundled build brings it to **28.5 MB**, with exactly one `.wasm` in the output.
- The alias must be anchored (`/^onnxruntime-web$/`) and point at an absolute file
  path: the replacement starts with the package name, so a plain string alias matches
  its own output and recurses until the build dies, and `onnxruntime-web` exports
  neither `./dist/*` nor `./package.json`.

**Verification.** `find .output -name '*.wasm'` should return exactly one file. That
check is worth keeping in the release routine.

---

## D16 — `numThreads = 1`

**Decision.** ORT's WASM threading is pinned off.

**Why.** Threaded WASM needs `SharedArrayBuffer`, which needs cross-origin isolation,
which extension pages do not have by default. Asking for threads without it fails at
*load* rather than degrading gracefully. The "simd-threaded" binary runs
single-threaded perfectly well, and the measured numbers above are with threads off —
so they are the honest floor, not a best case.
