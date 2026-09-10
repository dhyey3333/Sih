"""
Fine-tunes a pretrained YOLOv8n on the UI-element dataset produced by
labeling/generate_dataset.py + prepare_yolo_dataset.py.

We start from COCO-pretrained weights rather than training from scratch --
this is standard transfer learning: the early layers already know how to
find "a rectangular thing with an edge" (buttons, boxes) and "a region of
text", so fine-tuning only needs to teach it OUR 4 classes and UI-specific
visual style, not general object detection from zero. This is what makes
this realistic to do inside a hackathon, on a free Colab GPU, in under an
hour, rather than needing days of training.

Run (on a machine/Colab with a GPU):
    python3 train.py --data yolo_dataset/data.yaml --epochs 50

Output:
    runs/detect/train/weights/best.pt   <- the fine-tuned model
"""
import argparse
from ultralytics import YOLO


def main(data_yaml: str, epochs: int, imgsz: int, base_model: str):
    model = YOLO(base_model)  # downloads pretrained COCO weights on first run

    model.train(
        data=data_yaml,
        epochs=epochs,
        imgsz=imgsz,
        batch=16,
        patience=15,          # early-stop if val loss plateaus, avoid overfitting on a small set
        name="ui_detector",   # saved to runs/detect/ui_detector/ by default -- don't also pass project=,
                               # it duplicates the runs/detect prefix
        exist_ok=True,
        # Augmentations tuned down from YOLO's photo-object defaults: UI
        # screenshots aren't photos of physical objects, so heavy color
        # jitter / rotation / mosaic hurts more than it helps here (a
        # rotated screenshot isn't a realistic input at inference time).
        degrees=0.0,
        shear=0.0,
        perspective=0.0,
        flipud=0.0,
        fliplr=0.0,           # a mirrored webpage isn't a real webpage
        mosaic=0.3,
        hsv_h=0.01,
        hsv_s=0.3,
        hsv_v=0.3,
    )

    metrics = model.val()
    print("\nValidation results:")
    print(f"  mAP50:    {metrics.box.map50:.3f}")
    print(f"  mAP50-95: {metrics.box.map:.3f}")
    print(f"  per-class mAP50: {dict(zip(metrics.names.values(), metrics.box.ap50))}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="yolo_dataset/data.yaml")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--base-model", default="yolov8n.pt", help="pretrained checkpoint to fine-tune from")
    args = ap.parse_args()
    main(args.data, args.epochs, args.imgsz, args.base_model)
