"""Canvas-rendered UI.

This is the case the whole detector exists for. A `<canvas>` app — a chart tool, a
map, a PDF viewer, a Flutter or Unity build — puts its entire interface into pixels.
`document.querySelectorAll` returns nothing useful, the accessible name of every
control is empty, and the DOM privacy layer, which is otherwise the best thing we
have, is completely blind.

So we draw forms and detail panels into a canvas, and emit labels from the *drawing*
coordinates rather than from the DOM. The layout plan is built in Python so it stays
reproducible from the seed; the JavaScript only paints it and records where each box
landed relative to the canvas element.
"""

from __future__ import annotations

import json
import random

from .person import Person


def canvas_app(rng: random.Random, p: Person) -> str:
    """A form drawn entirely into a canvas. Invisible to the DOM, by construction."""
    width = rng.choice((520, 620, 720))
    row_h = rng.choice((52, 60, 68))
    pad = rng.choice((18, 24, 30))

    candidates: list[tuple[str, str, str | None]] = [
        ("Full name", p.name, "pii_text"),
        ("Email", p.email, "pii_text"),
        ("Mobile", p.phone, "pii_text"),
        ("Aadhaar", p.aadhaar, "pii_text"),
        ("PAN", p.pan, "pii_text"),
        ("Account", p.account, "pii_text"),
        ("IFSC", p.ifsc, "pii_text"),
        ("Password", "•" * rng.randint(8, 12), "password_field"),
        ("Reference", rng.choice(p.decoys), None),
        ("Amount", rng.choice(p.decoys), None),
        ("Quantity", str(rng.randint(1, 99)), None),
    ]
    rows = rng.sample(candidates, k=rng.randint(4, 7))

    height = pad * 2 + 44 + len(rows) * row_h + 60
    dark = rng.random() < 0.35
    plan = {
        "width": width,
        "height": height,
        "pad": pad,
        "rowH": row_h,
        "title": rng.choice(("Account details", "Verification", "Profile", "Transfer")),
        "dark": dark,
        "font": rng.choice(("system-ui", "Verdana", "Georgia", "Tahoma", "Arial")),
        "fontSize": rng.choice((13, 14, 15)),
        "radius": rng.choice((0, 4, 8)),
        "filled": rng.random() < 0.5,
        "rows": [{"label": label, "value": value, "cls": cls} for label, value, cls in rows],
        "buttons": [
            {"text": rng.choice(("Save", "Submit", "Continue", "Verify")), "primary": True},
            {"text": rng.choice(("Cancel", "Back", "Reset")), "primary": False},
        ],
    }

    canvas_id = f"cv{rng.randint(1000, 9999)}"
    return f"""<section class="card"><h2>Interactive view</h2>
<canvas id="{canvas_id}" width="{width}" height="{height}" style="width:{width}px;height:{height}px"></canvas>
<script>(function(){{
{_DRAW_JS}
drawSynthApp({json.dumps(canvas_id)}, {json.dumps(plan)});
}})();</script></section>"""


#: Kept as one string rather than a template so the JS stays readable and lintable.
_DRAW_JS = r"""
function drawSynthApp(id, plan) {
  var cv = document.getElementById(id);
  var ctx = cv.getContext('2d');
  var W = plan.width, H = plan.height, pad = plan.pad;

  var bg    = plan.dark ? '#12161f' : '#ffffff';
  var ink   = plan.dark ? '#e6edf3' : '#1f2328';
  var muted = plan.dark ? '#8b949e' : '#6b7280';
  var line  = plan.dark ? '#30363d' : '#d8dee4';
  var fill  = plan.filled ? (plan.dark ? '#1c222c' : '#eef1f5') : bg;
  var accent = plan.dark ? '#58a6ff' : '#1d4ed8';

  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  // Labels are recorded relative to the canvas; the extractor adds its page offset.
  window.__synthLabels = window.__synthLabels || [];
  function record(cls, x, y, w, h) {
    window.__synthLabels.push({ canvasId: id, cls: cls, x: x, y: y, w: w, h: h });
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.closePath();
  }

  ctx.fillStyle = ink;
  ctx.font = '600 ' + (plan.fontSize + 4) + 'px ' + plan.font;
  ctx.fillText(plan.title, pad, pad + 12);

  var y = pad + 44;
  var labelW = Math.round(W * 0.34);
  var boxX = pad + labelW;
  var boxW = W - boxX - pad;

  plan.rows.forEach(function (row) {
    var boxH = plan.rowH - 16;

    ctx.fillStyle = muted;
    ctx.font = plan.fontSize + 'px ' + plan.font;
    ctx.fillText(row.label, pad, y + boxH / 2);

    ctx.fillStyle = fill;
    roundRect(boxX, y, boxW, boxH, plan.radius); ctx.fill();
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    roundRect(boxX + 0.5, y + 0.5, boxW - 1, boxH - 1, plan.radius); ctx.stroke();

    // Every box is an input the agent may need to act on, whatever it holds.
    record(row.cls === 'password_field' ? 'password_field' : 'text_input', boxX, y, boxW, boxH);

    ctx.save();
    roundRect(boxX, y, boxW, boxH, plan.radius); ctx.clip();
    ctx.fillStyle = ink;
    ctx.font = plan.fontSize + 'px ' + plan.font;
    var textX = boxX + 10;
    ctx.fillText(row.value, textX, y + boxH / 2);
    var textW = Math.min(ctx.measureText(row.value).width, boxW - 20);
    ctx.restore();

    // A pii_text box hugs the glyphs, not the input: that is what has to be painted
    // over, and a box the size of the whole field would overstate the redaction.
    if (row.cls === 'pii_text' && textW > 4) {
      var th = plan.fontSize + 6;
      record('pii_text', textX - 2, y + boxH / 2 - th / 2, textW + 4, th);
    }
    y += plan.rowH;
  });

  var bx = pad;
  plan.buttons.forEach(function (b) {
    ctx.font = '600 ' + plan.fontSize + 'px ' + plan.font;
    var bw = Math.round(ctx.measureText(b.text).width) + 34;
    var bh = plan.fontSize + 22;
    ctx.fillStyle = b.primary ? accent : fill;
    roundRect(bx, y, bw, bh, plan.radius); ctx.fill();
    if (!b.primary) { ctx.strokeStyle = line; roundRect(bx + 0.5, y + 0.5, bw - 1, bh - 1, plan.radius); ctx.stroke(); }
    ctx.fillStyle = b.primary ? '#ffffff' : ink;
    ctx.fillText(b.text, bx + 17, y + bh / 2);
    record('button', bx, y, bw, bh);
    bx += bw + 12;
  });
}
"""
