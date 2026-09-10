"""
Benchmarks the UI-element detector for real precision/recall/latency
numbers against the rubric's "accuracy of visual context from screen"
and "resource utilization" criteria.

Reuses extension/validate_decode.py's preprocess()/decode() verbatim (via
sys.path import, not a re-implementation) so this benchmark is measuring
the exact same letterbox + YOLO-decode math the extension ships, run
against extension/vendor/ui_detector.onnx (or --model, e.g. your real
trained best.onnx from Step 2/3) and a labeled dataset from
labeling/generate_dataset.py (YOLO-format labels: `class cx cy w h`,
normalized 0-1, one .txt per image).

Usage:
  cd labeling && python3 generate_dataset.py --urls urls.txt --out dataset
  cd ../training && python3 benchmark_detection.py --dataset ../labeling/dataset --model ../extension/vendor/ui_detector.onnx

Honest note: with the untrained smoke-test model this repo ships by
default, expect precision/recall near 0 - that's not a benchmark bug, see
README Step 2. Point --model at a real trained best.onnx to get numbers
that mean something.
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "extension"))
from validate_decode import preprocess, decode, CLASS_NAMES  # noqa: E402


def load_yolo_labels(label_path, img_w, img_h):
    """Returns list of {cls, box: [x, y, w, h]} in PIXEL space (x,y = top-left),
    converted from YOLO's normalized `class cx cy w h` format."""
    boxes = []
    if not os.path.exists(label_path):
        return boxes
    with open(label_path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) != 5:
                continue
            cls_id, cx, cy, w, h = parts
            cls_id = int(cls_id)
            cx, cy, w, h = float(cx) * img_w, float(cy) * img_h, float(w) * img_w, float(h) * img_h
            boxes.append({"cls": CLASS_NAMES[cls_id], "box": [cx - w / 2, cy - h / 2, w, h]})
    return boxes


def iou_xywh(a, b):
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    x1, y1 = max(ax1, bx1), max(ay1, by1)
    x2, y2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a, area_b = a[2] * a[3], b[2] * b[3]
    return inter / (area_a + area_b - inter + 1e-9)


def match_predictions(preds, gts, iou_thresh):
    """Greedy IoU matching, per class. Returns (tp, fp, fn) counts."""
    matched_gt = set()
    tp = 0
    for p in preds:
        best_iou, best_j = 0, -1
        for j, g in enumerate(gts):
            if j in matched_gt or g["cls"] != p["cls"]:
                continue
            i = iou_xywh(p["box"], g["box"])
            if i > best_iou:
                best_iou, best_j = i, j
        if best_iou >= iou_thresh:
            matched_gt.add(best_j)
            tp += 1
    fp = len(preds) - tp
    fn = len(gts) - len(matched_gt)
    return tp, fp, fn


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="../labeling/dataset", help="dir with images/*.png + labels/*.txt")
    parser.add_argument("--model", default="../extension/vendor/ui_detector.onnx")
    parser.add_argument("--iou", type=float, default=0.5)
    args = parser.parse_args()

    image_paths = sorted(glob.glob(os.path.join(args.dataset, "images", "*.png")))
    if not image_paths:
        print(f"No images found under {args.dataset}/images/*.png")
        print("Generate a dataset first: cd ../labeling && python3 generate_dataset.py --urls urls.txt --out dataset")
        sys.exit(1)

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name

    totals = {c: {"tp": 0, "fp": 0, "fn": 0} for c in CLASS_NAMES}
    latencies_ms = []
    per_image = []

    for img_path in image_paths:
        img = Image.open(img_path)
        w, h = img.size
        label_path = os.path.join(args.dataset, "labels", os.path.splitext(os.path.basename(img_path))[0] + ".txt")
        gts = load_yolo_labels(label_path, w, h)

        tensor, scale, pad_x, pad_y = preprocess(img)
        t0 = time.perf_counter()
        output = sess.run([output_name], {input_name: tensor})[0]
        latency_ms = (time.perf_counter() - t0) * 1000
        latencies_ms.append(latency_ms)

        preds = decode(output, scale, pad_x, pad_y, w, h)

        img_tp = img_fp = img_fn = 0
        for cls in CLASS_NAMES:
            cls_preds = [p for p in preds if p["cls"] == cls]
            cls_gts = [g for g in gts if g["cls"] == cls]
            tp, fp, fn = match_predictions(cls_preds, cls_gts, args.iou)
            totals[cls]["tp"] += tp
            totals[cls]["fp"] += fp
            totals[cls]["fn"] += fn
            img_tp += tp
            img_fp += fp
            img_fn += fn

        per_image.append({
            "image": os.path.basename(img_path),
            "n_gt": len(gts),
            "n_pred": len(preds),
            "tp": img_tp, "fp": img_fp, "fn": img_fn,
            "inference_ms": round(latency_ms, 1),
        })

    print(f"\n--- Per-class results (IoU >= {args.iou}) ---")
    overall_tp = overall_fp = overall_fn = 0
    per_class_report = {}
    for cls in CLASS_NAMES:
        tp, fp, fn = totals[cls]["tp"], totals[cls]["fp"], totals[cls]["fn"]
        overall_tp += tp; overall_fp += fp; overall_fn += fn
        precision = tp / (tp + fp) if (tp + fp) else float("nan")
        recall = tp / (tp + fn) if (tp + fn) else float("nan")
        per_class_report[cls] = {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall}
        print(f"  {cls:8s} tp={tp:4d} fp={fp:4d} fn={fn:4d}  precision={precision:.3f}  recall={recall:.3f}")

    overall_precision = overall_tp / (overall_tp + overall_fp) if (overall_tp + overall_fp) else float("nan")
    overall_recall = overall_tp / (overall_tp + overall_fn) if (overall_tp + overall_fn) else float("nan")
    avg_latency = sum(latencies_ms) / len(latencies_ms)

    print(f"\n--- Overall ---")
    print(f"Precision: {overall_precision:.3f}  Recall: {overall_recall:.3f}")
    print(f"Avg inference latency: {avg_latency:.1f}ms/image (Python/CPUExecutionProvider - "
          f"the extension's real number is vision_inference_ms in the popup dashboard, "
          f"onnxruntime-web/WASM in-browser, not directly comparable to this)")
    print(f"Images evaluated: {len(image_paths)}")

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": args.model,
        "dataset": args.dataset,
        "iou_threshold": args.iou,
        "n_images": len(image_paths),
        "per_class": per_class_report,
        "overall": {"tp": overall_tp, "fp": overall_fp, "fn": overall_fn,
                    "precision": overall_precision, "recall": overall_recall},
        "avg_inference_ms": avg_latency,
        "per_image": per_image,
    }
    def _clean(obj):
        if isinstance(obj, float) and obj != obj:  # NaN
            return None
        if isinstance(obj, dict):
            return {k: _clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean(v) for v in obj]
        return obj

    out_path = os.path.join(os.path.dirname(__file__), "detection_benchmark_report.json")
    with open(out_path, "w") as f:
        json.dump(_clean(report), f, indent=2)
    print(f"\nFull report written to {out_path}")


if __name__ == "__main__":
    main()
