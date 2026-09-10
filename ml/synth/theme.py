"""Randomised page styling.

Layout variation is what stops the detector memorising one look. A model trained on
a single stylesheet learns "an input is a 36 px box with a 1 px #d6dde8 border",
which is true of exactly one website.

Every knob here is something real sites genuinely differ on: font stack, density,
border radius, whether inputs are outlined or filled, light vs dark, and the
overall page width.
"""

from __future__ import annotations

import random

FONT_STACKS = (
    '"Segoe UI", Roboto, system-ui, sans-serif',
    'system-ui, -apple-system, "Helvetica Neue", sans-serif',
    'Verdana, Geneva, sans-serif',
    '"Trebuchet MS", Tahoma, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", ui-monospace, monospace',
    'Arial, Helvetica, sans-serif',
)

LIGHT_PALETTES = (
    ("#f6f8fa", "#ffffff", "#1f2328", "#636c76", "#d8dee4", "#1a3a6b"),
    ("#eef2f7", "#ffffff", "#14213d", "#5a6b8c", "#d6dde8", "#1d4ed8"),
    ("#fdfaf6", "#ffffff", "#3b2f2f", "#7c6f6f", "#e7ded4", "#9a3412"),
    ("#f4f7f4", "#ffffff", "#14251b", "#5d6f63", "#d7e2d9", "#047857"),
)

DARK_PALETTES = (
    ("#0d1117", "#161b22", "#e6edf3", "#8b949e", "#30363d", "#58a6ff"),
    ("#111827", "#1f2937", "#f9fafb", "#9ca3af", "#374151", "#818cf8"),
    ("#1a1625", "#241f35", "#ede9fe", "#a8a0c0", "#3b3450", "#c084fc"),
)


def build_theme(rng: random.Random) -> tuple[str, bool]:
    """Return (css, is_dark)."""
    dark = rng.random() < 0.3
    bg, panel, ink, muted, line, accent = rng.choice(DARK_PALETTES if dark else LIGHT_PALETTES)

    font = rng.choice(FONT_STACKS)
    base = rng.choice((13, 14, 15, 16))
    radius = rng.choice((0, 2, 4, 6, 10))
    pad = rng.choice((10, 14, 18, 24))
    gap = rng.choice((8, 12, 16, 22))
    width = rng.choice((720, 860, 980, 1120))
    filled = rng.random() < 0.4
    input_bg = panel if not filled else (line if dark else "#eef1f5")
    input_border = "transparent" if filled else line
    columns = rng.choice((1, 2, 2, 3))
    shadow = "0 1px 3px rgba(0,0,0,.08)" if not dark and rng.random() < 0.6 else "none"

    return (
        f"""
*{{box-sizing:border-box}}
body{{margin:0;background:{bg};color:{ink};font:{base}px/{rng.choice((1.4,1.5,1.6))} {font}}}
main{{max-width:{width}px;margin:0 auto;padding:{pad}px;display:flex;flex-direction:column;gap:{gap}px}}
.hdr{{display:flex;align-items:center;gap:16px;background:{accent};color:#fff;padding:{max(8,pad-4)}px {pad}px}}
.hdr .brand{{font-weight:700;font-size:{base+2}px}}
.hdr nav{{display:flex;gap:14px;margin-left:auto}}
.hdr nav a{{color:#ffffffd0;text-decoration:none;font-size:{base-1}px}}
.card{{background:{panel};border:1px solid {line};border-radius:{radius}px;padding:{pad}px;box-shadow:{shadow}}}
.card h2{{margin:0 0 {gap//2}px;font-size:{base+2}px;color:{accent if not dark else ink}}}
.grid{{display:grid;grid-template-columns:repeat({columns},1fr);gap:{gap//2}px {gap}px}}
.f{{display:block}}
.lbl{{display:block;font-size:{base-2}px;color:{muted};margin-bottom:3px;font-weight:600}}
input{{width:100%;padding:{rng.choice((6,8,10))}px {rng.choice((8,10,12))}px;border:1px solid {input_border};
 border-radius:{max(0,radius-2)}px;background:{input_bg};color:{ink};font:inherit}}
.btn{{display:inline-block;padding:{rng.choice((7,9,11))}px {rng.choice((12,16,20))}px;border:1px solid {line};
 border-radius:{max(0,radius-2)}px;background:{panel};color:{ink};font:inherit;font-weight:600;cursor:pointer;text-decoration:none}}
.btn.primary{{background:{accent};border-color:{accent};color:#fff}}
.actions{{display:flex;gap:{gap//2}px;margin-top:{gap}px;flex-wrap:wrap}}
.split{{display:flex;gap:{gap}px;align-items:flex-start}}
.rows{{flex:1;display:flex;flex-direction:column;gap:{max(2,gap//3)}px}}
.row{{display:flex;gap:{gap}px;padding:{max(2,gap//4)}px 0;border-bottom:1px solid {line}22}}
.row .k{{color:{muted};min-width:120px}}
.row .v{{font-weight:600}}
.avatar{{width:{rng.choice((72,96,120))}px;height:{rng.choice((72,96,120))}px;border-radius:{rng.choice((4,8,50))}%;object-fit:cover}}
.avatar-sm{{width:{rng.choice((28,32,40))}px;height:{rng.choice((28,32,40))}px;border-radius:50%}}
table{{width:100%;border-collapse:collapse;font-size:{base-1}px}}
th,td{{text-align:left;padding:{rng.choice((5,7,9))}px;border-bottom:1px solid {line}}}
th{{color:{muted};font-size:{base-3}px;text-transform:uppercase;letter-spacing:.04em}}
.muted{{color:{muted};font-size:{base-2}px}}
.chat{{display:flex;flex-direction:column;gap:{max(4,gap//2)}px}}
.msg{{display:flex;gap:8px;align-items:flex-end}}
.msg.me{{flex-direction:row-reverse}}
.bubble{{padding:{rng.choice((6,8,10))}px {rng.choice((10,12,14))}px;border-radius:{rng.choice((6,12,18))}px;
 background:{input_bg};max-width:70%}}
.msg.me .bubble{{background:{accent};color:#fff}}
.doc,.qr,.sig{{display:block;height:auto;border-radius:{max(0,radius-2)}px}}
.tiles{{display:grid;grid-template-columns:repeat({rng.choice((2,3,4))},1fr);gap:{gap}px}}
.tile{{border:1px solid {line};border-radius:{radius}px;padding:{max(6,pad//2)}px;text-align:center}}
.thumb{{height:{rng.choice((60,80,100))}px;background:{input_bg};border-radius:{max(0,radius-2)}px;margin-bottom:6px}}
.tile .p{{font-weight:700}}
.tile .sku{{color:{muted};font-size:{base-3}px;margin-bottom:6px}}
.stats{{display:flex;gap:{gap}px;margin-top:{gap}px}}
.stat{{flex:1;text-align:center;padding:{max(6,pad//2)}px;background:{input_bg};border-radius:{max(0,radius-2)}px}}
.stat b{{display:block;font-size:{base+4}px}}
.stat small{{color:{muted}}}
canvas{{display:block;border:1px solid {line};border-radius:{radius}px}}
""",
        dark,
    )
