"""
Takes the output of labeling/generate_dataset.py (images/ + labels/ + a flat
manifest) and arranges it into the directory layout Ultralytics YOLO expects
for training, with a train/val split and a data.yaml pointing at it.

Run:
    python3 prepare_yolo_dataset.py --src ../labeling/dataset --out yolo_dataset --val-frac 0.15
"""
import argparse
import random
import shutil
from pathlib import Path


def main(src: Path, out: Path, val_frac: float, seed: int):
    manifest = [l.strip() for l in (src / "manifest.txt").read_text().splitlines() if l.strip()]
    classes = (src / "classes.txt").read_text().splitlines()

    random.Random(seed).shuffle(manifest)
    n_val = max(1, int(len(manifest) * val_frac)) if len(manifest) > 1 else 0
    val_ids = set(manifest[:n_val])

    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    for pid in manifest:
        split = "val" if pid in val_ids else "train"
        shutil.copy(src / "images" / f"{pid}.png", out / "images" / split / f"{pid}.png")
        shutil.copy(src / "labels" / f"{pid}.txt", out / "labels" / split / f"{pid}.txt")

    data_yaml = out / "data.yaml"
    data_yaml.write_text(
        f"path: {out.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(classes)}\n"
        f"names: {classes}\n"
    )

    print(f"train={len(manifest) - n_val} images, val={n_val} images, classes={classes}")
    print(f"data.yaml written to {data_yaml}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=Path("../labeling/dataset"))
    ap.add_argument("--out", type=Path, default=Path("yolo_dataset"))
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    main(args.src, args.out, args.val_frac, args.seed)
