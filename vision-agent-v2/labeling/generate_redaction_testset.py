"""
Generates a small labeled test set for benchmarking the OCR-based
redaction layer (extension/ocr-redactor.js), the same way
generate_dataset.py generates labels for the UI-element detector.

Each test case is a single rendered line of text ("Card Number: 4111
1111 1111 1111") with a KNOWN ground-truth pixel bounding box (computed
directly from the font metrics used to draw it, not estimated) and a
sensitive: true/false label. training/benchmark_redaction.mjs runs the
real OCR + regex classifier against these images and checks whether the
regions it produces actually cover the ground-truth box, giving real
precision/recall numbers instead of eyeballing a handful of screenshots.

Cases are deliberately mixed: sensitive fields the classifier SHOULD
catch (card number, Aadhaar, CVV+value, PIN+value, a plaintext-revealed
password), and non-sensitive fields it should leave alone (name, email,
phone, order ID, address, zip, a generic paragraph) - false positives on
the second group matter just as much as false negatives on the first for
an honest benchmark.
"""

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

CASES = [
    # (text, sensitive)
    ("Card Number: 4111 1111 1111 1111", True),
    ("Visa ending in 4000 1234 5678 9010", True),
    ("Aadhaar Number 1234 5678 9012", True),
    ("CVV 823", True),
    ("Security Code: 047", True),
    ("PIN 4821", True),
    ("Password: hunter2fallback", True),
    ("New Password mySecret99", True),
    ("Full Name: John Doe", False),
    ("Email: john.doe@example.com", False),
    ("Phone +91 98765 43210", False),
    ("Order ID 20260910-4471", False),
    ("Shipping Address 221B Baker Street", False),
    ("Zip Code 560001", False),
    ("Please review your details before submitting", False),
    ("Total Amount Rs 2999.00", False),
]


def load_font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="redaction_testset")
    parser.add_argument("--font-size", type=int, default=28)
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    font = load_font(args.font_size)
    manifest = []

    for i, (text, sensitive) in enumerate(CASES):
        pad = 20
        # Measure real text size from the font itself so the ground-truth
        # box is exact, not guessed.
        tmp = Image.new("RGB", (10, 10))
        d = ImageDraw.Draw(tmp)
        bbox = d.textbbox((0, 0), text, font=font)
        text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]

        img_w, img_h = text_w + pad * 2, text_h + pad * 2
        img = Image.new("RGB", (img_w, img_h), "white")
        d = ImageDraw.Draw(img)
        draw_pos = (pad - bbox[0], pad - bbox[1])
        d.text(draw_pos, text, fill="black", font=font)

        gt_box = {
            "x": pad,
            "y": pad,
            "width": text_w,
            "height": text_h,
        }

        filename = f"case_{i:02d}.png"
        img.save(os.path.join(args.out, filename))
        manifest.append(
            {
                "id": i,
                "file": filename,
                "text": text,
                "sensitive": sensitive,
                "gt_box": gt_box,
            }
        )

    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    n_sensitive = sum(1 for c in manifest if c["sensitive"])
    print(f"Generated {len(manifest)} test images in {args.out}/ "
          f"({n_sensitive} sensitive, {len(manifest) - n_sensitive} non-sensitive)")
    print(f"Manifest: {args.out}/manifest.json")


if __name__ == "__main__":
    main()
