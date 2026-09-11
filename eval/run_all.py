"""One command that regenerates every number we report.

    uv run python -m eval.run_all

Drives a real browser over the demo site, running the *shipped* extension modules
(via the `domcheck` bundle) rather than a reimplementation of them, and writes
`eval/results/`:

    results.json    every measurement, machine-readable
    RESULTS.md      the table that goes in the deck

Five metrics, matching the judging criteria in CLAUDE.md:

  PII precision / recall     per page, with and without the vision layer
  Redaction precision        pixel coverage, plus the leak test below
  Leak test                  OCR the *redacted* image and count ground-truth values
                             still recoverable. This is the one that matters: it
                             answers "did anything survive" rather than "did we draw
                             a box in roughly the right place".
  Client resources           model sizes, load and inference time, WebGPU vs WASM
  Latency                    per stage
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import statistics
import threading
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HARNESS_JS = (Path(__file__).parent / "harness.js").read_text()
BUNDLE = ROOT / "extension/.output/domcheck/domcheck.js"

PAGES = ("kyc", "profile", "bank", "apply")

# The holdout. These pages live outside `demo-site/` on purpose: they are never
# demonstrated, and no rule was written or tuned while looking at them. They are
# deliberately unlike the demo site — an SPA with no labels, a 2005 table-layout
# portal, a bilingual statement with no form controls, a chat transcript where every
# value sits in running prose. Scored separately, because a number measured on the
# pages you developed against is not evidence of anything.
HOLDOUT = ("spa", "legacy", "statement", "support", "webcomponent", "frames")

VIEWPORT = (1280, 1600)


@contextmanager
def serve(directory: Path, port: int = 0):
    """A static server over the repo root, so the page can fetch the models."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(directory), **kw)

        def log_message(self, *a):  # keep the output readable
            pass

    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        actual = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{actual}"
        finally:
            httpd.shutdown()


def measure_pages(page, base: str, names=PAGES, folder: str = "demo-site") -> list[dict]:
    results = []
    for name in names:
        page.goto(f"{base}/{folder}/{name}.html", wait_until="load")
        page.add_script_tag(url=f"{base}/extension/.output/domcheck/domcheck.js")
        page.wait_for_function("() => !!window.__privagent")
        page.evaluate(f"() => window.__privagent.setAssetBase('{base}/extension/public')")
        # A script tag, not `evaluate`: Playwright treats an evaluated string as an
        # expression and *calls* it when it is a function, which would run the harness
        # with no arguments. A top-level declaration just defines the global.
        page.add_script_tag(content=HARNESS_JS)

        result = page.evaluate(
            "opts => runEval(opts)",
            {"assetBase": f"{base}/extension/public", "profile": True, "ocr": True, "leakTest": True},
        )
        result["page"] = name
        results.append(result)
        print(f"  {name}: recall {fmt(result['withVision']['recall'])} "
              f"precision {fmt(result['withVision']['precision'])} "
              f"leaked {result['leak']['leaked'] if result['leak'] else '-'}")
    return results


def benchmark_backends(page, base: str, runs: int = 8) -> list[dict]:
    """WebGPU vs WASM. Firefox has no WebGPU, so the WASM row is not a footnote."""
    page.goto(f"{base}/demo-site/kyc.html", wait_until="load")
    page.add_script_tag(url=f"{base}/extension/.output/domcheck/domcheck.js")
    page.wait_for_function("() => !!window.__privagent")

    return page.evaluate(
        """async ({ base, runs }) => {
      const { VisionLayer, Vault } = window.__privagent;
      window.__privagent.setAssetBase(base + '/extension/public');

      const dpr = 1, w = 1280, h = 900;
      const shot = document.createElement('canvas');
      shot.width = w; shot.height = h;
      const ctx = shot.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      const img = document.querySelector('img.avatar');
      if (img) ctx.drawImage(img, 60, 60, 208, 256);

      const out = [];
      for (const backend of ['webgpu', 'wasm']) {
        const v = new VisionLayer({ backend, ocr: false });
        v.setAssetBase(base + '/extension/public');
        let info;
        try { info = await v.warmUp(); } catch { out.push({ backend, error: 'unavailable' }); continue; }
        const vault = new Vault();
        const times = [];
        for (let i = 0; i < runs; i++) {
          const snap = { url: 'bench://' + backend + i, dpr, viewport: { w, h }, scroll: { x: 0, y: 0 },
            elements: [], textFindings: [], imageCandidates: [], durationMs: 0, title: '' };
          const r = await v.detect(shot, w, h, snap, vault);
          times.push(r.stats.inferenceMs);
        }
        await v.dispose();
        // Drop the first two: WebGPU compiles shaders on the first real dispatch.
        // `requested` vs `backend`: asking for WebGPU and getting WASM is the
        // correct outcome on a software adapter, and the table should say so
        // rather than printing two rows that both claim to be WASM.
        out.push({ requested: backend, backend: info.backend, loadMs: info.loadMs,
                   modelBytes: info.modelBytes, webgpuError: info.webgpuError ?? null,
                   warm: times.slice(2), firstInference: times[0] });
      }
      return out;
    }""",
        {"base": base, "runs": runs},
    )


def asset_sizes() -> dict:
    ext = ROOT / "extension"
    files = {
        "yunet_onnx": ext / "public/models/face_detection_yunet.onnx",
        "ui_detector_onnx": ext / "public/models/ui_detector.onnx",
        # Chrome gets the jsep build (WebGPU + WASM); Firefox has no WebGPU, so it
        # gets the plain one. Reporting a single "ORT size" would be wrong for both.
        "ort_wasm_chrome": ext / "public/ort/ort-wasm-simd-threaded.jsep.wasm",
        "ort_wasm_firefox": ext / "public/ort/ort-wasm-simd-threaded.wasm",
        "tesseract_core_wasm": ext / "public/tesseract/tesseract-core-simd-lstm.wasm",
        "tesseract_lang": ext / "public/tesseract/eng.traineddata.gz",
    }
    sizes = {k: (p.stat().st_size if p.exists() else None) for k, p in files.items()}
    for target, key in (("chrome-mv3", "packed_chrome"), ("firefox-mv3", "packed_firefox")):
        built = ext / ".output" / target
        if built.exists():
            sizes[key] = sum(f.stat().st_size for f in built.rglob("*") if f.is_file())
    return sizes


def fmt(value) -> str:
    return "—" if value is None else f"{value:.3f}"


def pct(value) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def mb(value) -> str:
    return "—" if not value else f"{value / 1024 / 1024:.1f} MB"


def build_markdown(report: dict) -> str:
    lines = ["# Eval results", "", f"Generated by `uv run python -m eval.run_all`.", ""]

    lines += ["## PII detection", "",
              "Scored against each page's own `data-pii` ground truth, with the demo profile loaded.",
              "",
              "| Page | Items | Precision | Recall | F1 | Pixel recall | Screen redacted |",
              "|---|---|---|---|---|---|---|"]
    for r in report["pages"]:
        v = r["withVision"]
        lines.append(
            f"| `{r['page']}.html` | {v['groundTruth']} | {fmt(v['precision'])} | {fmt(v['recall'])} | "
            f"{fmt(v['f1'])} | {pct(v['pixelRecall'])} | {pct(v['screenRedactedPct'])} |"
        )
    agg = report["aggregate"]
    lines.append(
        f"| **all** | **{agg['groundTruth']}** | **{fmt(agg['precision'])}** | **{fmt(agg['recall'])}** | "
        f"**{fmt(agg['f1'])}** | — | — |"
    )

    lines += ["", "### Holdout — pages no rule was written against", "",
              "Pages that live outside `demo-site/` and are never demonstrated. Four of them —",
              "a label-less SPA, a 2005 table-layout portal, a bilingual statement with no form",
              "controls at all, and a support transcript where every value sits in running prose",
              "— were not looked at while any detector rule was written or tuned. Their first",
              "blind run read precision 1.000 / recall 0.784; what it found is in DECISIONS D22.",
              "",
              "`webcomponent.html` is the exception and is **not blind**: shadow-DOM traversal",
              "was written first and the page added to hold it in place (D24). It is a",
              "regression test, counted here but labelled so the distinction is not lost.", "",
              "| Page | Items | Precision | Recall | F1 | Pixel recall |", "|---|---|---|---|---|---|"]
    for r in report.get("holdout", []):
        v = r["withVision"]
        lines.append(
            f"| `{r['page']}.html` | {v['groundTruth']} | {fmt(v['precision'])} | {fmt(v['recall'])} | "
            f"{fmt(v['f1'])} | {pct(v['pixelRecall'])} |"
        )
    hold = report.get("holdoutAggregate")
    if hold:
        lines.append(
            f"| **all** | **{hold['groundTruth']}** | **{fmt(hold['precision'])}** | "
            f"**{fmt(hold['recall'])}** | **{fmt(hold['f1'])}** | — |"
        )

    lines += ["", "### What the vision layer adds", "",
              "| Page | Recall, DOM only | Recall, with vision |", "|---|---|---|"]
    for r in report["pages"]:
        lines.append(f"| `{r['page']}.html` | {fmt(r['domOnly']['recall'])} | {fmt(r['withVision']['recall'])} |")

    lines += ["", "## Leak test", "",
              "The redacted image is rendered exactly as the extension renders it, then read back",
              "with OCR. `Recovered` counts ground-truth values still legible afterwards.", "",
              "| Page | Chars still readable | PII found in redacted image | **Recovered** |",
              "|---|---|---|---|"]
    for r in report["pages"] + report.get("holdout", []):
        leak = r.get("leak") or {}
        lines.append(
            f"| `{r['page']}.html` | {leak.get('charsRecoverable', '—')} | "
            f"{leak.get('piiFindingsInRedactedImage', '—')} | **{leak.get('leaked', '—')}** |"
        )

    lines += ["", "## Client resources", "", "| Asset | Size |", "|---|---|"]
    for key, value in report["assets"].items():
        lines.append(f"| {key.replace('_', ' ')} | {mb(value)} |")

    gpu = next((p.get("gpu") for p in report["pages"] if p.get("gpu")), {}) or {}
    lines += ["", "### Face detector, by backend", ""]
    if gpu.get("software"):
        lines += [
            "> **These WebGPU numbers are from a software adapter** "
            f"(`{gpu.get('vendor')}` / `{gpu.get('architecture') or gpu.get('description')}`), which is what a",
            "> headless browser provides. It is far slower than the WASM path and is not what a real",
            "> GPU does — on a real adapter WebGPU measured ~50 ms p50 against WASM's ~181 ms.",
            "> Run with `--headed` on a machine with a GPU for a meaningful comparison.",
            "",
        ]
    elif gpu.get("available"):
        lines += [f"Adapter: `{gpu.get('vendor')}` / `{gpu.get('architecture') or gpu.get('description')}`.", ""]
    lines += ["| Requested | Actually used | Session load | Inference p50 | Min | Max | First run |",
              "|---|---|---|---|---|---|---|"]
    for row in report["backends"]:
        if "error" in row:
            lines.append(f"| {row['requested']} | unavailable | — | — | — | — | — |")
            continue
        warm = sorted(row["warm"]) or [0]
        used = row["backend"]
        if row.get("requested") != used:
            used = f"{used} *(fell back)*"
        lines.append(
            f"| {row['requested']} | {used} | {row['loadMs']:.0f} ms | {statistics.median(warm):.0f} ms | "
            f"{min(warm):.0f} ms | {max(warm):.0f} ms | {row['firstInference']:.0f} ms |"
        )
    fallback = next((r.get("webgpuError") for r in report["backends"] if r.get("webgpuError")), None)
    if fallback:
        lines += ["", f"Fallback reason: `{fallback}`."]

    lines += ["", "## Latency", "",
              "The per-step cost the product actually pays. The harness's own total is excluded:",
              "it runs the pipeline twice and then OCRs the whole frame for the leak test, which",
              "the extension never does.", "",
              "`Cold` is the first look at a page. `Warm` is every step after it: the images have",
              "not changed, so OCR comes from cache — which is what a multi-step task actually pays.",
              "",
              "| Page | DOM snapshot | Detect + fuse | Vision | OCR | **Cold** | **Warm** |",
              "|---|---|---|---|---|---|---|"]
    for r in report["pages"]:
        t = r["timings"]
        lines.append(
            f"| `{r['page']}.html` | {t['snapshotMs']} ms | {t['detectMs']} ms | "
            f"{t.get('visionMs', '—')} ms | {t.get('ocrMs', '—')} ms | "
            f"**{t.get('pipelineMs', '—')} ms** | **{t.get('warmPipelineMs', '—')} ms** |"
        )

    return "\n".join(lines) + "\n"


def aggregate(pages: list[dict]) -> dict:
    tp = sum(p["withVision"]["tp"] for p in pages)
    fp = sum(p["withVision"]["fp"] for p in pages)
    fn = sum(p["withVision"]["fn"] for p in pages)
    precision = None if tp + fp == 0 else tp / (tp + fp)
    recall = None if tp + fn == 0 else tp / (tp + fn)
    return {
        "groundTruth": sum(p["withVision"]["groundTruth"] for p in pages),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": None if not (precision and recall) else 2 * precision * recall / (precision + recall),
        "leaked": sum((p.get("leak") or {}).get("leaked", 0) for p in pages),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "eval/results")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    if not BUNDLE.exists():
        raise SystemExit(
            f"{BUNDLE.relative_to(ROOT)} is missing.\n"
            "Build it first:  cd extension && npm run build:domcheck"
        )

    args.out.mkdir(parents=True, exist_ok=True)

    with serve(ROOT) as base, sync_playwright() as pw:
        # WebGPU in headless Chromium needs to be asked for explicitly.
        browser = pw.chromium.launch(
            headless=not args.headed,
            args=["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"],
        )
        context = browser.new_context(
            viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]}, device_scale_factor=2
        )
        page = context.new_page()

        print("measuring pages…")
        pages = measure_pages(page, base)
        print("measuring the holdout (pages no rule was written against)…")
        holdout = measure_pages(page, base, HOLDOUT, "eval/holdout")
        print("benchmarking backends…")
        backends = benchmark_backends(page, base)

        context.close()
        browser.close()

    report = {
        "pages": pages,
        "aggregate": aggregate(pages),
        "holdout": holdout,
        "holdoutAggregate": aggregate(holdout),
        "assets": asset_sizes(),
        "backends": backends,
    }
    (args.out / "results.json").write_text(json.dumps(report, indent=2))
    (args.out / "RESULTS.md").write_text(build_markdown(report))

    agg = report["aggregate"]
    hold = report["holdoutAggregate"]
    print(
        f"\ndemo site  precision {fmt(agg['precision'])}  recall {fmt(agg['recall'])}  "
        f"f1 {fmt(agg['f1'])}  over {agg['groundTruth']} items\n"
        f"holdout    precision {fmt(hold['precision'])}  recall {fmt(hold['recall'])}  "
        f"f1 {fmt(hold['f1'])}  over {hold['groundTruth']} items\n"
        f"leak test: {agg['leaked'] + hold['leaked']} ground-truth values recoverable "
        f"from the redacted images\n"
        f"wrote {args.out / 'RESULTS.md'}"
    )


if __name__ == "__main__":
    main()
