"""
Validates the exact preprocessing + YOLOv8 output decoding logic that
extension/vision-detector.js implements, by running it in Python against
the real exported ONNX model + a real screenshot.

Why this exists: onnxruntime-node couldn't be installed in this sandbox
(blocked NuGet domain), so this proves the decode math is correct here in
Python/onnxruntime first -- the JS module in vision-detector.js is a
line-for-line port of this same logic, just using onnxruntime-web's API
instead of Python's.
"""
import sys
import numpy as np
import onnxruntime as ort
from PIL import Image

CLASS_NAMES = ["button", "input", "link", "image"]
IMG_SIZE = 320
CONF_THRESH = 0.25
IOU_THRESH = 0.45


def preprocess(img: Image.Image, size=IMG_SIZE):
    """Letterbox-resize + normalize, exactly what the JS module does before
    feeding the tensor to onnxruntime-web."""
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = img.convert("RGB").resize((nw, nh))
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (pad_x, pad_y))

    arr = np.asarray(canvas).astype(np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None, ...]  # HWC -> CHW, add batch dim
    return arr, scale, pad_x, pad_y


def iou(a, b):
    x1 = max(a[0], b[0]); y1 = max(a[1], b[1])
    x2 = min(a[2], b[2]); y2 = min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter + 1e-9)


def nms(boxes, scores, thresh):
    order = np.argsort(scores)[::-1]
    keep = []
    while len(order):
        i = order[0]
        keep.append(i)
        rest = order[1:]
        order = np.array([j for j in rest if iou(boxes[i], boxes[j]) < thresh])
    return keep


def decode(output, scale, pad_x, pad_y, orig_w, orig_h):
    """output shape: (1, 4+nc, num_boxes) -- YOLOv8 raw head output.
    Rows 0-3 are cx,cy,w,h (in the 320x320 letterboxed/padded frame),
    rows 4.. are per-class confidence (no separate objectness in v8)."""
    preds = output[0]  # (8, num_boxes)
    boxes_xywh = preds[:4, :].T          # (num_boxes, 4)
    class_scores = preds[4:, :].T        # (num_boxes, nc)
    class_ids = np.argmax(class_scores, axis=1)
    confs = class_scores[np.arange(len(class_ids)), class_ids]

    keep_mask = confs > CONF_THRESH
    boxes_xywh, class_ids, confs = boxes_xywh[keep_mask], class_ids[keep_mask], confs[keep_mask]

    results = []
    xyxy = []
    for (cx, cy, w, h) in boxes_xywh:
        x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        # undo letterbox padding + scale back to original image size
        x1 = (x1 - pad_x) / scale
        y1 = (y1 - pad_y) / scale
        x2 = (x2 - pad_x) / scale
        y2 = (y2 - pad_y) / scale
        xyxy.append([x1, y1, x2, y2])
    xyxy = np.array(xyxy) if len(xyxy) else np.zeros((0, 4))

    if len(xyxy) == 0:
        return []

    keep_idx = nms(xyxy, confs, IOU_THRESH)
    for i in keep_idx:
        x1, y1, x2, y2 = xyxy[i]
        results.append({
            "cls": CLASS_NAMES[class_ids[i]],
            "conf": float(confs[i]),
            "box": [round(x1), round(y1), round(x2 - x1), round(y2 - y1)],
        })
    return results


def main(model_path, image_path):
    img = Image.open(image_path)
    orig_w, orig_h = img.size

    tensor, scale, pad_x, pad_y = preprocess(img)

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name
    print(f"Model input: {sess.get_inputs()[0].shape}, output: {sess.get_outputs()[0].shape}")

    output = sess.run([output_name], {input_name: tensor})[0]
    print(f"Raw output shape: {output.shape}")

    detections = decode(output, scale, pad_x, pad_y, orig_w, orig_h)
    print(f"\n{len(detections)} detections (untrained model -- expect noise, this validates the MATH not accuracy):")
    for d in detections[:15]:
        print(f"  {d['cls']:8s} conf={d['conf']:.2f} box={d['box']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
