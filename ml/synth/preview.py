"""Draw the labels back over the images, as an HTML contact sheet.

    uv run python -m synth.preview --data data/synth --split train --limit 12

A generated dataset is only as good as its labels, and a labelling bug is invisible
in the summary counts — it shows up as a model that trains to a fine mAP and detects
nothing useful. Looking at the boxes is the check. Deliberately HTML rather than
Pillow: no extra dependency, and it renders at any zoom in a real browser.
"""

from __future__ import annotations

import argparse
import html
from pathlib import Path

import yaml

PALETTE = (
    "#3b82f6", "#22c55e", "#ef4444", "#f59e0b",
    "#a855f7", "#06b6d4", "#ec4899", "#84cc16",
)


def build_preview(data_dir: Path, split: str, limit: int) -> str:
    names: dict[int, str] = yaml.safe_load((data_dir / "data.yaml").read_text())["names"]
    image_dir = data_dir / "images" / split
    label_dir = data_dir / "labels" / split

    images = sorted(image_dir.glob("*.jpg"))[:limit]
    cards = []

    for image_path in images:
        label_path = label_dir / f"{image_path.stem}.txt"
        boxes = []
        counts: dict[str, int] = {}

        for line in label_path.read_text().splitlines():
            if not line.strip():
                continue
            index, cx, cy, w, h = line.split()
            index = int(index)
            cx, cy, w, h = float(cx), float(cy), float(w), float(h)
            name = names[index]
            counts[name] = counts.get(name, 0) + 1
            colour = PALETTE[index % len(PALETTE)]
            # Percentages, so the overlay tracks the image at any rendered width.
            boxes.append(
                f'<div class="b" style="left:{(cx - w / 2) * 100:.3f}%;top:{(cy - h / 2) * 100:.3f}%;'
                f'width:{w * 100:.3f}%;height:{h * 100:.3f}%;outline-color:{colour}">'
                f'<span style="background:{colour}">{html.escape(name)}</span></div>'
            )

        legend = " · ".join(f"{k}×{v}" for k, v in sorted(counts.items())) or "no boxes"
        rel = image_path.relative_to(data_dir)
        cards.append(
            f'<figure><figcaption><b>{html.escape(image_path.stem)}</b> — {html.escape(legend)}</figcaption>'
            f'<div class="wrap"><img src="{rel}" alt="" />{"".join(boxes)}</div></figure>'
        )

    return f"""<!doctype html><html><head><meta charset="utf-8" />
<title>Synth labels — {html.escape(split)}</title><style>
body{{background:#0d1117;color:#e6edf3;font:13px system-ui;margin:0;padding:16px}}
h1{{font-size:16px;margin:0 0 12px}}
figure{{margin:0 0 22px}}
figcaption{{margin-bottom:6px;color:#8b949e}}
figcaption b{{color:#e6edf3}}
.wrap{{position:relative;display:inline-block;max-width:100%;border:1px solid #30363d}}
.wrap img{{display:block;max-width:100%;height:auto}}
.b{{position:absolute;outline:2px solid;outline-offset:-1px}}
.b span{{position:absolute;left:0;top:-13px;font:9px ui-monospace,monospace;color:#000;padding:0 3px;white-space:nowrap}}
</style></head><body>
<h1>{html.escape(split)} — {len(images)} images, labels drawn from the YOLO files</h1>
{"".join(cards)}</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/synth"))
    parser.add_argument("--split", default="train")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    out = args.out or (args.data / f"preview-{args.split}.html")
    out.write_text(build_preview(args.data, args.split, args.limit))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
