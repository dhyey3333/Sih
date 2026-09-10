/**
 * Stage the on-device model runtime into `public/`.
 *
 * MV3 forbids remotely hosted code, so onnxruntime-web's WASM binary has to ship
 * inside the extension rather than be fetched at runtime (CLAUDE.md). It is 27 MB
 * uncompressed, which does not belong in git — it is byte-identical to what npm
 * already installed, so we copy it from node_modules instead and gitignore the
 * destination.
 *
 * The YuNet model is 227 KB and *is* committed: a fresh clone should be able to
 * run the demo with no network at all.
 *
 * Runs automatically on `npm install` (postinstall).
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The `.jsep` build is the one that carries the WebGPU execution provider *and*
 * the plain WASM one in a single binary, so a browser without WebGPU (Firefox
 * today) falls back inside the same file rather than needing a second download.
 */
const RUNTIME_FILES = [
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'public/ort/ort-wasm-simd-threaded.jsep.wasm'],
  // The loader that ORT fetches from `wasmPaths` before the binary itself.
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'public/ort/ort-wasm-simd-threaded.jsep.mjs'],

  // Tesseract.js, for reading text out of images. Same reasoning as ORT: MV3 forbids
  // remotely hosted code, and the library's default is to pull these from a CDN.
  // The "lstm" core is the smaller of the two builds and is all we need; the glue JS
  // resolves its .wasm sibling relative to its own URL, so both must sit together.
  ['node_modules/tesseract.js/dist/worker.min.js', 'public/tesseract/worker.min.js'],
  //
  // SIMD only, deliberately. The non-SIMD fallback is another 6.4 MB, and WASM SIMD
  // has shipped since Chrome 91 and Firefox 89 — every browser that can run this
  // extension at all has it. Not shipping a fallback that can never fire.
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'public/tesseract/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'public/tesseract/tesseract-core-simd-lstm.wasm'],
];

/** Committed model files, checked rather than copied. */
const COMMITTED = [
  ['public/models/face_detection_yunet.onnx', 'YuNet face detector'],
  ['public/tesseract/eng.traineddata.gz', 'Tesseract English data (tessdata_fast)'],
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  for (const [from, to] of RUNTIME_FILES) {
    const source = join(root, from);
    const destination = join(root, to);

    if (!(await exists(source))) {
      console.error(`✗ ${from} is missing. Run \`npm install\` first.`);
      process.exitCode = 1;
      return;
    }

    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const { size } = await stat(destination);
    console.log(`✓ ${to} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }

  for (const [path, label] of COMMITTED) {
    const file = join(root, path);
    if (await exists(file)) {
      const { size } = await stat(file);
      console.log(`✓ ${path} (${Math.round(size / 1024)} KB) — ${label}`);
    } else {
      console.warn(`! ${path} is missing (${label}). See docs/PROGRESS.md for its source.`);
      process.exitCode = 1;
    }
  }
}

await main();
