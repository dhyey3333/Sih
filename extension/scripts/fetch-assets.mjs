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

  const model = join(root, 'public/models/face_detection_yunet.onnx');
  if (await exists(model)) {
    const { size } = await stat(model);
    console.log(`✓ public/models/face_detection_yunet.onnx (${Math.round(size / 1024)} KB)`);
  } else {
    console.warn(
      '! public/models/face_detection_yunet.onnx is missing.\n' +
        '  Download it from the OpenCV Zoo (Git LFS media URL):\n' +
        '  https://media.githubusercontent.com/media/opencv/opencv_zoo/main/' +
        'models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    );
  }
}

await main();
