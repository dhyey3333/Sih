import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

// Same reason as in wxt.config.ts: the default ORT entry is the "bundle" build, and
// letting it inline a 27 MB wasm turns this diagnostic bundle into a 74 MB one.
const ORT_NON_BUNDLED = join(dirname(require.resolve('onnxruntime-web')), 'ort.min.mjs');

// A standalone IIFE build of the DOM perception + scoring code, so eval/ can run
// it in an ordinary page instead of inside the extension. Not part of the
// extension bundle — WXT never sees this config.
export default defineConfig({
  resolve: {
    alias: [{ find: /^onnxruntime-web$/, replacement: ORT_NON_BUNDLED }],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./scripts/domcheck.ts', import.meta.url)),
      name: 'PrivAgentDomCheck',
      formats: ['iife'],
      fileName: () => 'domcheck.js',
    },
    outDir: '.output/domcheck',
    emptyOutDir: true,
    // Readable output: this bundle is a diagnostic, not something we ship.
    minify: false,
  },
});
