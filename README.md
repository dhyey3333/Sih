# PrivAgent

A privacy-preserving vision agent that runs in the browser.

Built for the Smart India Hackathon problem
[*On-device Visual Perception for Light-weight Browser Agents*](docs/problem.md).

**Indian Space Research Organisation (ISRO)** · Department of Space
Category **Software** · Theme **Smart Automation**

PrivAgent reads the page you are on with on-device models, blacks out every password, ID number,
card, email, face and address **before any network request is made**, and sends only the
sanitized, tokenized context to a server-side open-weights VLM. The VLM replies with one UI
action; the extension swaps the tokens back for real values locally and performs it.

The server never sees a single piece of your personal data. It sees `⟦PROFILE.EMAIL⟧`.

---

## The idea in one picture

```
   ┌──────────────────────── your machine ────────────────────────┐
   │                                                              │
   │  page ──► screenshot + DOM snapshot                          │
   │             │                                                │
   │             ├─► DOM layer    passwords, autocomplete,        │
   │             │                Aadhaar/PAN/card + checksums    │  2–27 ms
   │             ├─► vision layer faces, ID scans, OCR, canvas UI  │
   │             │                                                │
   │             ▼                                                │
   │           fuse ─► redact pixels ─► tokenize ─► EGRESS GUARD ─┼──► server
   │                       │                │            │        │      │
   │                    black box      ⟦EMAIL_1⟧    blocks on any │      │
   │                    on the JPEG     in the JSON      hit      │      ▼
   │                                                              │    VLM picks
   │           execute ◄── swap tokens for real values ◄──────────┼──  one action
   └──────────────────────────────────────────────────────────────┘
```

## Why this is not just "a model that finds PII"

A model can be wrong. The architecture is built so that being wrong is not enough to leak.

- **The DOM layer is deterministic, not learned.** `input[type=password]` and
  `autocomplete="cc-csc"` are declarations by the page author. Aadhaar is confirmed by a
  Verhoeff checksum, cards by Luhn, PAN by its holder-type letter. No training run required,
  and no distribution to drift out of.
- **The vault means real values never travel.** The server only learns that a value of a given
  kind exists, and which values repeat. Passwords are never even read out of the page.
- **The egress guard is the backstop.** Immediately before `fetch`, the finished payload is
  re-scanned against every validator *and* every value the vault holds. Any hit blocks the
  request and logs the incident type — never the value.
- **Text is painted over, never blurred.** Blurred text is recoverable; the glyph alphabet is
  tiny. Only faces are pixelated, and only because there is no small alphabet to brute-force.
- **It crosses shadow boundaries.** A form built from web components is invisible to
  `document.querySelectorAll`, so it would have been redacted by nothing at all while its values
  sat in the screenshot. Open shadow roots are walked; closed ones cannot be, and we say so.

## Where it stands

All seven milestones are done and measured. See [docs/PROGRESS.md](docs/PROGRESS.md) for the full numbers and
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

**Privacy filter**, scored automatically in a real browser against `data-pii` ground truth:

| | Demo site | Holdout |
|---|---|---|
| PII detection precision | **1.000** | **1.000** |
| PII detection recall | **0.978** over 45 items | **0.913** over 46 items |
| Perception time | **2–27 ms per page**, no model loaded | |

The holdout is pages in `eval/holdout/` that are never demonstrated. Four were never looked at
while a rule was written — a label-less SPA, a 2005 table-layout government portal, a bilingual
statement with no form controls, a support transcript where every value sits in prose. Their
first blind run read **recall 0.784**, and the gap was the point: they found three real gaps,
all now fixed and pinned by tests. Two further pages hold shadow-DOM and iframe traversal in
place — before those, a form inside a web component or an `<iframe>` was invisible to the DOM
layer entirely, which was a leak on two whole classes of modern site. Precision never moved off 1.000, on either set, against
deliberate decoys: order numbers, a Luhn-invalid SKU, a PAN-shaped scheme code, a vehicle
registration, a public helpline.

**End-to-end agent**, filling an empty scholarship form from the local profile:

| | |
|---|---|
| Result | 9 fields filled from tokens alone, stopped before Submit |
| Client pipeline | 216 ms (redact 193, tokenize 10, egress guard 10, detect+fuse 2) |
| Network + server | 52 ms + 4.8 ms |
| Payload | 42 KB, 1024×1280 |
| Handled with no request at all | **5 of 9 fields** (L0: the page declared the field, the vault had the value) |
| Tests | 421 passing (333 extension, 68 server, 20 ml) |

**On-device vision**, YuNet via onnxruntime-web:

| | |
|---|---|
| Model | 227 KB |
| Inference | **50 ms** p50 on WebGPU, **181 ms** on WASM (the Firefox path) |
| Recall vs face size | 0.90 at 420 px, 0.83 at 200 px, **0.90 at 96 px** via a close-up pass |

**Everything above is regenerated by one command:**

```bash
uv run python -m eval.run_all
```

It drives a real browser over the *shipped* modules and writes
[`eval/results/RESULTS.md`](eval/results/RESULTS.md). The number that matters most is the
**leak test: 0** — the redacted image is rendered exactly as the extension renders it, then read
back with OCR, and no ground-truth value is recoverable from any page.

**Our own detector**, trained on data we generate ourselves:

| | |
|---|---|
| Dataset | 2,280 images, 30,238 boxes, **zero manual annotation** |
| val mAP50 | **0.900** (mAP50-95 0.759) on held-out page *layouts*, not held-out images |
| test mAP50 | 0.934 — higher than val because its two recipes carry fewer classes; both are reported |
| Inference | 184 ms at 448 px |

Labels come from the page's own `data-pii` attributes, read back with
`getBoundingClientRect()` — so training labels and eval ground truth are literally the same
annotation and cannot drift apart. See [`ml/README.md`](ml/README.md).

**Client resources.** Chrome **45.7 MB** packed, Firefox **32.2 MB**. Firefox is 30% smaller
because it is given a different ONNX runtime: it has no WebGPU, so the WebGPU half of the
combined binary is 14 MB that could never execute. Neither number is what you pay per page — the
models load lazily, and a screen the DOM layer handles alone costs 2–27 ms and zero megabytes.

**Not done yet, stated plainly.** The detector is trained entirely on pages our own generator
drew. There is **no real-screenshot test set** — everything measured
is the demo site, the holdout, or synthetic pages, and hand-labelled screenshots of real portals
are the honest next test. The VLM path is exercised end to end over a real socket, but against a
**protocol conformance stub**, not model weights: it proves the request shape, the prompt and the
parsing, and nothing about how well a model would choose. Names belonging to someone other than
the user are not detected, by choice — there is no NER model. And the holdout's 0.784 is the only
truly blind number it will ever produce; everything after it was measured on pages that have now
been looked at.

## Try it

```bash
cd extension && npm install
```

Serve the demo site:

```bash
python3 -m http.server 5173 --directory demo-site
```

Start the server (no API key needed — it falls back to a deterministic planner):

```bash
cd server && uv sync --dev && uv run uvicorn app.main:app --reload --port 8000
```

Run the extension in Chrome (opens a browser with it loaded):

```bash
cd extension && npm run dev
```

…or Firefox:

```bash
cd extension && npm run dev:firefox
```

Then, in the side panel, press **Load demo profile** and:

- **The privacy demo** — open `http://localhost:5173/kyc.html` and press **Analyze**. Nothing is
  sent. **Drag the divider** across the preview: left is your screen, right is what the server
  would get, in place. Hover a row in *Detections* to light up the pixels it covers, and open
  *What leaves the device* for the exact request body. Untick **On-device vision** and analyze
  again: the profile photo and the ID-card scan come back, which is the clearest way to show what
  the models are actually buying.
- **The agent demo** — open `http://localhost:5173/apply.html`, type
  *"fill this form with my profile and stop before submitting"*, and press **→**. Watch the
  counter line: five fields are filled before a single request is made.

To use a real model, copy `server/.env.example` to `server/.env` and point `VLM_BASE_URL` at any
OpenAI-compatible endpoint (vLLM, Ollama, or a hosted open-weights model).

It works on any site, not just the demo pages — the DOM layer is generic, not per-site rules.

**Running the demo for an audience:** [`docs/DEMO.md`](docs/DEMO.md) is a five-minute script with
the failure modes and the questions to expect. **How each judging criterion is met, with the
measurement behind it:** [`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Layout

| Path | What |
|---|---|
| `extension/` | WXT + TypeScript, MV3, builds for Chrome and Firefox |
| `extension/lib/pii/` | validators, checksums, DOM heuristics, sanitizer, vault, egress guard |
| `extension/lib/vision/` | onnxruntime-web runtime, YuNet, OCR, custom detector, change detection |
| `extension/lib/redact/` | box fusion and canvas rendering |
| `extension/lib/eval/` | scoring against `data-pii` ground truth |
| `server/` | FastAPI + provider-agnostic VLM client |
| `ml/` | synthetic data engine, training, ONNX export |
| `eval/` | one-command metric harness |
| `eval/holdout/` | the blind set — pages in idioms the demo site does not use, never tuned against |
| `demo-site/` | mock pages with **fake** PII, annotated with ground truth |
| `docs/` | [submission](docs/SUBMISSION.md) · [demo script](docs/DEMO.md) · [plan](docs/PLAN.md) · [problem](docs/problem.md) · [progress](docs/PROGRESS.md) · [decisions](docs/DECISIONS.md) · [teammate review](docs/TEAMMATE_REVIEW.md) |
| `reference/` | teammate's earlier prototype, read-only, gitignored |

## Commands

| | |
|---|---|
| `npm run dev` / `dev:firefox` | run the extension |
| `npm run build` / `build:firefox` / `build:all` | production builds |
| `npm test` | 333 unit tests |
| `npm run assets` | restage the ORT WASM binaries from node_modules |
| `npm run compile` | typecheck |
| `npm run build:domcheck` | standalone bundle for scoring a page |
| `npm run uipreview` | the side panel, populated, as a plain page — for judging the design |

From the repo root:

| | |
|---|---|
| `uv run python -m eval.run_all` | every number above, in a real browser |
| `uv run python -m eval.smoke_extension` | boots the **packed** extension and checks it comes up clean |

## A note on data

Every value in this repository — fixtures, demo pages, screenshots — is synthetic. The Aadhaar
numbers are Verhoeff-valid and the card numbers Luhn-valid *on purpose*, so the detectors are
genuinely exercised, but none of them are issued to anybody. Nothing here logs a raw PII value,
including error messages and incident reports.
