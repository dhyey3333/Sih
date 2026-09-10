# PrivAgent build plan

## 1. One agent step
1. Capture: `tabs.captureVisibleTab` (JPEG) plus a content-script DOM snapshot (interactive elements, labels, input types, `autocomplete` values, visible text nodes, rects, `devicePixelRatio`, scroll position).
2. Perceive, on-device:
   - DOM layer: semantic detection of sensitive elements and text. Exact boxes, near-zero cost.
   - Vision layer: models on the screenshot for what the DOM can't see (images, canvas, video, PDFs, embedded frames).
3. Fuse: union of DOM and vision boxes, merge overlaps, pad 2–4 px, keep the highest-priority type.
4. Redact and tokenize: render the sanitized screenshot, replace sensitive strings in the element list with tokens, store real values in the vault.
5. Choose the disclosure level (§3.5) and draw Set-of-Mark numbers on interactive elements (after redaction; numbers never cover redaction labels).
6. Egress guard: final scan of the serialized payload; block on any hit.
7. Server: the VLM gets task + sanitized screenshot + element list + redaction legend + history and returns exactly one JSON action.
8. Execute: resolve tokens from the vault, confirm irreversible actions with the user, perform the action, wait for the page to settle, go back to 1.

## 2. Extension structure (WXT)
- `entrypoints/background.ts`: orchestrator. Runs the loop, captures the tab, calls the server, routes messages.
- `entrypoints/content.ts`: DOM snapshot, PII text scan, element registry (id → element), action executor.
- `entrypoints/sidepanel/`: agent UI and model runtime. Task box, original/sanitized preview toggle, "what the server sees" payload inspector, detection list with confidences, per-stage latency and resource meters, confirmation dialog.
- `lib/pii/`: validators, DOM heuristics, text sanitizer, tokenizer, vault.
- `lib/vision/`: model loading (WebGPU → WASM), pre/post-processing, NMS, OCR.
- `lib/redact/`: box fusion and canvas rendering.
- `lib/protocol.ts`: request/response types, mirrored in `server/app/schemas.py`.

## 3. Privacy filter

### 3.1 DOM layer
- Always sensitive: `input[type=password]`; `autocomplete` of `cc-number`, `cc-csc`, `cc-exp`, `cc-name`, `email`, `tel`, `bday`, `street-address`, `postal-code`, `name`, `given-name`, `family-name`, `one-time-code`.
- Heuristic: `name`/`id`/label/placeholder/`aria-label` matching words like aadhaar, pan, passport, dob, birth, otp, cvv, card, account, ifsc, upi, phone, mobile, email, address, pin code, salary → the field's value is sensitive.
- Text nodes: run validators over visible text; get exact boxes with `Range.getClientRects()`.
- Images whose alt/src/class suggest avatar, profile, photo, or ID go to the face / document detector first.

### 3.2 Validators (India-aware plus global)
| Type | Pattern idea | Extra check |
|---|---|---|
| Email | standard email regex | none |
| Indian mobile | `(\+91[\s-]?)?[6-9]\d{9}` | none |
| Aadhaar | `[2-9]\d{3}\s?\d{4}\s?\d{4}` | Verhoeff checksum |
| PAN | `[A-Z]{5}[0-9]{4}[A-Z]` | 4th letter is a valid holder type (P, C, H, F, A, T, B, L, J, G) |
| Card number | 13–19 digits with optional spaces/dashes | Luhn checksum |
| IFSC | `[A-Z]{4}0[A-Z0-9]{6}` | none |
| UPI ID | `handle@provider` | provider is not an email domain; known handle list |
| Passport (IN) | `[A-Z][0-9]{7}` | context word nearby |
| PIN code, DOB, OTP, CVV | digit patterns | only with a context label nearby (keeps precision high) |

Names and addresses: DOM labels first; add a small NER model later only if time allows.

### 3.3 Vision layer
- Custom detector (YOLO nano, §6): `face`, `password_field`, `id_document`, `payment_card`, `qr_code`, `signature`, `pii_text` (a text line that looks like PII), plus `button` and `text_input` for canvas apps.
- Until the custom detector covers faces well, use a pretrained tiny face detector (for example YuNet as ONNX, or MediaPipe BlazeFace).
- OCR (start with Tesseract.js; switch to PP-OCR ONNX if it's faster) only on crops flagged `pii_text` / `id_document` or on image/canvas regions. Never full-page OCR. Run §3.2 validators on the OCR text.
- Run vision only when the screen changed (pixel diff on a downscaled frame) and cache results per (URL, scroll position).

### 3.4 Rendering, tokens, vault
- Text-like PII, cards, IDs, QR codes, passwords: solid fill plus a small label such as `⟦EMAIL_1⟧`.
- Faces: heavy pixelation (12 px blocks or larger) plus `⟦FACE_1⟧`.
- Tokens are stable within a session (same value → same token) so the server can reason about repeats.
- Vault: in-memory map from token to value. The user's profile (name, email, phone, address, DOB, ID numbers) is entered in the side panel and stored locally (WebCrypto-encrypted if persisted). The server only learns which keys exist, e.g. `⟦PROFILE.EMAIL⟧`.

### 3.5 Disclosure levels (the local model makes the call)
- L0 local-only: trivial commands (scroll, back, fill a field whose label matches a profile key) run without the server.
- L1 structure-only: if the sensitive area is large (for example over 40% of the screen) or the page is a banking/ID page, send the element list and layout without an image.
- L2 sanitized image plus structure: the default.

Show the level used at every step in the side panel.

### 3.6 Egress guard
Before every `fetch`, serialize the payload and scan all strings with the §3.2 validators and all vault values (exact and fuzzy match). Any hit: block, log the incident type only, and show it in the UI. The server runs the same scan again and rejects the request if anything slips through.

## 4. Protocol
Request, `POST /v1/step`:
```json
{
  "session_id": "uuid",
  "task": "Fill the scholarship form with my profile and stop before submitting",
  "step": 3,
  "disclosure_level": 2,
  "page": {"origin": "https://demo.local", "path": "/apply", "title": "Scholarship application"},
  "screen": {"image_jpeg_b64": "...", "width": 1280, "height": 800},
  "elements": [
    {"id": 5, "role": "textbox", "label": "Email", "value": "", "bbox": [412, 300, 320, 36]},
    {"id": 7, "role": "textbox", "label": "Mobile number", "value": "", "bbox": [412, 350, 320, 36]},
    {"id": 12, "role": "button", "text": "Submit", "bbox": [412, 620, 120, 40]}
  ],
  "redactions": [{"token": "⟦FACE_1⟧", "type": "FACE", "bbox": [40, 80, 96, 96], "source": "vision"}],
  "profile_keys": ["FULL_NAME", "EMAIL", "PHONE", "DOB", "AADHAAR"],
  "history": [{"action": "type", "element_id": 4, "text": "⟦PROFILE.FULL_NAME⟧", "ok": true}]
}
```

Response:
```json
{"action": "type", "element_id": 5, "text": "⟦PROFILE.EMAIL⟧", "reason": "Email field is empty", "confidence": 0.9}
```

Actions: `click(element_id)`, `type(element_id, text)`, `select(element_id, option)`, `scroll(direction, amount)`, `key(name)`, `navigate(url)`, `wait(ms)`, `ask_user(question)`, `done(summary)`, plus `click_xy(x, y)` for targets that aren't DOM elements.

## 5. Server
- FastAPI: `POST /v1/step`, `GET /health`. Pydantic schemas mirror `lib/protocol.ts`.
- Prompt: system message (role, redaction legend, action schema, rules: never guess redacted values, refer to tokens, act through element ids) plus user message (task, history, element list, numbered screenshot).
- Constrain output to the JSON schema where the provider supports structured output; otherwise validate and retry once.
- Model: start with a hosted open-weights VLM behind an OpenAI-compatible endpoint; keep it swappable (vLLM on a GPU machine for the offline-deployable story, Ollama on a laptop as a no-internet fallback). Candidates: Qwen3-VL (4B / 8B / 32B), UI-TARS-1.5-7B. Benchmark two on our tasks and pick by success rate × latency.
- Return timing info (queue, inference) so the client can show a full latency breakdown.

## 6. Training (ml/)

### 6.1 Synthetic data engine: free labels from the DOM
- `ml/synth/templates/`: 15–30 HTML templates (login, signup, KYC, bank dashboard, transactions, checkout, profile with avatar, email inbox, chat, social feed, government form, page with an ID-card image, page with a canvas).
- Fill them with `Faker('en_IN')` and generators that produce valid-looking fake Aadhaar (Verhoeff), PAN, and card numbers (Luhn).
- Every sensitive element carries `data-pii="TYPE"`. A Playwright script screenshots each page across viewports (1366×768, 1440×900, 1920×1080), DPR 1 and 2, light and dark themes, random fonts, spacing, zoom and scroll, and writes YOLO labels from `getBoundingClientRect()` × DPR.
- Include negatives (screens with no PII) to cut false positives.
- Target 5k–15k images. Split 80/10/10 by template, not by image, so validation and test layouts are unseen.
- Separate real-world test set: 100–200 real screenshots (fake accounts), hand-labeled in Label Studio, CVAT, or Roboflow. Never train on it.

### 6.2 Train and export
```bash
# Colab / Kaggle GPU (on the Mac use device=mps for quick smoke tests only)
pip install ultralytics
yolo detect train data=ml/data/privagent.yaml model=yolo11n.pt imgsz=960 epochs=80 batch=16
yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=960 opset=17 simplify=True
```
- Build variants (640 vs 960 input; FP32 vs FP16 vs INT8), benchmark each in the browser on WebGPU and WASM, pick the default, and keep the table for the presentation.
- Optional, matches the "ViT" wording in the problem: fine-tune a tiny ViT (DeiT-tiny or MobileViT) as a screen-sensitivity classifier that sets the disclosure level, or add a ViT-backbone detector (e.g. RF-DETR) to the trade-off table.

## 7. Evaluation (eval/): one command regenerates every number
| Judging metric | How we measure it |
|---|---|
| Visual context accuracy | Task success rate on N scripted tasks (demo site + 3–5 real sites); element-grounding accuracy against ground truth |
| PII precision/recall | Per-class precision/recall/F1 at IoU ≥ 0.5 on synthetic and real test sets; report DOM-only, vision-only, and fused |
| Redaction precision | Pixel-level precision/recall of redaction masks vs ground truth; leak test: OCR the redacted image and count any ground-truth PII string still recoverable |
| Client resources | Model MB, load time, inference ms per frame (WebGPU vs WASM), memory/CPU from Chrome's Task Manager, frames skipped by change detection |
| End-to-end latency | Per-stage timings (capture, perceive, redact, network, server, execute) exported as JSON, reported as p50/p95 |

## 8. Milestones (in order; each ends with something demo-able)
- **M0 Teammate review:** read `reference/`, write `docs/TEAMMATE_REVIEW.md` (what exists, what works, what to reuse or port, what to drop). No code changes.
- **M1 Skeleton:** WXT project for Chrome and Firefox; side panel; capture screenshot + DOM snapshot of the active tab; draw element boxes on the preview. Done when it works on 3 different sites in both browsers.
- **M2 DOM privacy layer:** validators with unit tests (fake data), DOM heuristics, text sanitizer, tokenizer, vault, redacted preview, payload inspector, egress guard. Done when every PII item on the demo site is redacted in the preview and tests pass.
- **M3 Agent loop:** FastAPI server + VLM + Set-of-Mark + action executor + token rehydration + confirm-before-submit. Done when "fill the form with my profile" works on the demo site and server logs contain zero raw PII. First full end-to-end demo.
- **M4 Vision layer v1:** pretrained face detector + OCR on image/canvas regions via onnxruntime-web (WebGPU → WASM), change detection, timings in the UI. Done when profile photos and an ID-card image are redacted.
- **M5 Custom detector:** synthetic data engine → train → export → integrate; variant benchmark table.
- **M6 Eval harness:** all metric scripts and a single command that rebuilds the results table.
- **M7 Polish:** disclosure levels, latency optimizations, Firefox pass, demo script, backup video.

## 9. Demo script (about 5 minutes)
1. Open a KYC or scholarship page full of fake PII and a profile photo.
2. Toggle original ↔ "what the server sees" and open the payload inspector: no raw PII anywhere.
3. Run the task. The server says `type ⟦PROFILE.EMAIL⟧`; the real email appears in the field, filled locally.
4. The agent pauses before Submit and asks for confirmation.
5. Show the metrics panel (latency breakdown, model sizes, WebGPU vs WASM) and the eval table.
6. Repeat quickly on a real site and on an image-heavy page to show the vision layer.

## 10. Suggested team split
- Extension (capture, DOM layer, executor, side panel): 2 people
- ML (synthetic data, training, browser inference): 1–2 people
- Server, prompts, model hosting: 1 person
- Eval harness, demo site, presentation: 1 person

Work on branches, merge small PRs often, and keep `docs/PROGRESS.md` as the shared status board.
