/**
 * A plain-page build of the DOM perception + scoring code.
 *
 * The extension can only be scored by hand, one screen at a time. This bundle
 * exposes exactly the same modules to any page, so `eval/` can drive a real
 * browser over the demo site (and, later, over generated pages) and get the
 * precision/recall numbers without a human in the loop.
 *
 * Build:  npm run build:domcheck
 * Use:    <script src="/extension/.output/domcheck/domcheck.js"></script>
 *         __privagent.scorePage()
 */

import { DEMO_PROFILE } from '../lib/demo-profile';
import { buildSnapshot } from '../lib/dom/snapshot';
import { scorePage } from '../lib/eval/score-page';
import { detectionsFromFields, detectionsFromText, runPipeline } from '../lib/pipeline';
import { scanText } from '../lib/pii/validators';
import { classifyField } from '../lib/pii/dom-heuristics';
import { fuseDetections } from '../lib/redact/fuse';
import { Vault } from '../lib/pii/vault';
import { VisionLayer } from '../lib/vision';
import { setAssetBase } from '../lib/vision/runtime';

const api = {
  buildSnapshot,
  scorePage,
  DEMO_PROFILE,
  detectionsFromFields,
  detectionsFromText,
  runPipeline,
  fuseDetections,
  scanText,
  classifyField,
  Vault,
  VisionLayer,
  /** Point the model loader at wherever `extension/public/` is being served from. */
  setAssetBase,
};

declare global {
  // eslint-disable-next-line no-var
  var __privagent: typeof api;
}

globalThis.__privagent = api;

export default api;
