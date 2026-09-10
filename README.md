# PrivAgent

A privacy-preserving vision agent that runs in the browser.

Built for the Smart India Hackathon problem
[*On-device Visual Perception for Light-weight Browser Agents*](docs/problem.md).

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
   │             │                Aadhaar/PAN/card + checksums    │  2–20 ms
   │             ├─► vision layer faces, ID scans, canvas (M4)    │
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

## Where it stands

M0–M2 are done and measured. See [docs/PROGRESS.md](docs/PROGRESS.md) for the full numbers and
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

**Measured on the demo site** (real browser, scored automatically against `data-pii` ground truth):

| | |
|---|---|
| PII detection precision | **1.000** (zero false positives, against deliberate decoys) |
| PII detection recall | **0.976** over 42 DOM-reachable items |
| Perception time | **2–20 ms per page**, no model loaded |
| Bundle size | 66 KB |
| Tests | 159 passing |

Not yet done: faces and the ID-card scan are **not** redacted — that needs the vision layer
(M4). There is no server or agent loop yet (M3). Both are called out honestly rather than
demoed with a placeholder.

## Try it

```bash
cd extension && npm install
```

Serve the demo site:

```bash
python3 -m http.server 5173 --directory demo-site
```

Run the extension in Chrome (opens a browser with it loaded):

```bash
cd extension && npm run dev
```

…or Firefox:

```bash
cd extension && npm run dev:firefox
```

Then open `http://localhost:5173/kyc.html`, open the PrivAgent side panel, press
**Load demo profile**, and press **Analyze page**. Toggle between *Original* and
*What the server sees*, and open the payload inspector.

It works on any site, not just the demo pages — the DOM layer is generic, not per-site rules.

## Layout

| Path | What |
|---|---|
| `extension/` | WXT + TypeScript, MV3, builds for Chrome and Firefox |
| `extension/lib/pii/` | validators, checksums, DOM heuristics, sanitizer, vault, egress guard |
| `extension/lib/redact/` | box fusion and canvas rendering |
| `extension/lib/eval/` | scoring against `data-pii` ground truth |
| `server/` | FastAPI + provider-agnostic VLM client *(M3)* |
| `ml/` | synthetic data engine, training, ONNX export *(M5)* |
| `eval/` | metric scripts and test sets *(M6)* |
| `demo-site/` | mock pages with **fake** PII, annotated with ground truth |
| `docs/` | [plan](docs/PLAN.md) · [problem](docs/problem.md) · [progress](docs/PROGRESS.md) · [decisions](docs/DECISIONS.md) · [teammate review](docs/TEAMMATE_REVIEW.md) |
| `reference/` | teammate's earlier prototype, read-only, gitignored |

## Commands

| | |
|---|---|
| `npm run dev` / `dev:firefox` | run the extension |
| `npm run build` / `build:firefox` / `build:all` | production builds |
| `npm test` | 159 unit tests |
| `npm run compile` | typecheck |
| `npm run build:domcheck` | standalone bundle for scoring a page |

## A note on data

Every value in this repository — fixtures, demo pages, screenshots — is synthetic. The Aadhaar
numbers are Verhoeff-valid and the card numbers Luhn-valid *on purpose*, so the detectors are
genuinely exercised, but none of them are issued to anybody. Nothing here logs a raw PII value,
including error messages and incident reports.
