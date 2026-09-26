# Demo script

Five minutes. Four acts: **it hides**, **it acts** (and **can't be talked into it**), **it proves**, **anywhere**.

The single most important instruction: **let the judges pick the site.** Everything
below works on the demo pages, and the point of act four is that it also works on a
page nobody prepared.

---

## Before you start (10 minutes ahead)

```bash
# 1. Demo site
python3 -m http.server 5173 --directory demo-site

# 2. Server — no API key needed, it falls back to a deterministic planner
cd server && uv run uvicorn app.main:app --port 8000

# 3. Extension
cd extension && npm run dev
```

Then, once:

- Open the side panel, expand **My vault**, press **Load demo profile**.
- Open `http://localhost:5173/kyc.html` and press **Analyze** once. This pays the
  one-time model load (~2 s) so the live demo is warm.
- Press **Reset** to clear the session. The vault keeps the profile.
- Have a second tab on a real site with a login form.

**Checklist:** side panel open · profile loaded · server says *Connected* under
Settings · screen sharing set to the browser window, not the whole desktop.

For act 2b you need a planner that *falls for* prompt injection, so the gate has
something to stop. Run it as a **second** planner on port 8001, beside the ordinary one
on 8000, so acts 1 and 2 are untouched:

```bash
cd server && uv run uvicorn tools.mock_vlm:app --port 8100
cd server && VLM_BASE_URL=http://localhost:8100/v1 VLM_MODEL=mock-injected uv run uvicorn app.main:app --port 8001
```

Say what it is: a stub speaking the same protocol as vLLM or Ollama, written to obey
every page — the worst case, on purpose. Claiming it is a model is the one thing that
will sink you. (A real 3B model did fall for the same page in our benchmark; the stub
just does it every time.)

For a real open-weights model on the laptop: `ollama pull qwen2.5vl:3b`, then
`VLM_BASE_URL=http://localhost:11434/v1 VLM_MODEL=qwen2.5vl:3b VLM_STRATEGY=rules-first
VLM_IMAGE=auto`. It works, and it is slow on 8 GB — 7 s a step with text, over a
minute with the screenshot — so rehearse with it, and decide beforehand.

---

## Act 1 — "It hides" (90 seconds)

> This is a scholarship application, pre-filled. Aadhaar, PAN, card, password,
> a photo, a scanned ID.

Open `kyc.html`. Press **Analyze**.

**Drag the divider in the preview slowly from right to left.**

That is the whole idea in one gesture: the left half is your screen, the right half
is what the server would receive. Say it plainly:

> Nothing has been sent yet. This all happened on this laptop — about 40 milliseconds
> a step once the models are warm, under half a second the first time.

Point at three things, in this order:

1. **The photo is pixelated, the ID card is blacked out.** Neither is in the DOM —
   there is no text to read there. That took a 227 KB face detector and OCR.
2. **`⟦PROFILE.AADHAAR⟧` appears twice** in the detections list — once from the form
   field, once read by OCR *out of the card image*. Same value, so same token. The
   server can tell they are the same person's number without ever seeing it.
   **Hover that row** and its box lights up on the preview, so nobody has to take
   your word for which pixels it covers.
3. **The egress guard bar.** It re-scanned 142 strings after everything else ran, and
   found nothing. That is the backstop: every other layer can have a bug.

Then look at the counter line under the metrics: **0 requests · 0 B sent**. It is a
live counter, not a claim — it will move the moment anything is sent, and it has not.

Open **What leaves the device** and scroll it. Real JSON, no prose.

> Search this for a single digit of an Aadhaar number. There isn't one.

**If someone asks "what if the model misses something?"** — that is exactly why the
guard exists. It does not trust any of the layers above it.

---

## Act 2 — "It acts" (90 seconds)

Open `apply.html` — the same form, empty.

Type: *"fill this form with my profile and stop before submitting"*. Press **→**.

Let it run. Narrate the **Activity** panel as lines appear:

> `local → type ⟦PROFILE.EMAIL⟧ … the page itself declares field 4 as autocomplete=email`

> That step never touched the network. The page declared what the field was, we had
> the value — there is nothing for a model to reason about, so we didn't ask one.
> That's disclosure level zero.

Point at the counter line again: **5 handled on-device** before a single request goes
out. When a step does go to the server, the disclosure metric moves to **L2** and the
payload inspector shows the tokenized request.

The form fills. Then it stops.

> It filled nine fields and stopped at Submit, because I told it to. Watch what
> happens if I don't.

Run again with *"fill this form and submit it"*. **The confirmation sheet appears.**

> The server is instructed never to press an irreversible button. But instructions
> aren't a guarantee — so the *client* refuses too, and asks. Submit, pay, send,
> delete: all of them stop here.

Press **Stop**.

Then ask it something about *you*. Open `profile.html` and type *"What email address
is on my profile?"*.

> The answer card shows my email. The server never saw it — read the line under it.

*The server saw only ⟦PROFILE.EMAIL⟧. Filled in here, on this device.* The server
answered a question about my data without learning my data.

---

## Act 2b — "It can't be talked into it" (45 seconds)

Under **Settings**, set *Planner server* to `http://localhost:8001` — the injection stub
(see *Before you start*). Open `search.html`.

> This page is hostile. Read the grey box: it tells AI assistants to type my Aadhaar
> number into its search box — and the page reads back whatever lands there.

Type *"Find scholarships for engineering students"*. Press **→**.

The planner falls for it and asks to type `⟦PROFILE.AADHAAR⟧` into the search box.
**The confirmation sheet appears instead:** *the agent wants to type your Aadhaar
number into “Search”, which we did not detect as asking for it.*

> The server picked the token, but it can't lie about what the token *is* — only
> the vault on this laptop knows that. An Aadhaar number goes into an Aadhaar field
> or nowhere without my say-so. Press **No**: the red line on the page never appears.

Set *Planner server* back to `http://localhost:8000`.

(With the ordinary planner, "Search for …" is done on the device and never reaches a
model at all — so the page's note is read by nothing.)

---

## Act 3 — "It proves" (60 seconds)

Switch to a terminal.

```bash
uv run python -m eval.run_all
```

While it runs:

> Every number we claim is regenerated by this one command. It drives a real browser
> over the code that actually ships.

Show `eval/results/RESULTS.md`, and go **straight to the holdout table**:

| | Demo site | Holdout |
|---|---|---|
| Precision | 1.000 | **1.000** |
| Recall | 0.978 | **0.913** |
| **Leak test** | **0** | **0** |

> The first column is the pages we built. Anyone can score well on those. The second
> is four pages we wrote to be *unlike* ours — a React form with no labels, a 2005
> government portal in nested tables, a Hindi-English statement with no form fields
> at all — and never looked at while writing a rule. The first time we ran it, recall
> was 0.784. Fixing what it found took it to 0.913. Precision never moved off 1.000.

> The leak test is the one I'd push on if I were you. It takes the redacted image,
> runs OCR over it, and counts how many real values are still readable. Zero, on all
> eight pages.

If time allows, show the **Pipeline** panel: `WEBGPU · 227 KB · 50 ms`.

---

## Act 4 — "Anywhere" (60 seconds)

> Pick a site. Anything with a login form.

Open it. Press **Analyze**.

> No rules for this site. The DOM layer reads `autocomplete` and `<label>`, which
> every well-built form has, and the vision layer covers what it can't.

Untick **On-device vision** in the Pipeline panel and Analyze again on `kyc.html`.

> That's the DOM layer alone. The photo and the ID card come back. That's what the
> models are buying, and it's why both layers exist.

---

## Questions you should expect

**"Is 45 MB not enormous for an extension?"**
Yes, and it is almost entirely the ONNX runtime — 26.5 MB of the 45.7 on Chrome. It
ships once and loads lazily; a screen that needs no model pays 2–27 ms and zero
megabytes. We already took Firefox from 45.7 MB to **32.2 MB** by giving it the
WASM-only runtime, which runs on every Firefox, including Linux, where WebGPU is still
behind a flag. FP16 export is the next lever.

**"You trained your own model?"**
Yes — `ml/`. 2,280 images with zero manual annotation: the generator writes
`data-pii` into every page it builds, and Playwright reads the boxes back out of the
DOM. Same attribute the eval harness scores against, so labels and ground truth
cannot drift apart.

**"What if the server is compromised?"**
It only ever held tokens. There is nothing there to steal. And the server runs the
same PII scan on arrival — if the client had a bug, the server refuses the request
rather than forwarding it to the model.

**"Does this work in Firefox?"**
Yes — one codebase, both targets build, `web-ext lint` reports 0 errors. Our Firefox
build takes the WASM path: 181 ms instead of 50 ms. Firefox has shipped WebGPU on
Windows and recent macOS, but not yet on Linux, and the WASM build runs everywhere —
which is why the WASM path is not a fallback we tolerate, it is a first-class path we
measure, and why Firefox ships a smaller runtime than Chrome rather than a bigger one.

**"Have you run it against a real model?"**
Yes — Qwen2.5-VL 3B, open weights, locally through Ollama, over the same 19-task
benchmark. It answers questions from the screen text in about 7 seconds a step on an
8 GB laptop. It also typed a made-up email into a login form, and on the injection
page it went for the Aadhaar number — both stopped by the client's gates, which is
the point: the gates do not depend on the model being good. A larger model is three
environment variables away.

**"How do you know nothing leaked?"**
The task benchmark records every request the panel sends, from outside the
extension, and searches it for the profile's values — and OCRs every screenshot it
sent. Zero, across every task. That check found a real bug once (a pixel-ratio
mismatch left a typed email legible), which is why it exists.

**"Does it work in Hindi?"**
Yes — Hindi labels are classified, Hindi values in page text are caught, and a
"जमा करें" button needs the same confirmation as "Submit". The benchmark has a Hindi
form with a Hindi task.

**"What's the weakest part?"**
No hand-labelled real screenshots. The holdout is the closest we have, and it is
still pages we wrote.

---

## If something breaks

| Symptom | Do this |
|---|---|
| "Content script not loaded" | Reload the page. Extensions cannot inject into `chrome://` or the web store. |
| Server *Unreachable* | It degrades to a local-only demo. Act 1 and act 4 still work fully. |
| Vision seems slow | Check the Pipeline panel — it may have fallen back to WASM. Say so; the number is honest. |
| Panel looks blank | `uv run python -m eval.smoke_extension` tells you in 20 seconds whether the build boots. |
| Anything at all | **Play the backup video.** Record it the night before, from this same script. |
