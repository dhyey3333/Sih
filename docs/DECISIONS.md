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

**Why.** `storage.local` writes PII to disk in plaintext, which is not acceptable for a tool
whose entire claim is that personal data stays put.

**Settled, not deferred.** This was first written as "until we build encrypted persistence",
and on review we are keeping it as the permanent answer. WebCrypto persistence would mean a
passphrase the user must set and re-enter, a key-derivation step to get wrong, ciphertext on
disk for an attacker to take away and work on offline, and a new prompt in the one surface that
is supposed to be simple — all to save one re-entry per browser session. "The profile is gone
when you close the browser" is a shorter sentence to defend than any encryption scheme we could
ship, and it is the stronger privacy position.

**What we give up.** The user re-enters their profile once per browser session. The UI says so
rather than hiding it.

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

## D15 — One ORT build per target, and only one copy of it

**Decision.** Alias `onnxruntime-web` per browser: Chrome gets the *jsep* build
(`ort.min.mjs`, WebGPU + WASM in one 27 MB binary), Firefox the plain WASM build
(`ort.wasm.min.mjs`, 13 MB). Both binaries are staged in `public/ort/`; a
`build:publicAssets` hook drops the one the target cannot use. Vite is aliased to
ORT's *non-bundled* ESM builds in both cases.

**Why the split.** Firefox has no WebGPU today, so `runtime.ts` was always going to
choose the WASM provider there — the jsep binary put 14 MB of code in the package
that could never execute. Splitting costs one hook and takes the Firefox artifact
from **47.9 MB to 33.8 MB**, a 30% cut on the criterion that measures client-side
resource use. Chrome is unchanged, because on Chrome the WebGPU half is the point.

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

**Verification.** `find .output -name 'ort-*.wasm'` returns exactly one file per
target, and `eval/smoke_extension.py` loads that file from inside the packed
extension and hands it to `WebAssembly.compile`. A wrong `wasmPaths`, a damaged
copy, or a CSP that forbids WASM fails nowhere else.

---

## D16 — `numThreads = 1`

**Decision.** ORT's WASM threading is pinned off.

**Why.** Threaded WASM needs `SharedArrayBuffer`, which needs cross-origin isolation,
which extension pages do not have by default. Asking for threads without it fails at
*load* rather than degrading gracefully. The "simd-threaded" binary runs
single-threaded perfectly well, and the measured numbers above are with threads off —
so they are the honest floor, not a best case.

---

## D17 — OCR on image regions only, never full-page

**Decision.** Tesseract.js runs on `<img>`, `<canvas>` and `<video>` regions, at most
three per frame, document-like ones first. Never over the page as a whole.

**Why.** Page text already comes from the DOM — exactly, with perfect boxes, in
microseconds. OCR over the same text would be slower, less accurate, and would add
false positives to a layer that currently has none. The only thing OCR knows that the
DOM does not is what is inside a picture.

**What it buys.** Region flagging leans on alt text, class names and filenames, so an
ID card saved as `IMG_2043.png` was invisible. Now it is read. And because recognised
values go into the vault, a number read off a card image gets the *same token* as the
same number typed into a form field — the server sees `⟦PROFILE.AADHAAR⟧` twice and
can tell they are one person's number without ever seeing it.

**Cost, and the fix.** A cold read is ~1.5 s per region. Caching per region on a 16×16
quantised pixel hash takes every later step to ~2 ms, because across a twelve-step form
fill the images never change — only the fields do. Measured 3,646 ms → 92 ms → 71 ms
across three passes. Quantised, not exact: JPEG noise makes exact pixel equality
useless between two captures of an unchanged screen.

---

## D18 — Prefer WASM over a *software* WebGPU adapter

**Decision.** `checkWebgpu()` inspects the adapter and rejects SwiftShader, lavapipe,
llvmpipe and friends, falling back to WASM.

**Why.** Measured. WebGPU being *present* is not the same as WebGPU being *fast*. A VM,
a locked-down corporate laptop, a blocklisted driver or a headless browser still
reports an adapter — backed by a CPU rasteriser. On SwiftShader, YuNet took **~4,000 ms
per frame against ~79 ms on the WASM path**. A naive "prefer WebGPU" check walks
straight into a 50× regression on exactly the machines least able to afford it.

**Effect.** The eval harness's per-page vision cost went from 18,409 ms to 329 ms.

---

## D19 — No `face` class in the custom detector

**Decision.** The trained detector has eight classes and none of them is `face`. YuNet
keeps that job.

**Why.** We cannot synthesise photographs — the repo may not contain anyone's face —
and an illustrated stand-in would teach the model to find drawings. That produces a
number that looks good on our own validation split and fails on the first real profile
picture. YuNet is trained on real photographs and measures 0.83–0.91 on them.

**The general principle**, worth stating because it applies to the whole ML half: only
train a class we can generate *honestly*. Everything else stays with a model that was
trained on the real thing.

---

## D20 — Split the dataset by recipe, not by image

**Decision.** 80/10/10 over *recipes* — whole page layouts — with a fixed seed.

**Why.** Splitting by image puts near-identical pages in both train and validation:
same layout, different fake name. The validation score then measures memorisation and
reads far too well. Holding whole recipes out is the only way the number answers the
question we care about: does this work on a page we have never seen?

**It shows.** val mAP50 0.809 against test 0.716, on recipes with a different class
mix. That gap is the split doing its job, and we report both.

---

## D21 — Pixel format is an explicit parameter

**Decision.** `letterbox()` takes a `PixelFormat` — `bgr255` or `rgb01` — with no
default that suits both callers.

**Why.** The custom detector originally reused YuNet's letterbox. YuNet is an OpenCV
model wanting BGR 0–255; Ultralytics YOLO wants RGB 0–1. Fed the wrong one, the model
returned **2,187 boxes all at confidence exactly 1.0**. It fails *silently* — the shape
is right, the count is plausible, and it looks like a working detector until the boxes
are plotted. Naming the convention at every call site is cheap insurance against a bug
with no error message.

---

## D22 — A holdout set that lives outside the demo site

**Decision.** Four pages in `eval/holdout/` — a label-less SPA, a 2005 table-layout
portal, a bilingual statement with no form controls, a support transcript where every
value sits in running prose. They are never demonstrated, and no rule was written or
tuned while looking at them. They are scored separately from `demo-site/`, and both
numbers are reported.

**Why.** Precision 1.000 / recall 0.978 on the pages you developed against is not
evidence that anything generalises; it is mostly evidence that you developed against
them. The first blind run said **precision 1.000, recall 0.784** — and the 21-point
gap was the useful output of the whole exercise.

**What it found.** Three real gaps, all of them things a live portal does every day:

1. `BANK_ACC_NO` and `MOB_NO` matched no keyword rule. `\b(account\s*(number|no))\b`
   does not accept `acc`, and `\bmobile\b` does not accept `mob`.
2. The account-number rule required the phrase "account number". Prose says
   "refund it to account 1139309559".
3. A `contenteditable` was naming *itself*: its accessible name came back as its own
   content, so an address box reported "14/2 Sardar Patel Marg" as its label and every
   keyword rule correctly declined to fire. `classifyField` then rejected it anyway
   for not being an `<input>` — which is most design-system text fields.

Fixing those took recall to **0.892** with precision still at 1.000, and each fix is
pinned by a unit test so it cannot quietly revert.

**The honest caveat.** 0.784 is the only truly blind number this set will ever
produce; everything after it was measured on pages that have now been looked at. The
four remaining misses are not bugs: three are a *person's name* belonging to someone
who is not in the vault (there is no NER — D4), and one is a bare ten-digit number
with no context word anywhere near it, which cannot be distinguished from an order
id without destroying the precision column.

---

## D23 — Exercise the VLM path over a real socket, and say what that does not prove

**Decision.** `server/tools/mock_vlm.py` is a runnable OpenAI-compatible endpoint.
`tests/test_vlm_live.py` starts it on a real port and drives `/v1/step` through the
actual `httpx` client, asserting that `planner` comes back as `"vlm"`.

**Why.** Every other test mocks the model out, which means the one thing never
exercised was the part most likely to break in front of a judge: the request shape,
the prompt, the parse, the validation, the fallback. Asserting on `planner == "vlm"`
matters as much as the action itself — a silent fall back to the deterministic
planner is exactly how this kind of test passes for the wrong reason.

**What it proves, and what it does not.** It proves the wire path works and that
`build_user_message` carries enough to act on — the stub decides from that text
alone, so dropping element ids or `profile_keys` from the prompt fails the test. It
proves a reply wrapped in prose and a markdown fence still parses, which is what
7B-class models actually emit. It proves **nothing at all** about how well a model
would choose. That still needs weights, and is still listed as a limitation.

---

## D24 — Cross shadow boundaries; say plainly that closed roots are unreachable

**Decision.** `lib/dom/shadow.ts` walks open shadow roots, and both the element scan
and the text walker use it. A closed root is left alone and documented as a limit.

**Why.** `document.querySelectorAll` does not enter a shadow root, and a `TreeWalker`
will not cross into one. A form built from web components — which is most modern
design systems, and a growing number of government and banking portals — therefore
looked to the DOM layer like a page with no form on it: no field classified, nothing
redacted, nothing for the agent to act on. The value was still in the screenshot, so
this was not merely a missed feature; it was a leak on a whole class of site, and the
claim "works on any page, in any browser" was not true while it held.

**Measured.** `eval/holdout/webcomponent.html` — four fields in open roots, three more
in a nested component, one in a *closed* one — scores 1.000 / 1.000 on the reachable
seven, with both decoys (a vehicle registration, a 12-digit pass serial) left alone.

**Honesty note.** Unlike the other four holdout pages, this one is **not blind**: the
traversal was written first and the page added to hold it in place. It is a
regression test, and it is labelled as one. The blind number remains the 0.784 that
the original four produced on their first run.

**The closed-root limit.** `attachShadow({mode: 'closed'})` withholds the root from
every caller, including a content script, by design. Nothing can read it, so nothing
can redact it. The holdout page annotates that field `data-unreachable` rather than
`data-pii`, because scoring it as a miss would imply a fix exists. If a page uses a
closed root to render PII, this extension cannot protect it, and the honest answer is
to say so rather than to quietly score around it.
