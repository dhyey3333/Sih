/**
 * onnxruntime-web setup.
 *
 * Three constraints shape everything here.
 *
 * 1. **MV3 forbids remotely hosted code.** The WASM binary is bundled in the
 *    extension and `wasmPaths` points at it, rather than ORT's default CDN. The
 *    extension CSP allows `'wasm-unsafe-eval'` for the same reason.
 * 2. **No SharedArrayBuffer.** Threaded WASM needs cross-origin isolation, which
 *    extension pages do not have by default, so `numThreads` is pinned to 1. The
 *    "simd-threaded" binary runs single-threaded perfectly well; asking for more
 *    threads without SAB fails at load rather than degrading.
 * 3. **The side panel is not permanent.** It exists only while it is open, so a
 *    session is created once, reused, and released on `pagehide` — otherwise
 *    every open leaks a few hundred MB of WASM heap.
 *
 * WebGPU first, WASM second. Firefox has no WebGPU today, so the WASM path is
 * not a nicety — it is the only path on one of the two required browsers.
 */

// The default entry is ORT's "jsep" build, which carries the WebGPU execution
// provider and the plain WASM one in a single 27 MB binary. `onnxruntime-web/webgpu`
// is a *different* build ("asyncify", 25 MB) — importing that one and staging jsep,
// or vice versa, silently ships 50 MB and loads neither. wxt.config.ts aliases this
// to the non-bundled variant so Vite does not emit a second copy of the wasm.
import * as ort from 'onnxruntime-web';
import type { PublicPath } from 'wxt/browser';

export type Backend = 'webgpu' | 'wasm';

export interface SessionInfo {
  backend: Backend;
  /** Time to compile and initialise the graph. */
  loadMs: number;
  modelBytes: number;
  /** Set when WebGPU was tried and refused, so the UI can say why. */
  webgpuError?: string;
}

let configured = false;

/**
 * Where `public/` is served from.
 *
 * Inside the extension this is `browser.runtime.getURL`. The eval harness runs the
 * identical vision code in an ordinary page (see lib/eval/), where that API does not
 * exist, so it sets a plain base URL instead. Measuring the same code that ships is
 * worth this one indirection.
 */
let assetBase: string | null = null;

export function setAssetBase(base: string): void {
  assetBase = base.replace(/\/$/, '');
  configured = false;
}

function assetUrl(path: PublicPath): string {
  return assetBase !== null ? `${assetBase}${path}` : browser.runtime.getURL(path);
}

function configure(): void {
  if (configured) return;

  // Bundled, not fetched — see constraint 1 above. WXT types the path against the
  // files actually in `public/`, so ask for the binary and trim to its directory
  // rather than hand-writing a path that could silently stop existing.
  ort.env.wasm.wasmPaths = assetUrl('/ort/ort-wasm-simd-threaded.jsep.wasm').replace(/[^/]+$/, '');
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  configured = true;
}

export interface LoadedSession {
  session: ort.InferenceSession;
  info: SessionInfo;
}

/**
 * WXT generates `PublicPath` from the actual contents of `public/`, so a path to a
 * model we do not ship is a compile error rather than a 404 at demo time.
 * (Imported explicitly because `Parameters<>` resolves to `getURL`'s *last*
 * overload, which is the HTML-page one.)
 */
export type ModelPath = PublicPath;

/**
 * Create a session, preferring WebGPU — but only a WebGPU worth having (see
 * `checkWebgpu`).
 *
 * The model is fetched as bytes and handed to ORT directly rather than by URL:
 * it makes the fallback path cheap (no second fetch) and lets us report the real
 * model size for the resource metric.
 */
export async function createSession(
  modelPath: ModelPath,
  /**
   * Force a backend instead of preferring WebGPU. Only used by the benchmark in
   * `eval/`, which has to report both numbers — Firefox has no WebGPU today, so
   * the WASM figure is not a footnote, it is the number for one of the two
   * browsers we must support.
   */
  prefer?: Backend,
): Promise<LoadedSession> {
  configure();

  const response = await fetch(assetUrl(modelPath));
  if (!response.ok) {
    throw new Error(`Model ${modelPath} is missing from the extension bundle`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  let webgpuError: string | undefined;

  const gpuCheck = prefer === 'wasm' ? { usable: false, reason: 'forced to wasm' } : await checkWebgpu();

  if (!gpuCheck.usable) {
    webgpuError = gpuCheck.reason;
  } else {
    const started = performance.now();
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      return {
        session,
        info: { backend: 'webgpu', loadMs: round(performance.now() - started), modelBytes: bytes.length },
      };
    } catch (error) {
      // A GPU that advertises WebGPU can still refuse a specific graph. Falling
      // back is normal, not an error worth surfacing as a failure.
      webgpuError = error instanceof Error ? error.message : String(error);
    }
  }

  const started = performance.now();
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return {
    session,
    info: {
      backend: 'wasm',
      loadMs: round(performance.now() - started),
      modelBytes: bytes.length,
      webgpuError,
    },
  };
}

/** Adapter names that mean "there is no GPU here, this is a CPU emulating one". */
const SOFTWARE_ADAPTER = /swiftshader|lavapipe|llvmpipe|software|microsoft basic|warp/i;

interface AdapterCheck {
  usable: boolean;
  reason?: string;
}

/**
 * WebGPU being *present* is not the same as WebGPU being *fast*.
 *
 * A machine with no usable GPU — a VM, a locked-down corporate laptop, a headless
 * browser, a system where the driver is blocklisted — still reports a WebGPU adapter,
 * backed by a software rasteriser. Measured on SwiftShader: **~4,000 ms per YuNet
 * frame against ~79 ms on the WASM path**, a 50× regression that a naive
 * "prefer WebGPU" check walks straight into.
 *
 * So the adapter is inspected, not just counted.
 */
async function checkWebgpu(): Promise<AdapterCheck> {
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<AdapterLike | null> };
    }
  ).gpu;
  if (!gpu) return { usable: false, reason: 'WebGPU not available in this browser' };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { usable: false, reason: 'no WebGPU adapter' };

    const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
    const description = [info.vendor, info.architecture, info.description]
      .filter(Boolean)
      .join(' ');

    if (description && SOFTWARE_ADAPTER.test(description)) {
      return { usable: false, reason: `software WebGPU adapter (${description}); WASM is faster` };
    }
    return { usable: true };
  } catch {
    return { usable: false, reason: 'WebGPU adapter request failed' };
  }
}

interface AdapterLike {
  info?: { vendor?: string; architecture?: string; description?: string };
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; description?: string }>;
}

export function tensorFrom(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor('float32', data, dims);
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export type { InferenceSession } from 'onnxruntime-web';
