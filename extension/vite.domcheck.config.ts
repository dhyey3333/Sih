import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// A standalone IIFE build of the DOM perception + scoring code, so eval/ can run
// it in an ordinary page instead of inside the extension. Not part of the
// extension bundle — WXT never sees this config.
export default defineConfig({
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
