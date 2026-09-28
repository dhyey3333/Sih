"""Produce the PrivAgent demo video, end to end, with no human at the keyboard.

1. Narration: Windows' built-in "Microsoft Ravi" voice, one WAV per scene.
2. Recording: the packed extension in a real Chromium, driven scene by scene; each scene
   lasts as long as its narration. Playwright records the page and the side panel.
3. Composition: page (1440x1080) | panel (480x1080) -> 1920x1080, narration placed at each
   scene's start, subtitles burned in. H.264 + AAC MP4.

Fake data only: the demo pages, the demo values typed below, the demo ID card.

Windows only (the voice is a Windows voice, read through PowerShell 7's System.Speech).
Build the extension first (cd extension && npm run build), then from the repo root:

    uv run --with imageio-ffmpeg python scripts/make_video.py

Writes PrivAgent-demo.mp4 and PrivAgent-demo.srt in the repo root (gitignored).
The script docs/VIDEO.md describes is the same film, for a human to record.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import wave
from pathlib import Path

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))
WORK = Path(tempfile.gettempdir()) / "privagent-video"

import imageio_ffmpeg  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from eval.run_all import serve  # noqa: E402
from eval.run_tasks import BUILD, start_server, wait_until  # noqa: E402

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
PAGE_W, PANEL_W, H = 1440, 480, 1080

# (id, spoken text for the voice, caption text for the subtitles)
SCENES = [
    ("open",
     "This is what you see. And this is what an A.I. agent is allowed to see. The same screen, "
     "but the Aadhaar number, the photo, and the password, never leave this laptop.",
     "This is what you see. And this is what an AI agent is allowed to see. The same screen — "
     "but the Aadhaar number, the photo and the password never leave this laptop."),
    ("problem",
     "A.I. agents can fill forms and finish tasks for us. But only if they can see the screen. "
     "And today, that screen goes to someone else's server, with Aadhaar numbers, bank details and faces on it. "
     "For the Smart India Hackathon, Isro asked: can the agent's eyes stay on the device, and send the server only what it needs?",
     "AI agents can fill forms and finish tasks for us — but only if they can see the screen. "
     "Today that screen goes to someone else's server, with Aadhaar numbers, bank details and faces on it. "
     "For the Smart India Hackathon, ISRO asked: can the agent's eyes stay on the device, and send the server only what it needs?"),
    ("hides",
     "Priv Agent is a browser extension, for Chrome, Edge and Firefox. Press Analyze, and small A.I. models, running inside the browser, "
     "read the page: the form, the photo, even text inside images. The face is pixelated. Every personal value is covered with a solid box, "
     "and replaced by a token. Before anything could be sent, a final guard scans everything again. Zero requests so far. Nothing has left this laptop.",
     "PrivAgent is a browser extension for Chrome, Edge and Firefox. Press Analyze, and small AI models running inside the browser "
     "read the page — the form, the photo, even text inside images. The face is pixelated. Every personal value is covered with a solid box "
     "and replaced by a token. Before anything could be sent, a final guard scans everything again. Zero requests so far. Nothing has left this laptop."),
    ("learns",
     "You never type your details into Priv Agent. You fill in a form yourself, once, like anyone would, "
     "and the page asks a single question: remember what you typed? One tap. "
     "It is stored on this laptop, encrypted, and you can see, and forget, every item.",
     "You never type your details into PrivAgent. You fill in a form yourself, once, like anyone would — "
     "and the page asks a single question: remember what you typed? One tap. "
     "It is stored on this laptop, encrypted, and you can see and forget every item."),
    ("acts",
     "Now, on a fresh copy of the form, I just ask. The agent fills it by itself. "
     "Every field was filled right here on the laptop, because it recognised the questions it had learned. "
     "The server was asked just once, whether anything was left to do. "
     "And it stops before submit, because I asked it to. Submitting, paying, or deleting, always needs a human to confirm.",
     "Now, on a fresh copy of the form, I just ask. The agent fills it by itself. "
     "Every field was filled right here on the laptop, because it recognised the questions it had learned. "
     "The server was asked just once, whether anything was left to do. "
     "It stops before Submit, because I asked it to. Submitting, paying or deleting always needs a human to confirm."),
    ("talks",
     "It is a conversation, so I can ask a follow up. The answer is my real email. "
     "But read the line underneath. The server answered a question about my data, without ever seeing my data.",
     "It's a conversation, so I can ask a follow-up. The answer is my real email. "
     "But read the line underneath: the server answered a question about my data without ever seeing my data."),
    ("server",
     "This is everything the server received. Blacked out screenshots, and tokens, like profile dot email. "
     "Only the laptop knows what they stand for.",
     "This is everything the server received: blacked-out screenshots, and tokens like ⟦PROFILE.EMAIL⟧. "
     "Only the laptop knows what they stand for."),
    ("tricked",
     "This page is hostile. It tells A.I. assistants to type the user's Aadhaar number into its search box. "
     "Here, the server is a planner built to obey it: the worst case. It asks to type the Aadhaar token, and the laptop refuses. "
     "An Aadhaar number only goes into an Aadhaar field. The server chooses the token, but it cannot lie about what the token is.",
     "This page is hostile: it tells AI assistants to type the user's Aadhaar number into its search box. "
     "Here the server is a planner built to obey it — the worst case. It asks to type the Aadhaar token, and the laptop refuses: "
     "an Aadhaar number only goes into an Aadhaar field. The server chooses the token, but it cannot lie about what the token is."),
    ("proves",
     "Every number is reproduced by one command, on real screenshots. Personal data detection: precision, one point zero, "
     "and recall, ninety eight percent, on our pages. After redaction, zero values can be read back. "
     "Nineteen of nineteen agent tasks completed safely. And the A.I. can be any open weights model: "
     "this one ran on the laptop's own graphics card, at about two seconds a step.",
     "Every number is reproduced by one command, on real screenshots. Personal-data detection: precision 1.0 "
     "and recall 98% on our pages. After redaction, zero values can be read back. "
     "19 of 19 agent tasks completed safely. And the AI can be any open-weights model — "
     "this one ran on the laptop's own graphics card, at about two seconds a step."),
    ("close",
     "An agent that sees what you see, and keeps what is yours, on your device. Priv Agent.",
     "An agent that sees what you see — and keeps what's yours on your device. PrivAgent."),
]

FAKE = {  # the demo profile's fake values, typed by "the user" in scene "learns"
    "#full_name": "Ananya Iyer", "#email": "ananya.iyer@example.com", "#mobile": "9812345678",
    "#dob": "14/03/2001", "[name=aadhaar_no]": "2234 5678 9018", "[name=panNumber]": "ABCPI1234K",
    "[name=address]": "42 Nehru Road, Bandra West, Mumbai", "[name=pincode]": "400050",
}

# --------------------------------------------------------------------------- #
# 1. Narration
# --------------------------------------------------------------------------- #

def narrate() -> dict[str, float]:
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "lines.json").write_text(json.dumps({sid: speak for sid, speak, _ in SCENES}), encoding="utf-8")
    ps = WORK / "tts.ps1"
    ps.write_text(textwrap.dedent(f"""
        Add-Type -AssemblyName System.Speech
        $lines = Get-Content -Raw -Encoding UTF8 '{WORK / "lines.json"}' | ConvertFrom-Json
        foreach ($p in $lines.PSObject.Properties) {{
          $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
          $tts.SelectVoice('Microsoft Ravi')
          $tts.Rate = 0
          $tts.SetOutputToWaveFile('{WORK}\\' + $p.Name + '.wav')
          $tts.Speak($p.Value)
          $tts.Dispose()
        }}
    """), encoding="utf-8-sig")
    subprocess.run(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps)], check=True)
    durations = {}
    for sid, _, _ in SCENES:
        with wave.open(str(WORK / f"{sid}.wav")) as w:
            durations[sid] = w.getnframes() / w.getframerate()
    return durations

# --------------------------------------------------------------------------- #
# 2. Recording helpers
# --------------------------------------------------------------------------- #

CURSOR_JS = """(() => {
  let c = document.getElementById('__pa_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__pa_cursor';
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:26px;height:26px;margin:-13px 0 0 -13px;' +
      'border-radius:50%;background:rgba(47,107,255,.28);border:2.5px solid #2f6bff;z-index:2147483647;' +
      'pointer-events:none;transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1);' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25)';
    document.documentElement.append(c);
  }
  return true;
})()"""


def cursor_to(page, x: float, y: float) -> None:
    page.evaluate(CURSOR_JS)
    page.evaluate(f"(() => {{ const c = document.getElementById('__pa_cursor'); c.style.left = '{x}px'; c.style.top = '{y}px'; }})()")
    page.wait_for_timeout(600)


def pulse(page) -> None:
    page.evaluate("""document.getElementById('__pa_cursor').animate(
        [{transform:'scale(1)'},{transform:'scale(.6)'},{transform:'scale(1.25)'},{transform:'scale(1)'}],
        {duration: 380})""")


def click(page, selector: str) -> None:
    box = page.locator(selector).first.bounding_box()
    cursor_to(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pulse(page)
    page.locator(selector).first.click()
    page.wait_for_timeout(250)


def click_js(page, selector: str) -> None:
    """For panel elements a `details` summary or scroller may cover: move the cursor, click by script."""
    box = page.locator(selector).first.bounding_box()
    if box:
        cursor_to(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        pulse(page)
    page.evaluate(f"document.querySelector({json.dumps(selector)}).click()")
    page.wait_for_timeout(250)


def type_into(page, selector: str, text: str, delay: int = 45) -> None:
    click(page, selector)
    page.locator(selector).first.press_sequentially(text, delay=delay)


def show_card(page, html: str) -> None:
    page.set_content(f"""<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{{margin:0;height:100%;font-family:'Segoe UI',system-ui,sans-serif;color:#e8ebf2;
        background:radial-gradient(1200px 700px at 30% 20%,#1b2a4a 0%,#0d1119 60%,#0a0d13 100%)}}
      .wrap{{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 110px;box-sizing:border-box}}
      .kicker{{font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:#7fa8ff;margin-bottom:22px}}
      h1{{font-size:64px;line-height:1.1;margin:0 0 26px;font-weight:700;letter-spacing:-.02em}}
      p{{font-size:28px;line-height:1.5;color:#aab4c8;margin:0;max-width:1100px}}
      .grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:28px;margin-top:40px;max-width:1150px}}
      .tile{{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:28px 32px}}
      .num{{font-size:60px;font-weight:700;color:#fff}} .lab{{font-size:22px;color:#9fb0cc;margin-top:6px}}
      .shield{{width:70px;height:70px;color:#5b9cff;margin-bottom:26px}}
    </style></head><body><div class="wrap">{html}</div></body></html>""")


SHIELD = ('<svg class="shield" viewBox="0 0 24 24" fill="none"><path d="M12 2.5 4.5 5.8v5.9c0 4.6 3.1 8.9 7.5 10 '
          '4.4-1.1 7.5-5.4 7.5-10V5.8L12 2.5Z" stroke="currentColor" stroke-width="1.5"/><path d="M8.6 12.1 11 14.5l4.6-4.6" '
          'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>')


WIPE_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0a0d13;font-family:'Segoe UI',system-ui,sans-serif}
  .stage{position:relative;width:100vw;height:100vh}
  img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:top left}
  .red{clip-path:inset(0 0 0 var(--x));animation:wipe var(--dur) cubic-bezier(.45,0,.2,1) forwards}
  .bar{position:absolute;top:0;bottom:0;width:4px;margin-left:-2px;background:#2f6bff;box-shadow:0 0 18px #2f6bff;
       left:var(--x);animation:bar var(--dur) cubic-bezier(.45,0,.2,1) forwards}
  .tag{position:absolute;top:24px;padding:8px 16px;border-radius:999px;font-size:20px;font-weight:600;color:#fff;
       background:rgba(10,13,19,.78);border:1px solid rgba(255,255,255,.18)}
  .l{left:24px}.r{right:24px;color:#9ec1ff}
  @keyframes wipe{0%{clip-path:inset(0 0 0 100%)}18%{clip-path:inset(0 0 0 100%)}62%{clip-path:inset(0 0 0 0%)}
                  78%{clip-path:inset(0 0 0 0%)}100%{clip-path:inset(0 0 0 50%)}}
  @keyframes bar{0%{left:100%}18%{left:100%}62%{left:0%}78%{left:0%}100%{left:50%}}
</style></head><body><div class="stage" style="--dur:{{DUR}}s;--x:100%">
  <img src="{{ORIG}}"><img class="red" src="{{RED}}"><div class="bar"></div>
  <span class="tag l">What you see</span><span class="tag r">What the AI server gets</span>
</div></body></html>"""


def show_wipe(page, panel, seconds: float) -> None:
    """The comparison, full size: the capture the extension took and the one it would send."""
    orig = panel.evaluate("document.getElementById('preview-original').src")
    red = panel.evaluate("document.getElementById('preview-sanitized').src")
    # Placeholders in braces, which base64 never contains — "RED" and "DUR" do turn up inside
    # a JPEG's base64, and replacing them there corrupted the image in the first cut.
    html = WIPE_HTML.replace("{{DUR}}", f"{seconds:.1f}", 1)
    html = html.replace("{{ORIG}}", orig, 1)
    head, tail = html.split("{{RED}}", 1)  # after ORIG is in: split, never search, the rest
    page.set_content(head + red + tail)


def run_task(panel, task: str, stop_at_sheet: bool = False, timeout: float = 90) -> None:
    """Type a task and run it. With stop_at_sheet, return as soon as the agent asks
    something (the caller answers on camera); otherwise decline anything it asks."""
    turns = panel.evaluate("document.querySelectorAll('#thread .turn').length")
    type_into(panel, "#task", task, delay=35)
    click_js(panel, "#run")
    wait_until(panel, f"document.querySelectorAll('#thread .turn').length > {turns}", 5)
    t0 = time.time()
    while time.time() - t0 < timeout:
        if panel.evaluate("!document.getElementById('confirm').hidden"):
            if stop_at_sheet:
                return
            panel.evaluate("document.getElementById('confirm-no').click()")
        if panel.evaluate("document.getElementById('run').dataset.running === 'false'"):
            report(panel, task)
            return
        time.sleep(0.2)
    panel.evaluate("document.getElementById('run').click()")  # still going: stop it


def report(panel, task: str) -> None:
    """How the run ended, and if the guard blocked it, why: incident types and paths, never values."""
    live = panel.evaluate("document.querySelector('#thread .turn__live')?.textContent ?? ''")
    print(f"    [{task[:40]}] {live}")
    if "blocked" in live.lower():
        print("    guard:", panel.evaluate("document.getElementById('guard-detail').textContent"))
        print("    log:", panel.evaluate("[...document.querySelectorAll('#log li')].slice(0, 4).map(l => l.textContent)"))


# --------------------------------------------------------------------------- #
# 3. Recording
# --------------------------------------------------------------------------- #

def record(durations: dict[str, float]) -> dict:
    marks: dict[str, float] = {}
    videos = WORK / "raw"
    shutil.rmtree(videos, ignore_errors=True)
    stub, stub_url = start_server({}, app="tools.mock_vlm:app", health="/v1/models")
    server, server_url = start_server({"PLANNER_VIEW": "1"})
    evil, evil_url = start_server({"VLM_BASE_URL": f"{stub_url}/v1", "VLM_MODEL": "mock-injected",
                                   "VLM_STRATEGY": "vlm-first", "VLM_IMAGE": "always", "VLM_TIMEOUT": "60"})
    try:
        with serve(ROOT) as base, tempfile.TemporaryDirectory() as profile, sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                profile, headless=False, viewport={"width": PAGE_W, "height": H},
                record_video_dir=str(videos), record_video_size={"width": PAGE_W, "height": H},
                # Side by side, never overlapping: Chrome stops painting a window another one
                # covers, and the page's recording froze behind the panel in the first run. The
                # recording size is the emulated viewport, whatever size the window is.
                args=[f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}",
                      "--window-position=0,0", "--window-size=1000,800",
                      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"])
            t_page = time.monotonic()
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("dialog", lambda d: d.dismiss())
            page.goto(f"{base}/demo-site/kyc.html", wait_until="load")
            tab_id = sw.evaluate("async () => (await chrome.tabs.query({ active: true }))[0].id")
            with ctx.expect_page() as popup:
                sw.evaluate(f"""() => chrome.windows.create({{ url: chrome.runtime.getURL('/sidepanel.html?tab={tab_id}'),
                                  type: 'popup', left: 1010, top: 0, width: 520, height: 800 }})""")
            panel = popup.value
            t_panel = time.monotonic()
            panel.set_viewport_size({"width": PANEL_W, "height": H})
            wait_until(panel, "document.querySelectorAll('#log li').length > 0", 15)
            panel.evaluate(f"document.getElementById('server-url').value = '{server_url}'")

            # Warm up off camera: models loaded, the KYC preview in place, nothing learned.
            panel.evaluate("document.getElementById('analyze').click()")
            time.sleep(0.5)
            wait_until(panel, "document.getElementById('analyze').disabled === false", 90)
            panel.evaluate("document.getElementById('learn-dismiss').click()")
            panel.evaluate("document.getElementById('panel-activity').open = false")
            panel.evaluate("document.getElementById('scroll').scrollTo(0, 0)")
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(1.0)

            def scene(sid: str, act) -> None:
                start = time.monotonic()
                marks[sid] = start - t_page
                act()
                left = durations[sid] + 0.8 - (time.monotonic() - start)
                if left > 0:
                    time.sleep(left)
                print(f"  {sid}: {time.monotonic() - start:.1f} s (narration {durations[sid]:.1f} s)")

            def s_open():
                # The wipe, full size on the left and in the panel's own preview on the right.
                show_wipe(page, panel, 7.0)
                slider = panel.locator("#stage-slider").bounding_box()
                cursor_to(panel, slider["x"] + slider["width"] * 0.55, slider["y"] + slider["height"] / 2)
                for v in list(range(55, 101, 3)) + list(range(100, -1, -3)) + list(range(0, 56, 3)):
                    panel.evaluate(f"""(() => {{ const s = document.getElementById('stage-slider'); s.value = {v};
                        s.dispatchEvent(new Event('input', {{bubbles: true}})); }})()""")
                    x = slider["x"] + slider["width"] * v / 100
                    panel.evaluate(f"document.getElementById('__pa_cursor').style.left = '{x}px'")
                    time.sleep(0.07)

            def s_problem():
                show_card(page, f"""{SHIELD}<div class="kicker">Smart India Hackathon · ISRO</div>
                    <h1>On-device Visual Perception<br>for Light-weight Browser Agents</h1>
                    <p>An AI agent that can see your screen — without your personal data ever leaving your device.</p>""")

            def s_hides():
                page.goto(f"{base}/demo-site/kyc.html", wait_until="load")
                page.wait_for_timeout(400)
                click_js(panel, "#analyze")
                time.sleep(0.4)
                wait_until(panel, "document.getElementById('analyze').disabled === false", 60)
                time.sleep(3.5)
                if panel.evaluate("!document.getElementById('learn').hidden"):
                    click_js(panel, "#learn-dismiss")
                show_wipe(page, panel, 9.0)
                time.sleep(9.5)
                panel.evaluate("document.getElementById('guard').scrollIntoView({behavior: 'smooth', block: 'center'})")
                time.sleep(4)
                panel.evaluate("document.getElementById('ledger').scrollIntoView({behavior: 'smooth', block: 'center'})")

            def s_learns():
                panel.evaluate("document.getElementById('scroll').scrollTo({top: 0, behavior: 'smooth'})")
                page.goto(f"{base}/demo-site/apply.html", wait_until="load")
                page.wait_for_timeout(600)
                for sel, value in FAKE.items():
                    type_into(page, sel, value, delay=18)
                click(page, "#save-draft")
                page.wait_for_timeout(1400)
                # The prompt is a closed shadow root: its Remember button, bottom-right.
                cursor_to(page, PAGE_W - 268, H - 52)
                page.wait_for_timeout(700)
                pulse(page)
                page.mouse.click(PAGE_W - 268, H - 52)
                page.wait_for_timeout(2200)
                panel.evaluate("""(() => { const d = [...document.querySelectorAll('details.disclosure')]
                    .find(x => x.textContent.includes('What PrivAgent knows about you')); d.open = true;
                    d.scrollIntoView({behavior: 'smooth', block: 'start'}); })()""")

            def s_acts():
                panel.evaluate("""(() => { [...document.querySelectorAll('details.disclosure')]
                    .forEach(d => { if (d.textContent.includes('What PrivAgent knows')) d.open = false; });
                    document.getElementById('scroll').scrollTo({top: 0, behavior: 'smooth'}); })()""")
                page.goto(f"{base}/demo-site/apply.html", wait_until="load")
                page.wait_for_timeout(800)
                run_task(panel, "fill this form with my profile and stop before submitting")
                panel.evaluate("document.getElementById('thread').scrollIntoView({behavior: 'smooth', block: 'start'})")

            def s_talks():
                panel.evaluate("document.getElementById('scroll').scrollTo({top: 0, behavior: 'smooth'})")
                time.sleep(0.6)
                run_task(panel, "what is my email on this form?")
                panel.evaluate("document.getElementById('thread').scrollIntoView({behavior: 'smooth', block: 'start'})")

            def s_server():
                page.goto(f"{server_url}/view", wait_until="load")
                page.wait_for_timeout(1500)
                page.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")

            def s_tricked():
                panel.evaluate(f"document.getElementById('server-url').value = '{evil_url}'")
                page.goto(f"{base}/demo-site/search.html", wait_until="load")
                page.wait_for_timeout(2500)
                panel.evaluate("document.getElementById('scroll').scrollTo({top: 0, behavior: 'smooth'})")
                run_task(panel, "Find scholarships for engineering students", stop_at_sheet=True)
                if panel.evaluate("!document.getElementById('confirm').hidden"):
                    time.sleep(max(4.0, durations['tricked'] - 14))  # let the sheet be read
                    click_js(panel, "#confirm-no")
                # A planner built to obey the page may ask again: refuse each time, then stop.
                t0 = time.time()
                while time.time() - t0 < 20 and panel.evaluate("document.getElementById('run').dataset.running === 'true'"):
                    if panel.evaluate("!document.getElementById('confirm').hidden"):
                        panel.evaluate("document.getElementById('confirm-no').click()")
                    time.sleep(0.3)
                if panel.evaluate("document.getElementById('run').dataset.running === 'true'"):
                    panel.evaluate("document.getElementById('run').click()")
                panel.evaluate(f"document.getElementById('server-url').value = '{server_url}'")

            def s_proves():
                show_card(page, f"""<div class="kicker">Measured · one command · real screenshots</div>
                    <h1>Every number is reproducible.</h1>
                    <div class="grid">
                      <div class="tile"><div class="num">1.000</div><div class="lab">PII detection precision (demo pages)</div></div>
                      <div class="tile"><div class="num">0.978</div><div class="lab">PII detection recall (demo pages)</div></div>
                      <div class="tile"><div class="num">0</div><div class="lab">values readable after redaction (OCR leak test)</div></div>
                      <div class="tile"><div class="num">19 / 19</div><div class="lab">agent tasks completed safely</div></div>
                    </div>""")

            def s_close():
                show_card(page, f"""{SHIELD}<h1>PrivAgent</h1>
                    <p>An agent that sees what you see — and keeps what's yours on your device.</p>
                    <p style="margin-top:26px;font-size:22px;color:#7f8aa3">Smart India Hackathon · Problem statement by ISRO ·
                    All data shown is synthetic.</p>""")

            for sid, act in [("open", s_open), ("problem", s_problem), ("hides", s_hides), ("learns", s_learns),
                             ("acts", s_acts), ("talks", s_talks), ("server", s_server), ("tricked", s_tricked),
                             ("proves", s_proves), ("close", s_close)]:
                scene(sid, act)
            marks["end"] = time.monotonic() - t_page

            page_video, panel_video = page.video.path(), panel.video.path()
            ctx.close()
    finally:
        for proc in (server, evil, stub):
            proc.kill()
    return {"marks": marks, "panel_offset": t_panel - t_page,
            "page_video": str(page_video), "panel_video": str(panel_video)}

# --------------------------------------------------------------------------- #
# 4. Subtitles and composition
# --------------------------------------------------------------------------- #

def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def build_srt(marks: dict[str, float], durations: dict[str, float], origin: float) -> str:
    """Each scene's caption, split into sentences, timed by length across its narration."""
    import re
    cues, n = [], 1
    for sid, _, caption in SCENES:
        start, total = marks[sid] - origin + 0.3, durations[sid]
        parts = [p.strip() for p in re.split(r"(?<=[.?!])\s+", caption) if p.strip()]
        chars = sum(len(p) for p in parts)
        t = start
        for part in parts:
            span = total * len(part) / chars
            text = "\n".join(textwrap.wrap(part, 60)[:3])
            cues.append(f"{n}\n{srt_time(t)} --> {srt_time(t + span - 0.05)}\n{text}\n")
            t += span
            n += 1
    return "\n".join(cues)


def compose(rec: dict, durations: dict[str, float], out: Path) -> None:
    marks = rec["marks"]
    origin, end = marks["open"], marks["end"]
    (WORK / "captions.srt").write_text(build_srt(marks, durations, origin), encoding="utf-8")

    inputs = ["-i", rec["page_video"], "-i", rec["panel_video"]]
    audio_filters, labels = [], []
    for i, (sid, _, _) in enumerate(SCENES):
        inputs += ["-i", str(WORK / f"{sid}.wav")]
        delay = int((marks[sid] - origin + 0.3) * 1000)
        audio_filters.append(f"[{i + 2}:a]aresample=48000,adelay=delays={delay}:all=1[a{i}]")
        labels.append(f"[a{i}]")
    offset = rec["panel_offset"]
    style = ("FontName=Segoe UI,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,"
             "BorderStyle=3,Outline=1,Shadow=0,MarginV=22")
    graph = ";".join([
        f"[0:v]fps=30,scale={PAGE_W}:{H},setsar=1[pg]",
        f"[1:v]fps=30,crop={PANEL_W}:{H}:0:0,tpad=start_duration={offset:.3f}:start_mode=clone,setsar=1[pn]",
        "[pg][pn]hstack=inputs=2[stack]",
        f"[stack]trim=start={origin:.3f}:end={end:.3f},setpts=PTS-STARTPTS,subtitles=captions.srt:force_style='{style}'[v]",
        *audio_filters,
        f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,volume=1.6,apad[a]",
    ])
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-t", f"{end - origin:.3f}", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True, cwd=WORK)


def main() -> None:
    print("1. narration")
    durations = narrate()
    print("   " + ", ".join(f"{k} {v:.1f}s" for k, v in durations.items()))
    print("2. recording")
    rec = record(durations)
    (WORK / "recording.json").write_text(json.dumps(rec, indent=2), encoding="utf-8")
    print("3. composing")
    out = ROOT / "PrivAgent-demo.mp4"
    compose(rec, durations, out)
    shutil.copy(WORK / "captions.srt", ROOT / "PrivAgent-demo.srt")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
