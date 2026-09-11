/**
 * Build a standalone, populated copy of the side panel for design review.
 *
 *   npm run uipreview   →  .output/uipreview/index.html
 *
 * Why this exists: the real panel is empty until an extension is loaded, a page is
 * open and a model has run. Judging spacing, colour and density against an empty
 * shell is how a UI ends up looking fine in development and cramped in the demo.
 * This inlines the *real* markup and the *real* stylesheet — only the data is
 * faked — so what you review is what ships.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const panel = join(here, '..', 'entrypoints', 'sidepanel');
const outDir = join(here, '..', '.output', 'uipreview');

const [html, css, populate] = await Promise.all([
  readFile(join(panel, 'index.html'), 'utf8'),
  readFile(join(panel, 'style.css'), 'utf8'),
  readFile(join(here, 'uipreview.data.js'), 'utf8'),
]);

const page = html
  .replace('<link rel="stylesheet" href="./style.css" />', `<style>\n${css}\n</style>`)
  // The real entry point imports the WXT browser polyfill and onnxruntime; neither
  // works from a file server, and neither affects layout.
  .replace('<script type="module" src="./main.ts"></script>', `<script>\n${populate}\n</script>`);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'index.html'), page);
console.log(`wrote ${join(outDir, 'index.html')}`);
