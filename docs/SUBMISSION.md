# Submission

## Problem

| | |
|---|---|
| **Title** | On-device Visual Perception for Light-weight Browser Agents |
| **Organisation** | Indian Space Research Organisation (ISRO) |
| **Department** | Department of Space |
| **Category** | Software |
| **Theme** | Smart Automation |
| **Event** | Smart India Hackathon |

Full statement: [`docs/problem.md`](problem.md).

## What we built

A Chrome and Firefox extension that lets a server-side vision-language model drive
the browser **without ever seeing the user's personal data**.

The extension reads the current tab, detects sensitive content on-device, paints it
out of the screenshot and replaces it in the text with tokens, re-scans the finished
payload, and only then sends anything. The model replies with one UI action naming a
token; the extension swaps the token for the real value locally, in the last
millisecond before typing it.

## How each judging criterion is met, and measured

Every number below is produced by `uv run python -m eval.run_all`, which drives a
real browser over the shipped code. Nothing here is an estimate.

### 1. Accuracy of visual context from screen — 25%

The agent completed *"fill this form with my profile and stop before submitting"*
end to end: **9 fields filled across 9 steps**, each one identified from the
sanitized context alone, then stopped at the Submit button as instructed.

Three perception layers feed one element list:

| Layer | What it sees | Cost |
|---|---|---|
| DOM | `autocomplete`, `<label>`, input types, text nodes with exact rects | 2–20 ms |
| Vision (YuNet) | Faces the DOM cannot describe | 50 ms WebGPU / 181 ms WASM |
| Vision (custom) | Canvas-rendered inputs and buttons — the case where the DOM is *empty* | 91 ms |
| OCR | Text inside images | 1.5 s cold, ~2 ms cached |

Set-of-Mark numbering is drawn on the screenshot after redaction, so the model
returns an element id rather than guessing a pixel coordinate.

### 2. Precision / recall of sensitive & PII detection — 20%

| | |
|---|---|
| **Precision** | **1.000** |
| **Recall** | **0.978** over 45 annotated items |
| F1 | 0.989 |

Precision is 1.000 *against deliberate decoys*: a 12-digit order number, a
Luhn-invalid card, "Control panel" (against the PAN rule), a non-birth date, a
helpline number and a result count all survive untouched.

That is achieved without a model doing the deciding. Aadhaar is confirmed by a
Verhoeff checksum, cards by Luhn, PAN by its holder-type letter, and 13 validators
require a nearby context word before firing on ambiguous digits.

The single miss is a **third party's** name in a table — the vault only knows the
user's own details and there is no NER model. We report it rather than hide it.

### 3. Precision of redaction — 20%

| | |
|---|---|
| Pixel recall | 100%, 100%, 95.5% across the three annotated pages |
| **Leak test** | **0** |

The leak test is the one that matters. It renders the redacted image exactly as the
extension renders it, reads it back with OCR, and counts ground-truth values still
legible. Zero, on every page.

Text is painted with an opaque fill, never blurred — blurred text is recoverable,
because the glyph alphabet is small and known. Only faces are pixelated.

### 4. Client-side resource utilisation — 20%

| Asset | Size |
|---|---|
| ONNX Runtime WASM (WebGPU + WASM in one binary) | 26.5 MB |
| Tesseract core + English data | 4.6 MB |
| Custom UI detector | 10.0 MB |
| YuNet face detector | 0.2 MB |
| **Packed extension** | **45.7 MB** |

Three things keep the *runtime* cost low, even though the bundle is large:

- **The cheap layer runs first.** The DOM pass costs 2–20 ms and loads no model at
  all. Most screens never need more.
- **Models load lazily and are released on close.** The side panel only lives while
  it is open.
- **Work is skipped, not repeated.** A 48×48 greyscale signature skips the vision
  pass when the screen has not changed; OCR results are cached per image region on a
  pixel hash. Measured across three passes: 3,646 ms → 92 ms → 71 ms.

We also found and fixed a 50× regression here: a machine with no usable GPU still
*advertises* WebGPU, backed by a software rasteriser. Preferring it costs ~4,000 ms
per frame against ~79 ms on WASM. The adapter is now inspected and declined.

### 5. End-to-end latency — 15%

| | Cold (first look at a page) | Warm (every step after) |
|---|---|---|
| `kyc.html` | 1,760 ms | **165 ms** |
| `profile.html` | 550 ms | **132 ms** |
| `bank.html` | 202 ms | **138 ms** |

Server round trip: 52 ms network + 4.8 ms server. Payload 42 KB.

And the fastest request is the one never made: **L0** handles a step entirely
on-device when the page has *declared* what a field is (`autocomplete="email"`) and
the vault holds a matching value. No screenshot, no network, no third party.

## The privacy argument, in four sentences

1. The DOM layer is **deterministic, not learned** — checksums and page-author
   declarations, with no training distribution to drift out of.
2. Real values live only in a local vault; the server learns which *kinds* of values
   exist and which repeat, never the values. Passwords are never even read out of
   the page.
3. The **egress guard** re-scans the finished payload against every validator *and*
   every vault value immediately before `fetch`, and blocks on any hit. The server
   runs the same scan on arrival and refuses rather than forwards.
4. Therefore "nothing leaked" is a property of the architecture, not of a model
   being accurate — which is what makes the claim defensible.

## Openness

- Server model: any **open-weights** VLM behind an OpenAI-compatible endpoint —
  vLLM, Ollama, or a hosted deployment. Configured by three environment variables,
  swappable without code changes.
- On-device models: YuNet (OpenCV Zoo), Tesseract, and our own YOLO11n detector
  trained on data we generate.
- No paid API is required for the demo: a deterministic planner completes the whole
  task with no key, no GPU and no internet.

## Honest limitations

- The custom detector is a **smoke run** — 12 epochs at 384 px on a laptop. Its
  boxes land correctly, but it puts a false box on a decoy and misses an email. A
  shippable model needs a GPU run.
- **No real-screenshot test set.** Everything measured is the demo site or synthetic.
  Hand-labelled real pages, never trained on, is the honest next test.
- The end-to-end run used the deterministic planner. The VLM path has unit tests but
  has not been exercised against a live model.
- Safari is out of scope: it needs Xcode repackaging.
