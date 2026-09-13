# Demoing this to judges, live, on a site THEY pick

This is written for the actual SIH judging-round situation: you have a few
minutes, a laptop, wifi you don't control, and judges who will ask you to
try it on a page you didn't prepare. Here's how to be ready for that.

## 1. Where the "AI" actually is

Your server (`server/main.py`) already calls a real LLM to decide what to
do next — it's not simulated. `decide_next_action_vlm()` sends the
**redacted** screenshot + the marked-up element list to Anthropic's Claude
API (`ANTHROPIC_API_KEY`) and asks it to pick the next action. If that call
fails or no key is set, it falls back to `decide_next_action_rule_based()`,
a simple heuristic ("click the first empty input, then the submit
button") — this exists so a demo never hard-crashes on stage, but the
**real** answer to "which AI" is Claude, and you should say so plainly if
asked. If a judge specifically asks about a different provider (OpenAI,
etc.), see §5 below for the honest answer on swapping it in.

Say this out loud during the demo, in plain terms: *"The screenshot is
redacted on-device before anything leaves the browser — the server, and
the AI model it calls, only ever sees the sanitized version."* That's your
actual privacy pitch, and it's true of what's in this repo, which matters
more on stage than it sounds.

## 2. What "works everywhere" means here, honestly

Detection runs on screenshot PIXELS (via ONNX Runtime Web) and OCR runs on
those same pixels (via Tesseract.js) — neither depends on a site's HTML
structure, so architecturally this isn't tied to your demo page. But two
things gate how well it performs on a page you've never seen:

- **The detector's training.** Ship `vendor/ui_detector.onnx` trained on a
  real, varied dataset (Step 1/2 of the README) before judging, not the
  untrained smoke-test model this repo defaults to. Test the trained model
  against 5-10 real, unfamiliar sites yourself beforehand — signup forms,
  a news site, a dashboard — so you know its rough hit rate going in,
  rather than finding out live.
- **The OCR redaction layer degrades gracefully, not silently.** It's
  regex-based (card/CVV/PIN/Aadhaar/password patterns, see
  `extension/ocr-redactor.js`) — it will not catch every possible kind of
  sensitive data on an arbitrary site, and it says so in the popup metrics
  (`ocr_regions_found`, `ocr_degraded`) rather than pretending otherwise.

If a judge opens a page your model has never remotely seen the likes of
(a Figma-style canvas app, a complex SPA with no real inputs), expect
lower recall — that's genuinely honest to say, and "here's what the
popup's live numbers show, and here's why" is a stronger answer than
overclaiming and getting caught by a follow-up question.

## 3. The demo script (safe order of operations)

1. **Before judges arrive:** start the server (`uvicorn main:app --port
   8000`) with `ANTHROPIC_API_KEY` set, confirm it's actually reachable
   (`curl http://localhost:8000/health` if you have one, or just watch the
   first real run succeed), and load the unpacked extension in a REAL
   Chrome window (`chrome://extensions` → Load unpacked → `extension/`).
   Do this on the actual demo machine, not just yours — permissions,
   `localhost:8000` reachability, and display scaling can all differ.
2. **Open the popup, run it once on YOUR demo page first.** This is your
   known-good path: shows the redacted-screenshot preview, the metrics
   grid, and (new) an **Export benchmark JSON** button with real numbers
   from that exact run. Point at `elements_detected`,
   `vision_inference_ms`, `ocr_ms`, `sensitive_regions_redacted` on
   screen — these are live, not slides.
3. **Then ask the judges to name a site**, or navigate to one yourself
   (a real login/signup page is the strongest choice — it has both
   interactable elements AND sensitive fields, so both halves of the
   pipeline get exercised in front of them). Run it there.
4. **If step 3 underperforms** (model doesn't recognize an unusual
   layout, OCR misses something with heavy background texture), don't
   hide it — this is where you explain the architecture ("it's not
   reading the DOM, it's reading pixels, the same way a screen-reader
   human would, and here's what a few hundred more training pages would
   fix") rather than pretending it's perfect. Judges reward engineers who
   understand their own system's edges over ones who claim there are
   none.
5. **Close with the exported benchmark JSON** as your evidence artifact —
   it's the same file format `training/benchmark_redaction.mjs` and
   `training/benchmark_detection.py` produce, so you can show pre-computed
   precision/recall numbers from a larger offline test set (run those
   scripts the night before) ALONGSIDE the just-now live numbers. Two
   different kinds of evidence: "here's what it does in front of you
   right now" and "here's what it does across a broader labeled test set
   I ran ahead of time."

## 4. Contingency: no wifi / no `localhost` reachability on the demo machine

Judging-room wifi is a real risk to your Anthropic API call specifically
(the on-device vision + redaction pipeline itself needs no network at all
— that's the point). If the server can't reach `api.anthropic.com`:

- The rule-based fallback in `decide_next_action_rule_based()` still lets
  you show the full on-device pipeline (detection → redaction → OCR →
  marked screenshot) end-to-end, just without the LLM's reasoning step.
  Say this explicitly rather than letting it look like a silent
  degradation: *"the vision and redaction are fully on-device and just
  worked with zero network — the one thing that needs connectivity is the
  reasoning step, which just fell back to a rule."*
- If you know in advance the venue's wifi is unreliable, a phone hotspot
  as backup for the ONE call that needs internet (the Anthropic API call)
  is worth having ready.

## 5. "What if a judge asks about OpenAI specifically?"

Be straightforward: this repo's server calls Anthropic's Claude API today
(`server/main.py`, `decide_next_action_vlm()`). Swapping in OpenAI's API
instead is a real but separate piece of work — different request/response
schema, different image-input format — not a config flag flip. If that's
worth doing before judging, say so and scope it as its own task rather
than mentioning it in passing during a demo and getting a follow-up
question you're not ready for.
