#!/usr/bin/env node
/**
 * Benchmarks the OCR-based redaction layer for real, precision/recall
 * numbers for the rubric - not eyeballed.
 *
 * Imports ocrRedact() DIRECTLY from extension/ocr-redactor.js, so this
 * runs the exact same Tesseract.js + regex-classifier code the extension
 * ships (see that file's top-of-file note on why it works in both a
 * chrome offscreen document and plain Node), against a labeled test set
 * from labeling/generate_redaction_testset.py.
 *
 * Usage:
 *   cd labeling && python3 generate_redaction_testset.py --out ../training/redaction_testset
 *   cd ../training && node benchmark_redaction.mjs --testset redaction_testset
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ocrRedact, terminateWorker } from "../extension/ocr-redactor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = { testset: "redaction_testset", iouThreshold: 0.3 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--testset") args.testset = argv[++i];
    if (argv[i] === "--iou") args.iouThreshold = parseFloat(argv[++i]);
  }
  return args;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.width * a.height, areaB = b.width * b.height;
  return inter / (areaA + areaB - inter || 1);
}

// A ground-truth line counts as "covered" if a produced region overlaps
// it past the IoU threshold, OR (looser, and realistic - the classifier
// is allowed to redact only the numeric VALUE, e.g. just "4111 1111
// 1111 1111", not the "Card Number:" label prefix) if a produced
// region's center falls inside the ground-truth line's box.
function covers(region, gtBox, threshold) {
  if (iou(region, gtBox) >= threshold) return true;
  const cx = region.x + region.width / 2, cy = region.y + region.height / 2;
  return cx >= gtBox.x && cx <= gtBox.x + gtBox.width && cy >= gtBox.y && cy <= gtBox.y + gtBox.height;
}

async function main() {
  const args = parseArgs();
  const testsetDir = path.resolve(__dirname, args.testset);
  const manifestPath = path.join(testsetDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest at ${manifestPath}.`);
    console.error("Generate one first: cd ../labeling && python3 generate_redaction_testset.py --out ../training/" + args.testset);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  let tp = 0, fp = 0, fn = 0, tn = 0;
  let totalOcrMs = 0;
  const perCase = [];

  for (const c of manifest) {
    const imgPath = path.join(testsetDir, c.file);
    const { regions, timings } = await ocrRedact(imgPath);
    totalOcrMs += timings.total_ocr_ms;

    const coveringRegions = regions.filter((r) => covers(r, c.gt_box, args.iouThreshold));
    // Each test image has exactly one line of text, so any produced
    // region that does NOT cover it is a stray/misplaced detection -
    // counted as an extra false positive regardless of whether the case
    // itself is sensitive.
    const extraRegions = regions.length - coveringRegions.length;

    let verdict;
    if (c.sensitive) {
      if (coveringRegions.length > 0) { tp++; verdict = "TP"; }
      else { fn++; verdict = "FN"; }
      fp += extraRegions;
    } else {
      if (regions.length > 0) { fp++; verdict = "FP"; }
      else { tn++; verdict = "TN"; }
    }

    perCase.push({ id: c.id, text: c.text, sensitive: c.sensitive, verdict, regions_found: regions.length, ocr_ms: timings.total_ocr_ms });
  }

  await terminateWorker();

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  console.log("\n--- Per-case results ---");
  for (const r of perCase) {
    console.log(`[${r.verdict}] ${r.sensitive ? "sensitive" : "safe    "} | ${r.regions_found} region(s) | ${r.ocr_ms}ms | "${r.text}"`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    testset: args.testset,
    iou_threshold: args.iouThreshold,
    n_cases: manifest.length,
    confusion: { tp, fp, fn, tn },
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    avg_ocr_ms: Math.round(totalOcrMs / manifest.length),
    per_case: perCase,
  };

  console.log("\n--- Summary ---");
  console.log(`Precision: ${(precision * 100).toFixed(1)}%  Recall: ${(recall * 100).toFixed(1)}%  F1: ${(f1 * 100).toFixed(1)}%`);
  console.log(`Confusion matrix: TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`Avg OCR time per image: ${report.avg_ocr_ms}ms`);

  const outPath = path.join(__dirname, "redaction_benchmark_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
