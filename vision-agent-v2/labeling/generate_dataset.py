"""
Auto-labeling pipeline for the on-device UI-element detector (SIH26171).

Idea: the ORIGINAL extension found elements via DOM queries
(buttons/inputs/links/etc via document.querySelectorAll). That approach is
wrong as a RUNTIME mechanism (it's not "visual perception"), but it's a
great OFFLINE LABELING TOOL: point it at real rendered pages, and it hands
us exact pixel bounding boxes + element type for free, with zero manual
annotation.

Output per page visited:
    dataset/images/<page_id>.png        - full-page screenshot
    dataset/labels/<page_id>.json       - list of {class, bbox: [x,y,w,h]}
    dataset/labels/<page_id>.txt        - same boxes in YOLO txt format

Run:
    python3 generate_dataset.py --urls urls.txt --out dataset/
"""
import argparse
import asyncio
import json
import re
import hashlib
from pathlib import Path

from playwright.async_api import async_playwright

# Same 4 classes we'll train the on-device detector to find directly from
# pixels. Kept small on purpose -- fewer classes = easier to get a small
# ONNX model converging well in limited fine-tuning time.
CLASS_NAMES = ["button", "input", "link", "image"]
CLASS_ID = {name: i for i, name in enumerate(CLASS_NAMES)}

# Injected into the page. This IS content.js's buildInteractableSummary(),
# lightly adapted: we don't need the "sensitive" flag or selector/mark
# bookkeeping here, we only need class + bounding box, because the only
# job of this script is to produce (screenshot, boxes) pairs.
EXTRACT_JS = r"""
() => {
  const out = [];

  function pushEl(tag_class, el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;      // skip invisible/degenerate
    if (rect.right < 0 || rect.bottom < 0) return;       // skip fully offscreen
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return;
    if (parseFloat(style.opacity || "1") === 0) return;
    out.push({
      cls: tag_class,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
  }

  document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")
    .forEach((el) => pushEl("button", el));

  document.querySelectorAll(
    "input:not([type=submit]):not([type=button]):not([type=hidden]), textarea, select"
  ).forEach((el) => pushEl("input", el));

  document.querySelectorAll("a[href]").forEach((el) => pushEl("link", el));

  document.querySelectorAll("img").forEach((el) => pushEl("image", el));

  return out;
}
"""


def slug_for(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:12]


async def label_one(page, url: str, out_dir: Path):
    page_id = slug_for(url)
    img_path = out_dir / "images" / f"{page_id}.png"
    json_path = out_dir / "labels" / f"{page_id}.json"
    yolo_path = out_dir / "labels" / f"{page_id}.txt"

    try:
        await page.goto(url, timeout=15000, wait_until="networkidle")
    except Exception as e:
        print(f"  [skip] {url}: {e}")
        return None

    # Let any lazy-loaded content/fonts settle before we screenshot+scan,
    # so the pixel image and the DOM rects actually agree with each other.
    await page.wait_for_timeout(500)

    viewport = page.viewport_size
    boxes = await page.evaluate(EXTRACT_JS)
    # Clip boxes to the viewport since we're taking a viewport screenshot,
    # not a full-page one (full-page screenshots and getBoundingClientRect
    # coordinates disagree once you scroll, which would silently corrupt
    # every label -- viewport-only keeps screenshot pixels and box
    # coordinates in the same coordinate frame).
    clipped = []
    for b in boxes:
        x0, y0 = max(b["x"], 0), max(b["y"], 0)
        x1, y1 = min(b["x"] + b["w"], viewport["width"]), min(b["y"] + b["h"], viewport["height"])
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        clipped.append({"cls": b["cls"], "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0})

    if not clipped:
        print(f"  [skip] {url}: no labelable elements found")
        return None

    await page.screenshot(path=str(img_path))

    json_path.write_text(json.dumps({"url": url, "viewport": viewport, "boxes": clipped}, indent=2))

    # YOLO format: class_id cx cy w h, all normalized 0-1
    lines = []
    for b in clipped:
        cx = (b["x"] + b["w"] / 2) / viewport["width"]
        cy = (b["y"] + b["h"] / 2) / viewport["height"]
        nw = b["w"] / viewport["width"]
        nh = b["h"] / viewport["height"]
        lines.append(f"{CLASS_ID[b['cls']]} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
    yolo_path.write_text("\n".join(lines))

    print(f"  [ok]   {url}: {len(clipped)} boxes")
    return page_id


async def main(urls, out_dir: Path, viewport):
    (out_dir / "images").mkdir(parents=True, exist_ok=True)
    (out_dir / "labels").mkdir(parents=True, exist_ok=True)

    ids = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport=viewport)
        for url in urls:
            pid = await label_one(page, url, out_dir)
            if pid:
                ids.append(pid)
        await browser.close()

    (out_dir / "classes.txt").write_text("\n".join(CLASS_NAMES))
    (out_dir / "manifest.txt").write_text("\n".join(ids))
    print(f"\nDataset written to {out_dir} -- {len(ids)} labeled pages, classes={CLASS_NAMES}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", required=True, help="text file, one URL per line, or a single URL/local file:// path")
    ap.add_argument("--out", default="dataset")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=800)
    args = ap.parse_args()

    urls_path = Path(args.urls)
    if urls_path.exists():
        url_list = [l.strip() for l in urls_path.read_text().splitlines() if l.strip() and not l.startswith("#")]
    else:
        url_list = [args.urls]

    asyncio.run(main(url_list, Path(args.out), {"width": args.width, "height": args.height}))
