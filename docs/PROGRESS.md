# Progress

Status board. Updated at the end of every milestone (CLAUDE.md).

| Milestone | State |
|---|---|
| M0 Teammate review | ✅ `docs/TEAMMATE_REVIEW.md` |
| M1 Skeleton | ✅ WXT extension building for Chrome + Firefox |
| M2 DOM privacy layer | ✅ validators, vault, sanitizer, fusion, redaction, egress guard, side panel |
| M3 Agent loop | ✅ FastAPI server, provider-agnostic VLM, action executor, confirm-before-submit |
| M4 Vision layer v1 | ⬜ next — face detector + OCR via onnxruntime-web |
| M5 Custom detector | ⬜ synthetic data → train → ONNX → integrate |
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
