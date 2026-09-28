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

# 2. Server — no API key needed, it falls back to a deterministic planner.
#    PLANNER_VIEW=1 turns on the live "what the server sees" page.
cd server && PLANNER_VIEW=1 uv run uvicorn app.main:app --port 8000

# 3. Extension
cd extension && npm run dev
```

On the Windows laptop, `scripts\start.ps1` does all three in one command, and
`scripts\start.ps1 -Model qwen3-vl:4b-instruct` does it with the local model.

Then, once:

- Open the side panel. **Leave the vault empty** — act 1 fills it on stage. (If you
  would rather not, expand **What PrivAgent knows about you** and press **Load demo profile**.)
- Open `http://localhost:5173/apply.html` and press **Analyze** once. This pays the
  one-time model load (~2 s) so the live demo is warm; the form is empty, so there
  is nothing to offer the vault and it stays empty.
- Press **Reset** to clear the session.
- Have a second tab on a real site with a login form.

**Second screen.** Open `http://localhost:8000/view` on the projector or a second
monitor: every step the server receives appears there as it arrives — the redacted
screenshot, the tokens, the decision. Keep the side panel on your screen, this on
theirs, and the boundary is visible from both sides for the whole demo. In act 1
it stays empty — Analyze sends nothing — which is itself the point.

**Checklist:** side panel open · vault empty (or demo profile loaded) · server says *Connected* under
Settings · `/view` open on the second screen · screen sharing set to the browser
window, not the whole desktop.

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

For a real open-weights model on the laptop: on the Windows RTX 3050 laptop,
`ollama pull qwen3-vl:4b-instruct` and `scripts\start.ps1 -Model qwen3-vl:4b-instruct`
— ~2 s a model step, 13 of the 19 benchmark tasks, all safe. Rehearse the acts below
with it: it completes the form fill, the questions and both injection pages, and it
is weaker on dropdown-heavy, Hindi and rich-text forms. Use an **`-instruct`** tag: a
thinking model spends its whole budget reasoning and the planner falls back to rules.
On an 8 GB Mac, `qwen2.5vl:3b` works but takes 7–30 s a step. Decide beforehand.

---

## Act 1 — "It hides" (90 seconds)

> This is a scholarship application, pre-filled. Aadhaar, PAN, card, password,
> a photo, a scanned ID.

Open `kyc.html`. Press **Analyze**.

**Drag the divider in the preview slowly from right to left.**

That is the whole idea in one gesture: the left half is your screen, the right half
is what the server would receive. Say it plainly:

> Nothing has been sent yet. This all happened on this laptop — a quarter of a second
> a step once the models are warm, about a second the first time.

**The card under the preview: "Save your details from this page?"** With an empty
vault, Analyze found a name, an email, a phone, an Aadhaar number and more in the
form, and offers them — masked — for the vault.

> I never typed my details into this extension. It just read them off a form I filled
> in myself, and it asks before keeping them. They go into a vault on this laptop,
> never to a server.

Press **Save to vault**, then **Analyze** again. The tokens change from `⟦EMAIL_1⟧` to
`⟦PROFILE.EMAIL⟧`: they are *yours* now, usable on any site — kept on this laptop,
encrypted, so they survive a browser restart. Open **What PrivAgent knows about you**:
every item is listed, masked, with a × to forget it.

(Optional, 20 seconds: expand **What PrivAgent knows about you** → **Scan an ID card** → pick
`demo-site/assets/id-card.svg`. The Aadhaar number and date of birth are read off the
*image*, on this laptop, and offered the same way. The image is not kept.)

Point at three things, in this order:

1. **The photo is pixelated.** It is not in the DOM — there is no text to read
   there. That took a 227 KB face detector.
2. **Scroll the page down to the ID card and press Analyze.** `⟦PROFILE.AADHAAR⟧`
   appears with source `ocr` — read *out of the card image* on this laptop, and given
   the same token as the form field. The server can tell they are the same person's
   number without ever seeing it. **Hover that row** and its box lights up on the
   preview, so nobody has to take your word for which pixels it covers.
3. **The egress guard bar.** It re-scanned every string after everything else ran,
   and found nothing. That is the backstop: every other layer can have a bug.

Then look at the counter line under the metrics: **0 requests · 0 B sent**. It is a
live counter, not a claim — it will move the moment anything is sent, and it has not.

Open **What leaves the device** and scroll it. Real JSON, no prose.

> Search this for a single digit of an Aadhaar number. There isn't one.

**If someone asks "what if the model misses something?"** — that is exactly why the
guard exists. It does not trust any of the layers above it.

---

## Act 2 — "It acts" (90 seconds)

*(Optional opener, 30 seconds — how it learns you without a settings form. Start from
an empty memory: **Forget everything**. Open `apply.html` and type your name, email and
mobile into it yourself — fake ones — and press **Save draft**. The page shows
**"Remember what you typed?"**: field names, never values. Press **Remember**. Reload.)*

> I typed that once, like anyone would. It asked, I said yes, and it is on this laptop
> now — encrypted, and listed in the panel with a × beside each item.

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

Point at the **conversation** under the prompt: each request is a turn, with a line
that says what happened — *Done · 9 filled · 5 on this device · 10 steps*. It is a
chat, and it remembers the turns before: they go to the planner, tokens only, so a
follow-up is understood.

Ask a follow-up, right there: *"what is my email on this form?"*

> `Email address: ananya.iyer@example.com` — and read the line under it: the server
> saw only ⟦PROFILE.EMAIL⟧. It answered a question about my data without my data.

Then ask it something about *you* on another page. Open `profile.html` and type *"What email address
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
| Precision | 1.000 | **0.956** |
| Recall | 0.978 | **0.935** |
| **Leak test** | **0** | **0** |

> The first column is the pages we built. Anyone can score well on those. The second
> is pages we wrote to be *unlike* ours — a React form with no labels, a 2005
> government portal in nested tables, a Hindi-English statement with no form fields
> at all — and never looked at while writing a rule. The first time we ran it, recall
> was 0.784; that is the only truly blind number it will ever give, and we say so.

> These are measured on real screenshots. They used to be measured on a stand-in with
> no text in it, and when we fixed that, our own precision dropped from 1.000 to
> 0.880 — the vision model was boxing ordinary sentences. We fixed the cause, not the
> number, and wrote down what it cost.

> The leak test is the one I'd push on if I were you. It takes a real screenshot,
> redacts it exactly as the extension does, runs OCR over it, and counts how many real
> values are still readable. Zero, on all ten pages.

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
Yes, and it is almost entirely the ONNX runtime — 26.5 MB of the 45.8 on Chrome. It
ships once and loads lazily; a screen that needs no model pays 2–27 ms and zero
megabytes, and at run time the extension process settles at about 330 MB and stays
there. We already took Firefox from 45.8 MB to **32.3 MB** by giving it the
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
Yes — two open-weights models, locally through Ollama, over the same 19-task
benchmark. Qwen3-VL 4B on this laptop's RTX 3050: 13 of 19 completed, all 19 safe,
about 2 seconds a step. Qwen2.5-VL 3B on an 8 GB Mac: slower, 4 of the 6 model tasks.
Both went wrong in the ways the gates exist for — the 4B tried to type the email into
"Father's name", the 3B went for the Aadhaar number on the injection page — and both
were stopped on the client, which is the point: the gates do not depend on the model
being good. A larger hosted model is three environment variables away.

**"Do I have to type my details into it?"**
No. The first time a form needs something the vault does not have, the agent asks
once and remembers — the next form that asks the same question is filled without
asking. Analyze offers to save details you already typed into a page. Nothing learned
leaves the laptop: the server sees `⟦PROFILE.FATHER_NAME⟧`, never the name.

**"Where is the vault kept? What if the laptop is stolen?"**
Nothing is kept until you say yes to it. Then it is saved encrypted — AES-GCM with a
key the browser marks non-extractable, so no script can copy it off the machine — and
the plaintext never touches the disk. Someone who can run code
as this extension, on this user's browser profile, can still decrypt it, exactly as they
could the browser's own saved addresses; we say that in D36 rather than overclaim.

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
