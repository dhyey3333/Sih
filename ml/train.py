"""Train the on-device detector, and export it to ONNX.

    uv sync --group train
    uv run python train.py --data data/synth/data.yaml --epochs 80

On a Mac this runs on MPS and is a **smoke test only** — enough to prove the loop,
the loss and the export are wired correctly. A model worth shipping needs a real GPU
(Colab or Kaggle both have free T4s):

    !pip install ultralytics
    !python train.py --data data.yaml --epochs 80 --imgsz 960 --batch 16 --device 0

Why YOLO11n rather than something with a ViT backbone: the problem statement says
"a Vision Transformer (ViT) or equivalent", and equivalent is doing real work here.
This model runs on the user's laptop, inside a browser, on the critical path of
every agent step. `--variants` benchmarks the size/latency trade-off so the choice
is made on numbers rather than on which architecture sounds more impressive.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def pick_device(requested: str | None) -> str:
    if requested:
        return requested
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - guarded by the CLI
        raise SystemExit("torch is missing. Run: uv sync --group train") from exc

    if torch.cuda.is_available():
        return "0"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(args: argparse.Namespace) -> Path:
    from ultralytics import YOLO

    device = pick_device(args.device)
    print(f"device: {device}  model: {args.model}  imgsz: {args.imgsz}  epochs: {args.epochs}")
    if device in ("mps", "cpu"):
        print(
            "NOTE: this is a smoke run. Train on a CUDA GPU before quoting any mAP "
            "as a result — see the module docstring."
        )

    # Absolute: Ultralytics resolves a *relative* project against its own global
    # `runs_dir` setting, which quietly puts the run somewhere other than where the
    # command was invoked.
    project = Path(args.project).resolve()

    model = YOLO(args.model)
    model.train(
        data=str(Path(args.data).resolve()),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=str(project),
        name=args.name,
        exist_ok=True,
        # The dataset already randomises palette, font and density, so heavy colour
        # augmentation adds little; geometric jitter is what a screenshot really
        # varies by. Flipping is off: a horizontally mirrored UI does not exist, and
        # teaching the model that it does wastes capacity.
        fliplr=0.0,
        flipud=0.0,
        degrees=0.0,
        translate=0.05,
        scale=0.3,
        mosaic=args.mosaic,
        hsv_s=0.3,
        hsv_v=0.3,
        patience=args.patience,
        seed=args.seed,
        verbose=True,
    )

    weights = project / args.name / "weights" / "best.pt"
    if not weights.exists():
        raise SystemExit(f"training produced no weights at {weights}")
    return weights


def evaluate(weights: Path, data: str, split: str, imgsz: int) -> dict:
    from ultralytics import YOLO

    metrics = YOLO(str(weights)).val(data=str(Path(data).resolve()), split=split, imgsz=imgsz)
    box = metrics.box
    return {
        "split": split,
        "mAP50": round(float(box.map50), 4),
        "mAP50_95": round(float(box.map), 4),
        "precision": round(float(box.mp), 4),
        "recall": round(float(box.mr), 4),
        "per_class_mAP50": {
            metrics.names[int(c)]: round(float(box.ap50[i]), 4)
            for i, c in enumerate(box.ap_class_index)
        },
    }


def export_onnx(weights: Path, imgsz: int, out: Path, half: bool = False) -> dict:
    """Export to ONNX for onnxruntime-web.

    opset 17 and a static input size: onnxruntime-web's WebGPU backend is markedly
    happier with a fixed shape, and the extension letterboxes to a fixed size anyway.
    """
    from ultralytics import YOLO

    exported = YOLO(str(weights)).export(
        format="onnx", imgsz=imgsz, opset=17, simplify=True, dynamic=False, half=half
    )
    exported = Path(exported)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(exported, out)
    return {"onnx": str(out), "bytes": out.stat().st_size, "imgsz": imgsz, "half": half}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", default="data/synth/data.yaml")
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default=None, help="cuda index, 'mps' or 'cpu'")
    parser.add_argument("--project", type=Path, default=Path("runs"))
    parser.add_argument("--name", default="ui_detector")
    parser.add_argument("--patience", type=int, default=20)
    parser.add_argument("--mosaic", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=Path, default=Path("artifacts/ui_detector.onnx"))
    parser.add_argument("--skip-train", action="store_true", help="only evaluate and export")
    parser.add_argument("--weights", type=Path, default=None, help="with --skip-train")
    args = parser.parse_args()

    weights = args.weights if args.skip_train else train(args)
    if weights is None or not Path(weights).exists():
        raise SystemExit("no weights to evaluate; pass --weights with --skip-train")

    report = {
        "weights": str(weights),
        "val": evaluate(Path(weights), args.data, "val", args.imgsz),
        "test": evaluate(Path(weights), args.data, "test", args.imgsz),
        "export": export_onnx(Path(weights), args.imgsz, args.out),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    (args.out.parent / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
