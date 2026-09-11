# ml — synthetic data, training, ONNX export

The on-device detector that covers what the DOM cannot see: canvas-rendered apps,
PDF pages, screenshots-of-screens, cross-origin frames.

## Why a custom model at all

The DOM privacy layer already handles DOM-rendered pages exactly, in 2–20 ms, with
zero false positives on our test set. A model that re-detects what the DOM already
declares would cost time and *add* errors. This model exists for the pages where
`document.querySelectorAll` returns one `<canvas>` and nothing else — where the
agent can see the screen but has nothing to act on, and the privacy layer is blind.

Two jobs, and the second is the one that matters most:

| Class | Purpose |
|---|---|
| `pii_text`, `password_field`, `payment_card`, `id_document`, `qr_code`, `signature` | Redaction — fused with the DOM and OCR layers |
| `text_input`, `button` | **Action** — these become elements the VLM can click and type into on a canvas app |

**There is deliberately no `face` class.** Faces are YuNet's job. We cannot
synthesise photographs — the repo may not contain anyone's face — and an illustrated
stand-in would teach the model to find drawings, producing a number that looks good
on our own validation split and fails on the first real profile picture. See
`synth/classes.py`.

## The trick: labels come from the DOM

Every sensitive element in a generated page carries `data-pii="TYPE"` and every
control `data-ui="input|button|password"` — the same annotation the demo site uses.
`synth/extract.js` runs inside the rendered page and reads the boxes back out with
`getBoundingClientRect()`. No human ever draws a box, and the training labels cannot
drift from the eval ground truth because they are the same attribute.

Three details that took measuring to get right:

- **`pii_text` hugs the glyphs, not the input.** An empty input and a filled one have
  identical rects, so labelling the whole control would teach the model that every
  input holds a secret. The extractor measures the text.
- **Canvas UI labels itself.** `synth/canvas.py` draws a form into a `<canvas>` and
  records each box as it paints. This is the only source of labels for the case the
  detector exists for.
- **Decoys are checked against the real checksums.** A random 12-digit order number
  satisfies Verhoeff about one time in ten. Left unchecked, that share of the
  negatives would be labelled "not PII" while the extension correctly detects them —
  silently teaching the model that real Aadhaar numbers are safe.

## Generate

```bash
uv sync
uv run playwright install chromium
uv run python -m synth.generate --out data/synth --per-recipe 120
```

Then **look at the labels** — a labelling bug is invisible in the summary counts and
shows up much later as a model that trains to a fine mAP and detects nothing useful:

```bash
uv run python -m synth.preview --data data/synth --split train --limit 12
```

Open the emitted HTML. Boxes are drawn from the YOLO files, not from the DOM, so
what you see is what the trainer sees.

### Splitting

80/10/10 **by recipe**, not by image (`synth/recipes.py`). Splitting by image would
put near-identical pages in both train and validation and produce a validation score
that means nothing — the model would have seen that layout with a different name on
it. Holding whole recipes out is the only way the number answers the real question.

## Train

```bash
uv sync --group train
uv run python train.py --data data/synth/data.yaml --epochs 80
```

On a Mac this runs on MPS. The shipped model is 40 epochs at 448 px over 2,280
generated pages, about 93 minutes:

| | |
|---|---|
| val | mAP50 **0.900**, mAP50-95 0.759, precision 0.92, recall 0.867 |
| test | mAP50 0.934, mAP50-95 0.761 |
| export | 10.0 MB ONNX, opset 17, static 448×448 |

The test split reads *higher* than validation, which is the recipe split doing its
job rather than a mistake: its two recipes (`empty_form`, `notice`) carry fewer and
easier classes than the validation pair (`statement`, `kyc_with_document`). A split by
image would have produced two numbers that agreed with each other and told us nothing.

Every one of those pages was drawn by the generator in `synth/`. Good numbers on
held-out *layouts* are not the same as good numbers on real screenshots, and we have
not measured the second. For more capacity, a CUDA GPU — Colab and Kaggle both have
free T4s — makes 960 px practical:

```bash
!pip install ultralytics
!python train.py --data data.yaml --epochs 80 --imgsz 960 --batch 16 --device 0
```

`train.py` evaluates on both val and test, exports ONNX (opset 17, static shape,
simplified — onnxruntime-web's WebGPU backend is markedly happier with a fixed
input) and writes `artifacts/report.json`.

## Integrate

Copy the export into the extension and rebuild:

```bash
cp artifacts/ui_detector.onnx ../extension/public/models/
cd ../extension && npm run build
```

The extension loads it lazily and treats its absence as a normal state
(`lib/vision/ui-detector.ts`), so a build without a trained model degrades to the
DOM, YuNet and OCR layers rather than failing.

**The class order is the contract.** `synth/classes.py` and
`extension/lib/vision/ui-detector.ts` must list the classes identically; reordering
either silently mislabels every detection. `extension/tests/ui-detector.test.ts`
asserts the list.

## Known limitations

- **Class imbalance.** A generated run yields roughly 5,700 `button` and 4,900
  `pii_text` boxes against ~140 `qr_code` and ~135 `signature`. The rare classes will
  train poorly until more recipes feature them.
- **Synthetic only.** Everything here is generated. A held-out set of real
  screenshots — hand-labelled, never trained on — is the honest test, and is not
  built yet.
- **Illustrated avatars.** Present so layouts look real; they carry no label.
