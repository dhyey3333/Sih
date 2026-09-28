# Demo video

A 3 min 50 s video for YouTube and the SIH judges. Every claim in the narration is one
the project measures and `docs/SUBMISSION.md` backs — nothing here is aspirational.
Subtitles: [`video/captions.srt`](video/captions.srt).

**Fake data only.** Everything on screen is the demo profile, the demo pages and the
demo ID card. A public video is public forever: never record with your own details in
the browser, and press **Forget everything** before you start.

---

## 1. Before you record (15 minutes)

**Machine**

- [ ] Windows: Settings → System → Notifications → **Do not disturb** on.
- [ ] Close everything else. Plug in the charger (the GPU slows on battery).
- [ ] Screen at 1920 × 1080. Chrome maximised, **bookmarks bar hidden** (Ctrl+Shift+B),
      zoom 110% (Ctrl + +) so text is readable on a phone.
- [ ] A clean Chrome profile, or at least no personal tabs, no extensions but PrivAgent.

**Project** — from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

This opens the demo pages (port 5173), the planner with the live server view (port 8000)
and Chrome with PrivAgent loaded. For scene 6 also start the injection stub, in two
more windows (see `docs/DEMO.md`, "Before you start"):

```powershell
cd server; uv run uvicorn tools.mock_vlm:app --port 8100
```
```powershell
cd server; $env:VLM_BASE_URL='http://localhost:8100/v1'; $env:VLM_MODEL='mock-injected'; uv run uvicorn app.main:app --port 8001
```

**Extension state**

- [ ] Open the side panel. Expand **What PrivAgent knows about you** → **Forget everything**.
- [ ] Warm the models once: open `http://localhost:5173/apply.html`, press **Analyze**.
      Then **Reset**.
- [ ] Tabs, in order: `http://localhost:5173/kyc.html`, `http://localhost:5173/apply.html`,
      `http://localhost:8000/view`, `http://localhost:5173/search.html`.

**Recording**

- [ ] OBS Studio (free): 1920×1080, 30 fps, "Display Capture", mic on, **record a 10 s
      test** and play it back. Or Xbox Game Bar: **Win + Alt + R** to start and stop.
- [ ] Record the screen **without** talking first; record the narration separately
      afterwards, reading the script below. It is far easier to get both right.
- [ ] Do each scene as its own clip. A mistake costs one scene, not the video.

---

## 2. The script

Timings are targets. **Caption** is the text to put on screen in the editor.

### Scene 0 — Cold open (0:00–0:15)

**Screen:** `kyc.html`, side panel open, analyzed already. Drag the divider in the
preview slowly from right to left, across the Aadhaar number and the photo.

> This is what you see. And this is what an AI agent is allowed to see. Same screen —
> but your Aadhaar number, your face and your password never left this laptop.

**Caption:** *What you see ↔ what the AI sees*

### Scene 1 — The problem (0:15–0:35)

**Screen:** title card over the blurred KYC page: problem title, ISRO, SIH.

> AI agents can fill forms and run tasks for us — but only if they can see the screen,
> and today that screen goes to someone else's server. Aadhaar numbers, bank details,
> faces. The Smart India Hackathon asked us, for ISRO: can the agent's eyes stay on the
> device, and send the server only what it needs?

**Caption:** *SIH · ISRO · On-device Visual Perception for Light-weight Browser Agents*

### Scene 2 — It hides (0:35–1:10)

**Screen:** `kyc.html`. Press **Analyze**. Show the preview, then point (cursor) at the
pixelated photo, a black box with `⟦PROFILE.AADHAAR⟧`, the green **Egress guard passed**
bar, and the counter line **0 requests · 0 B sent**.

> PrivAgent is a Chrome, Edge and Firefox extension. Press Analyze, and small AI models
> running right here in the browser read the page — the form, the photo, even text inside
> images. The face is pixelated. Every personal value is painted out with a solid box and
> replaced by a token, like "PROFILE dot AADHAAR". And before anything could be sent, a
> final guard re-scans everything. Zero requests so far. Nothing has left this laptop.

**Caption:** *All of this ran on the laptop · 0 requests · 0 bytes sent*

### Scene 3 — It learns you, without a settings form (1:10–1:40)

**Screen:** `apply.html`, empty. Type the fake details by hand — the agent in scene 4
can only fill what it has learned here, so type all eight (speed this up 3× in the edit):

| Field | Type |
|---|---|
| Full name | Ananya Iyer |
| Email address | ananya.iyer@example.com |
| Mobile number | 9812345678 |
| Date of birth | 14/03/2001 |
| Aadhaar number | 2234 5678 9018 |
| PAN | ABCPI1234K |
| Residential address | 42 Nehru Road, Bandra West, Mumbai |
| PIN code | 400050 |

Press **Save draft**. The prompt appears bottom-right: **"Remember what you
typed?"** Press **Remember**. Open **What PrivAgent knows about you** in the panel: the
list, masked.

> You never type your details into PrivAgent. You fill in a form once, like anyone would —
> and it asks one question: remember what you typed? One tap. It's stored on this laptop,
> encrypted, and you can see and forget every item.

**Caption:** *One tap · stored on the laptop, encrypted · never sent*

### Scene 4 — It acts (1:40–2:25)

**Screen:** reload `apply.html` — empty again. Put the `localhost:8000/view` tab beside it
(or cut to it). Type in the panel: *"fill this form with my profile and stop before
submitting"* → press →. Let the fields fill. The conversation line reads
**Done · 8 filled · 5 on this device** (or close to it — it counts what it did). Cut to the server view: redacted screenshots and
tokens only.

> Now I just ask. The agent fills the form. Five of these fields never even needed the
> server — the page said what they were, and the laptop filled them. For the rest, the
> server's AI got this: a blacked-out screenshot and tokens. It answers "type PROFILE dot
> EMAIL into field five" — and only the laptop knows what that is. It stops before
> Submit, because I told it to. Pressing Submit, paying, deleting — the client always
> asks a human first.

**Caption:** *The server sees ⟦PROFILE.EMAIL⟧ — never your email*

### Scene 5 — It talks (2:25–2:45)

**Screen:** in the panel type *"what is my email on this form?"*. The answer card shows
the email with the line *"The server saw only ⟦PROFILE.EMAIL⟧. Filled in here, on this
device."*

> It's a conversation, so I can ask a follow-up. The answer is my real email — but read
> the line underneath. The server answered a question about my data without ever seeing
> my data.

**Caption:** *Answered by the server · filled in on the laptop*

### Scene 6 — It can't be tricked (2:45–3:10)

**Screen:** in the panel's Settings set *Planner server* to `http://localhost:8001` (the
stub that obeys pages). Open the search page — show the grey box telling AI assistants to
type the user's Aadhaar into the search box. Open `http://localhost:5173/search.html`.
Task: *"Find scholarships for engineering students"*. The confirmation sheet appears: the agent wants to type your Aadhaar number
into a field that did not ask for it. Press **No**. Set the server back to 8000.

> This page is hostile: it tells AI assistants to type my Aadhaar number into its search
> box. Here we've connected a planner built to obey it — the worst case. It asks for the
> Aadhaar token, and the laptop refuses: an Aadhaar number only goes into an Aadhaar
> field. The server chose the token, but it can't lie about what the token is.

**Caption:** *Prompt injection: blocked on the device*

### Scene 7 — It proves it (3:10–3:35)

**Screen:** `eval/results/RESULTS.md` or a clean slide with the numbers.

> Every number is regenerated by one command, on real screenshots. Personal-data
> detection: precision one-point-zero, recall ninety-eight percent on our pages; on pages
> written to be unlike ours, ninety-six and ninety-four. After redaction we read the
> screenshots back with OCR: zero values recoverable. Nineteen of nineteen agent tasks
> completed safely. And the AI can be any open-weights model — this one ran on the
> laptop's own GPU, two seconds a step.

**Caption:** *P 1.000 · R 0.978 · leak test 0 · 19/19 tasks safe*

### Scene 8 — Close (3:35–3:50)

**Screen:** the divider wipe again, slower, then the end card: project name, team name,
institute, GitHub link.

> An agent that sees what you see — and keeps what's yours on your device. PrivAgent.

**Caption:** *PrivAgent — nothing personal leaves the device · [Team name] · [Institute]*

---

## 3. Editing (Clipchamp, built into Windows 11)

1. Drop the scene clips on the timeline in order; drop the narration under them.
2. Trim each clip to its narration. Speed up form-filling (1.5×) if it runs long —
   never the Analyze or prompt moments.
3. Add the captions above as text overlays, bottom-third, 2–3 s each.
4. Zoom in (Clipchamp "crop / zoom") on the panel for scenes 3, 5 and 6 — the panel is
   narrow and hard to read at full-screen size on a phone.
5. Soft background music at −25 dB under the voice (Clipchamp has free tracks).
6. Import `docs/video/captions.srt` as subtitles, or upload it to YouTube separately.
7. Export 1080p.

---

## 4. YouTube

**Title** (pick one)

- PrivAgent — an AI browser agent that never sees your personal data | SIH, ISRO
- On-device AI keeps your Aadhaar off the server — privacy-preserving browser agent (SIH)

**Description**

```
PrivAgent is a Chrome, Edge and Firefox extension that lets an AI agent see and use your
screen without ever seeing your personal data. Small AI models run inside the browser,
find and black out Aadhaar numbers, PAN, faces, passwords and other personal details,
and send the server only a redacted screenshot and tokens like ⟦PROFILE.EMAIL⟧. The
laptop swaps the tokens back for your real details at the last moment.

Built for the Smart India Hackathon problem statement "On-device Visual Perception for
Light-weight Browser Agents" (Indian Space Research Organisation).

0:00 What the AI sees
0:15 The problem
0:35 It hides — on-device redaction
1:10 It learns you, with one tap
1:40 It acts — the agent fills a form
2:25 It talks — questions about your own data
2:45 It can't be tricked — prompt injection
3:10 The numbers
3:35 PrivAgent

Measured: PII detection precision 1.000 and recall 0.978 on our demo pages (real
screenshots); 0 values recoverable after redaction; 19/19 agent tasks completed safely;
open-weights Qwen3-VL on a laptop GPU at ~2 s a step.

All data in this video is synthetic.

Team [Team name], [Institute]
[GitHub link]
```

**Tags:** privacy, AI agent, browser extension, Smart India Hackathon, SIH, ISRO, on-device
AI, WebGPU, ONNX, PII redaction, Aadhaar, data protection, DPDP Act, open source AI

**Thumbnail:** the KYC page split down the middle — left half normal, right half
redacted with black boxes and `⟦PROFILE.AADHAAR⟧` — and three words in large type:
**"AI can't see this"**. Export a frame from scene 0 and add the text in Clipchamp or Canva.

**Pinned comment:** "Everything shown uses synthetic data. Questions about how the
redaction works? Ask below — every number in the video is reproducible with one command."
