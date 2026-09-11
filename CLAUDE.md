# CLAUDE.md

## Project
PrivAgent (working name) for the Smart India Hackathon problem "On-device Visual Perception for Light-weight Browser Agents".

A Chrome + Firefox extension that reads the current tab with small on-device vision models, redacts sensitive content (faces, passwords, PII) before any network request, and sends only sanitized context to a server-side open-weights VLM. The VLM returns the next UI action and the extension executes it.

- Architecture, protocol, training, eval, milestones: `docs/PLAN.md` (read the relevant section before starting a milestone)
- Original problem statement: `docs/problem.md`
- Teammate's earlier work (read-only reference, not part of our build): `reference/`
- Progress log: `docs/PROGRESS.md` (update at the end of every milestone)
- Design decisions: `docs/DECISIONS.md`

## Judging metrics (optimize for these, and make each one measurable)
1. Accuracy of visual context from screen: 25%
2. Precision/recall of sensitive/PII detection: 20%
3. Precision of redaction: 20%
4. Client-side resource utilization: 20%
5. End-to-end latency of the task: 15%

## Privacy rules (never break these)
- Nothing leaves the device except the output of the sanitizer, and every outbound payload passes the egress guard (validator scan; block and log the incident type on any hit).
- Real PII values live only in the local vault. The server only sees tokens like `⟦EMAIL_1⟧` or `⟦PROFILE.PHONE⟧`; the extension swaps tokens for real values locally, right before typing.
- Every string sent to the server (element labels, page title, URL) goes through the text sanitizer. Send URL origin + path only; strip query strings and fragments.
- Text-like PII (numbers, emails, names, cards, IDs, passwords) gets a solid box + token label. Never blur or pixelate text; it can be recovered. Faces get heavy pixelation.
- Never log raw PII. Fixtures, tests, screenshots and demo data use fake data only.
- Irreversible actions (submit, pay, send, delete) require explicit user confirmation in the side panel.

## Layout
- `extension/`: WXT + TypeScript, Manifest V3, builds for Chrome and Firefox
- `server/`: FastAPI (Python 3.11+), provider-agnostic VLM client
- `ml/`: synthetic data engine (Playwright), training, ONNX export
- `eval/`: metric scripts and test sets. `eval/holdout/` is the blind set — pages written in idioms the demo site does not use. **Never open one while writing or tuning a detector rule**, and never demo from it; that is the only thing that makes its number mean anything.
- `demo-site/`: mock sites with FAKE PII for demos and tests
- `docs/`: plan, problem statement, progress, decisions

## Stack
- Extension: WXT, TypeScript, side panel UI (Chrome `sidePanel`, Firefox `sidebar_action`). Models run in the side panel page (DOM + WebGPU available), not in the background script.
- On-device inference: onnxruntime-web, WebGPU first with WASM fallback. Transformers.js only if a specific model needs it.
- Server: FastAPI + OpenAI-compatible client configured by `VLM_BASE_URL`, `VLM_MODEL`, `VLM_API_KEY`, so we can swap vLLM, Ollama, or a hosted open-weights endpoint.
- ML: Ultralytics YOLO (nano) for detection, exported to ONNX. Python deps managed with `uv`.

## Commands (keep this list current)
- Extension (from `extension/`): `npm run dev` (Chrome), `npm run dev:firefox`, `npm run build`, `npm run build:firefox`, `npm run build:all`, `npm test`, `npm run compile` (typecheck), `npm run build:domcheck` (standalone bundle for scoring a page), `npm run uipreview` (populated side panel for design review, opens as a plain page), `npm run assets` (restage the ORT WASM binaries; runs on postinstall)
- Server (from `server/`): `uv sync --dev`, `uv run uvicorn app.main:app --reload --port 8000`, `uv run pytest`. To exercise the VLM path with no weights: `uv run uvicorn tools.mock_vlm:app --port 8100`, then set `VLM_BASE_URL=http://localhost:8100/v1 VLM_MODEL=mock-vl`
- Demo site: `python3 -m http.server 5173 --directory demo-site`
- ML (from `ml/`): `uv sync && uv run playwright install chromium`, `uv run python -m synth.generate --out data/synth --per-recipe 120`, `uv run python -m synth.preview --data data/synth --split train`, `uv sync --group train && uv run python train.py --data data/synth/data.yaml --epochs 80`, `uv run --group dev pytest`
- Eval (from the repo root): `uv sync && uv run python -m eval.run_all` — needs `extension && npm run build:domcheck` first; writes `eval/results/RESULTS.md`. `uv run python -m eval.smoke_extension` boots the packed Chrome build in a real browser (needs `npm run build` first).

## Gotchas
- MV3 forbids remotely hosted code: bundle onnxruntime-web's `.wasm`/`.mjs` files in the extension, point `ort.env.wasm.wasmPaths` at them, and allow `'wasm-unsafe-eval'` in the extension CSP.
- `tabs.captureVisibleTab` returns device pixels while DOM rects are CSS pixels: multiply by `devicePixelRatio`. Chrome rate-limits captures (about 2 per second), so throttle.
- Content scripts can't run on browser-internal pages or inside the built-in PDF viewer, and canvas-rendered apps hide text from the DOM. That is what the vision layer is for.
- Framework-controlled inputs (React etc.): set values through the native value setter, then dispatch `input` and `change` events.
- Firefox: non-persistent background page instead of a service worker, `sidebar_action` instead of `sidePanel`, and WebGPU may be unavailable, so the WASM path must always work.
- The side panel only lives while it's open. Create each ONNX session once, reuse it, and release it on close.

## How to work in this repo
- Before changing more than two files, show a short plan and wait for approval.
- One milestone at a time (see `docs/PLAN.md`). Finish each with: build passes, tests pass, `docs/PROGRESS.md` updated, a suggested commit message.
- Keep dependencies few and well known; say why before adding one.
- Measure instead of guessing: every pipeline stage records its duration for the metrics panel. Report model size and inference time whenever a model changes.
- If unsure about a library's current API (WXT, onnxruntime-web, Ultralytics, FastAPI), check its docs instead of guessing.
- The team must explain this code to judges: add short comments on the why of non-obvious logic, and record big choices in `docs/DECISIONS.md`.
