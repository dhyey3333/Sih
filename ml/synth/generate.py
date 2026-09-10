"""Generate the synthetic detection dataset.

    uv run python -m synth.generate --out data/synth --per-recipe 40

Renders each recipe across viewports, device pixel ratios and scroll positions, and
writes YOLO-format labels read straight out of the rendered DOM — no manual
annotation, and labels that cannot disagree with the extension's own ground truth
because they come from the same `data-pii` attribute.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path

import yaml
from faker import Faker
from playwright.sync_api import sync_playwright

from .classes import CLASS_INDEX, DETECTOR_CLASSES, class_for_pii, class_for_ui
from .page import build_page
from .recipes import Recipe, split_recipes

#: Real-world-ish viewports. The model has to cope with a laptop and a large monitor.
VIEWPORTS = ((1366, 768), (1440, 900), (1920, 1080), (1280, 800), (1536, 864))
DEVICE_SCALES = (1, 1, 2)  # DPR 1 is more common in the wild; weight it accordingly

_EXTRACT_JS = (Path(__file__).parent / "extract.js").read_text()


@dataclass
class Sample:
    split: str
    recipe: str
    index: int

    @property
    def stem(self) -> str:
        return f"{self.recipe}_{self.index:05d}"


def label_index(kind: str, value: str) -> int | None:
    """Map an extracted annotation onto a detector class index."""
    if kind == "pii":
        name = class_for_pii(value)
    elif kind == "ui":
        name = class_for_ui(value)
    else:  # canvas labels already carry the class name
        name = value
    return CLASS_INDEX.get(name) if name else None


def to_yolo(boxes: list[dict], width: int, height: int, scale: float) -> list[str]:
    """CSS-pixel boxes → normalised YOLO lines, in screenshot pixel space."""
    lines: list[str] = []
    for box in boxes:
        index = label_index(box["kind"], box["value"])
        if index is None:
            continue

        x = box["x"] * scale
        y = box["y"] * scale
        w = box["w"] * scale
        h = box["h"] * scale
        if w < 3 or h < 3:
            continue

        cx = (x + w / 2) / width
        cy = (y + h / 2) / height
        nw = w / width
        nh = h / height
        if not (0 <= cx <= 1 and 0 <= cy <= 1) or nw <= 0 or nh <= 0:
            continue
        lines.append(f"{index} {cx:.6f} {cy:.6f} {min(nw, 1):.6f} {min(nh, 1):.6f}")
    return lines


def generate(out_dir: Path, per_recipe: int, seed: int, headless: bool = True) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    splits = split_recipes()
    faker = Faker("en_IN")

    counts = {split: 0 for split in splits}
    class_counts = {name: 0 for name in DETECTOR_CLASSES}
    empty_images = 0

    for split in splits:
        (out_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)

        for split, recipes in splits.items():
            for recipe in recipes:
                for i in range(per_recipe):
                    # Seeded per sample: any single image can be reproduced exactly,
                    # which matters when one of them turns out to be mislabelled.
                    rng = random.Random(f"{seed}:{recipe.name}:{i}")
                    faker.seed_instance(rng.randint(0, 2**31))

                    viewport = rng.choice(VIEWPORTS)
                    scale = rng.choice(DEVICE_SCALES)
                    context = browser.new_context(
                        viewport={"width": viewport[0], "height": viewport[1]},
                        device_scale_factor=scale,
                        color_scheme=rng.choice(("light", "dark")),
                        reduced_motion="reduce",
                    )
                    page = context.new_page()
                    try:
                        page.set_content(build_page(recipe, rng, faker), wait_until="load")
                        # Let fonts settle before measuring: text boxes measured
                        # against a fallback font would be systematically wrong.
                        page.evaluate("document.fonts ? document.fonts.ready : true")

                        if rng.random() < 0.35:
                            page.evaluate(f"window.scrollTo(0, {rng.randint(50, 700)})")
                            page.wait_for_timeout(30)

                        boxes = page.evaluate(_EXTRACT_JS)
                        sample = Sample(split, recipe.name, i)
                        image_path = out_dir / "images" / split / f"{sample.stem}.jpg"
                        page.screenshot(path=str(image_path), type="jpeg", quality=85)

                        width = round(viewport[0] * scale)
                        height = round(viewport[1] * scale)
                        lines = to_yolo(boxes, width, height, scale)
                        (out_dir / "labels" / split / f"{sample.stem}.txt").write_text(
                            "\n".join(lines) + ("\n" if lines else "")
                        )

                        counts[split] += 1
                        if not lines:
                            empty_images += 1
                        for line in lines:
                            class_counts[DETECTOR_CLASSES[int(line.split()[0])]] += 1
                    finally:
                        context.close()

        browser.close()

    data_yaml = {
        "path": str(out_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {i: name for i, name in enumerate(DETECTOR_CLASSES)},
    }
    (out_dir / "data.yaml").write_text(yaml.safe_dump(data_yaml, sort_keys=False))

    summary = {
        "images": counts,
        "boxes_per_class": class_counts,
        "images_with_no_boxes": empty_images,
        "recipes": {split: [r.name for r in rs] for split, rs in splits.items()},
        "seed": seed,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("data/synth"))
    parser.add_argument("--per-recipe", type=int, default=40, help="images per recipe")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--headed", action="store_true", help="watch the browser render")
    args = parser.parse_args()

    summary = generate(args.out, args.per_recipe, args.seed, headless=not args.headed)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
