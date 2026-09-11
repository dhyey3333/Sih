"""Boot the *packed* extension in a real browser and check it comes up clean.

    cd extension && npm run build
    uv run python -m eval.smoke_extension

Everything else in `eval/` measures the library code through a bundle. This loads
the built Chrome artifact the way a user would — same manifest, same CSP, same
`chrome-extension://` origin — opens the side panel page and asserts that:

  * it boots with no uncaught error and no console error;
  * the markup and the script agree, so every handle resolved (a missing id throws
    at module load and leaves a blank panel);
  * the bundled ONNX runtime actually loads from inside the extension, which is the
    one thing that cannot be checked anywhere else: MV3 forbids remote code, the
    WASM path is target-specific, and a wrong `wasmPaths` fails only here.

It does not drive a task — that needs a real tab to attach a content script to.
This is the check that the demo will start.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "extension/.output/chrome-mv3"

IGNORE = (
    # Chromium complains about this on every extension page; nothing to do with us.
    "Unchecked runtime.lastError",
)


def main() -> int:
    if not BUILD.exists():
        print(f"{BUILD.relative_to(ROOT)} is missing. Build it:  cd extension && npm run build")
        return 1

    errors: list[str] = []

    with tempfile.TemporaryDirectory() as profile, sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            profile,
            headless=False,  # MV3 service workers do not start in headless mode
            args=[
                f"--disable-extensions-except={BUILD}",
                f"--load-extension={BUILD}",
                "--enable-unsafe-webgpu",
            ],
        )

        # The extension id is only knowable once something from it is running.
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event(
            "serviceworker", timeout=15_000
        )
        extension_id = worker.url.split("/")[2]
        print(f"extension id: {extension_id}")

        page = context.new_page()
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
                if m.type == "error" and not any(i in m.text for i in IGNORE) else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(f"chrome-extension://{extension_id}/sidepanel.html", wait_until="load")
        page.wait_for_timeout(1500)

        # The panel writes its first activity line only after the whole module has
        # run, so a non-empty log is proof that no handle lookup threw.
        booted = page.evaluate("() => document.querySelectorAll('#log li').length")
        vault_rows = page.evaluate("() => document.querySelectorAll('#profile label').length")
        print(f"activity lines: {booted}   vault rows: {vault_rows}")

        # The bundled runtime, end to end: fetch the model and this target's WASM
        # binary from the extension origin, then hand the binary to
        # `WebAssembly.compile`. That last step is the one that proves the CSP
        # really allows `wasm-unsafe-eval` and the staged file is the right,
        # undamaged build — a wrong `wasmPaths` fails nowhere else.
        print("loading the on-device runtime…")
        result = page.evaluate(
            """async () => {
              const t0 = performance.now();
              const get = async (path) => {
                const res = await fetch(chrome.runtime.getURL(path));
                if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
                return res.arrayBuffer();
              };
              try {
                const model = await get('/models/face_detection_yunet.onnx');
                // Whichever binary this target ships; only one of them exists.
                let wasm = null, name = null;
                for (const candidate of [
                  '/ort/ort-wasm-simd-threaded.jsep.wasm',
                  '/ort/ort-wasm-simd-threaded.wasm',
                ]) {
                  try { wasm = await get(candidate); name = candidate; break; } catch {}
                }
                if (!wasm) throw new Error('no ORT wasm binary is reachable');
                await WebAssembly.compile(wasm);
                return {
                  ok: true, wasm: name,
                  modelKB: Math.round(model.byteLength / 1024),
                  wasmMB: +(wasm.byteLength / 1024 / 1024).toFixed(1),
                  ms: Math.round(performance.now() - t0),
                };
              } catch (e) {
                return { ok: false, error: String(e) };
              }
            }"""
        )
        print(f"  {json.dumps(result)}")
        if not result.get("ok"):
            errors.append(f"on-device runtime unreachable: {result.get('error')}")

        context.close()

    if errors:
        print("\nFAILED")
        for line in errors:
            print(f"  {line}")
        return 1

    if booted == 0:
        print("\nFAILED: the panel produced no activity line — it did not finish booting")
        return 1

    print("\nOK — the packed extension boots clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
