"""Image assets, generated as SVG data URIs.

These are the whole point of the vision layer, so they are built the way the real
things appear: as `<img>` content, where the text inside them is invisible to any
DOM inspection. If these were inline `<svg>` elements the DOM layer would read them
and the model would have nothing left to learn.
"""

from __future__ import annotations

import base64
import random
from urllib.parse import quote


def _data_uri(svg: str) -> str:
    # utf8 percent-encoding keeps the markup readable in the generated HTML, which
    # matters when a generated page has to be debugged by eye.
    return "data:image/svg+xml;charset=utf-8," + quote(svg, safe="")


def _b64_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


_CARD_PALETTES = (
    ("#1e3a8a", "#3b82f6", "#eff6ff"),
    ("#065f46", "#10b981", "#ecfdf5"),
    ("#7c2d12", "#f97316", "#fff7ed"),
    ("#4c1d95", "#8b5cf6", "#f5f3ff"),
    ("#0f172a", "#475569", "#f8fafc"),
    ("#831843", "#ec4899", "#fdf2f8"),
)

_ID_PALETTES = (
    ("#c2410c", "#fdfbf4", "#111827"),
    ("#1d4ed8", "#f8fafc", "#0f172a"),
    ("#047857", "#f0fdf4", "#052e16"),
    ("#6d28d9", "#faf5ff", "#1e1b4b"),
)


def payment_card_svg(rng: random.Random, number: str, name: str, expiry: str) -> str:
    """A rendered debit/credit card. Number and name are pixels, not text nodes."""
    dark, light, ink = rng.choice(_CARD_PALETTES)
    w, h = 420, 264
    font = rng.choice(("Helvetica, Arial, sans-serif", "Verdana, sans-serif", "Tahoma, sans-serif"))
    spacing = rng.choice((2, 3, 4))
    stripe = (
        f'<rect x="0" y="{rng.randint(150, 190)}" width="{w}" height="{rng.randint(20, 34)}" fill="#00000022"/>'
        if rng.random() < 0.5
        else ""
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{dark}"/><stop offset="1" stop-color="{light}"/></linearGradient></defs>
<rect width="{w}" height="{h}" rx="18" fill="url(#g)"/>{stripe}
<rect x="34" y="66" width="52" height="40" rx="6" fill="#e8c766"/>
<path d="M34 86h52M60 66v40" stroke="#00000033" stroke-width="2"/>
<text x="34" y="{rng.randint(158, 172)}" font-family="{font}" font-size="25"
 letter-spacing="{spacing}" fill="{light if rng.random() < 0.3 else '#ffffff'}" font-weight="600">{number}</text>
<text x="34" y="215" font-family="{font}" font-size="13" fill="#ffffffcc">CARD HOLDER</text>
<text x="34" y="235" font-family="{font}" font-size="16" fill="#fff">{name.upper()}</text>
<text x="300" y="215" font-family="{font}" font-size="13" fill="#ffffffcc">VALID THRU</text>
<text x="300" y="235" font-family="{font}" font-size="16" fill="#fff">{expiry}</text>
<circle cx="{w-70}" cy="60" r="26" fill="#ffffff55"/><circle cx="{w-46}" cy="60" r="26" fill="#ffffff33"/>
</svg>"""
    return _data_uri(svg)


def id_document_svg(rng: random.Random, name: str, number: str, dob: str) -> str:
    """A government-ID-shaped card. SPECIMEN, always."""
    band, paper, ink = rng.choice(_ID_PALETTES)
    w, h = 480, 302
    font = rng.choice(("Helvetica, Arial, sans-serif", "Georgia, serif", "Verdana, sans-serif"))
    label = rng.choice(("GOVERNMENT OF INDIA", "IDENTITY CARD", "NATIONAL ID", "RESIDENT CARD"))
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
<rect width="{w}" height="{h}" rx="12" fill="{paper}" stroke="#c9b99b" stroke-width="2"/>
<rect width="{w}" height="52" rx="12" fill="{band}"/><rect y="40" width="{w}" height="12" fill="{band}"/>
<text x="20" y="33" font-family="{font}" font-size="18" fill="#fff" font-weight="bold">{label}</text>
<text x="{w-110}" y="33" font-family="{font}" font-size="12" fill="#ffffffcc">SPECIMEN</text>
<rect x="20" y="72" width="104" height="126" fill="#dbe7f5" stroke="#b6c6dc"/>
<ellipse cx="72" cy="120" rx="26" ry="30" fill="#e7d3c2"/>
<path d="M32 198c0-24 18-38 40-38s40 14 40 38z" fill="#2f4a72"/>
<g font-family="{font}" fill="{ink}">
<text x="144" y="88" font-size="13" fill="#6b7280">Name</text>
<text x="144" y="108" font-size="19" font-weight="bold">{name}</text>
<text x="144" y="136" font-size="13" fill="#6b7280">Date of Birth</text>
<text x="144" y="156" font-size="17">{dob}</text></g>
<rect x="20" y="222" width="440" height="58" rx="6" fill="#ffffffaa" stroke="#e7cba9"/>
<text x="40" y="252" font-family="Courier New, monospace" font-size="{rng.randint(24, 28)}"
 letter-spacing="{rng.randint(3, 6)}" fill="#111827" font-weight="bold">{number}</text>
<text x="40" y="271" font-family="{font}" font-size="11" fill="#92400e">SPECIMEN — NOT A VALID DOCUMENT</text>
</svg>"""
    return _b64_uri(svg)


def qr_svg(rng: random.Random) -> str:
    """
    A QR-shaped image. Not a decodable QR code — the detector is learning the visual
    signature (three finder squares, a dense module grid), and generating scannable
    codes would mean shipping an encoder for no gain.
    """
    modules = rng.choice((21, 25, 29))
    cell = 8
    size = modules * cell
    rects = []
    for y in range(modules):
        for x in range(modules):
            in_finder = (x < 7 and y < 7) or (x >= modules - 7 and y < 7) or (x < 7 and y >= modules - 7)
            if in_finder:
                continue
            if rng.random() < 0.45:
                rects.append(f'<rect x="{x*cell}" y="{y*cell}" width="{cell}" height="{cell}"/>')

    def finder(fx: int, fy: int) -> str:
        return (
            f'<rect x="{fx*cell}" y="{fy*cell}" width="{7*cell}" height="{7*cell}"/>'
            f'<rect x="{(fx+1)*cell}" y="{(fy+1)*cell}" width="{5*cell}" height="{5*cell}" fill="#fff"/>'
            f'<rect x="{(fx+2)*cell}" y="{(fy+2)*cell}" width="{3*cell}" height="{3*cell}"/>'
        )

    body = "".join(rects) + finder(0, 0) + finder(modules - 7, 0) + finder(0, modules - 7)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
        f'<rect width="{size}" height="{size}" fill="#fff"/><g fill="#000">{body}</g></svg>'
    )
    return _b64_uri(svg)


def signature_svg(rng: random.Random) -> str:
    """A handwritten-looking squiggle."""
    w, h = 300, 90
    x, y = 12, h * 0.6
    parts = [f"M{x:.0f},{y:.0f}"]
    for _ in range(rng.randint(4, 8)):
        cx1, cy1 = x + rng.randint(10, 40), y - rng.randint(10, 45)
        cx2, cy2 = x + rng.randint(20, 60), y + rng.randint(-30, 25)
        x, y = x + rng.randint(30, 60), h * 0.6 + rng.randint(-12, 12)
        parts.append(f"C{cx1:.0f},{cy1:.0f} {cx2:.0f},{cy2:.0f} {x:.0f},{y:.0f}")
    ink = rng.choice(("#111827", "#1e3a8a", "#374151"))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f'<path d="{" ".join(parts)}" stroke="{ink}" stroke-width="{rng.choice((2, 2.5, 3))}" '
        f'fill="none" stroke-linecap="round"/></svg>'
    )
    return _data_uri(svg)


def avatar_svg(rng: random.Random) -> str:
    """
    An illustrated avatar. Present so the *layout* looks real; it carries no
    `data-pii="FACE"` annotation, because this detector has no face class and a
    drawing is not a face (see classes.py).
    """
    hue = rng.randint(0, 359)
    skin = rng.choice(("#e7d3c2", "#c68642", "#8d5524", "#f1c27d", "#4b2e1e"))
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
<rect width="120" height="120" fill="hsl({hue},45%,82%)"/>
<circle cx="60" cy="46" r="26" fill="{skin}"/>
<path d="M14 120c0-28 20-42 46-42s46 14 46 42z" fill="hsl({hue},40%,42%)"/>
<path d="M34 44c0-20 11-30 26-30s26 10 26 30c0-6-3-14-9-16-8 5-27 6-34-1-5 4-9 11-9 17z" fill="#2b2320"/>
</svg>"""
    return _data_uri(svg)
