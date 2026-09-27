# Setting up the Windows laptop (24 GB RAM, RTX 3050)

What this laptop is for: running the open-weights vision model **on a GPU** (the Mac runs
it at 7–30 s a step), running a **larger** model than the Mac can hold, **GPU training**
for the on-device models, and checking **Windows, Edge and Firefox** — none of which can
be tested from the Mac.

Budget about an hour, most of it downloads.

---

## 1. Install these first

| | Where | Check it worked |
|---|---|---|
| **NVIDIA driver** (recent) | GeForce Experience or nvidia.com/drivers | `nvidia-smi` prints the GPU |
| **Node.js 20 or newer** (LTS) | nodejs.org | `node -v` |
| **uv** (Python and packages) | in PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` | `uv --version` (in a **new** terminal) |
| **Ollama** | ollama.com/download | the llama icon in the tray |
| **Google Chrome** | google.com/chrome | — (Edge is already on Windows) |
| Firefox (optional) | mozilla.org | — |

Git is optional — the project arrives as a zip that already contains its history.

## 2. Copy the project over

1. Copy `PrivAgent.zip` (made on the Mac) to the laptop.
2. Unzip it to a **short path with no spaces**, e.g. `C:\privagent`. Not inside OneDrive,
   Desktop or Documents if those are synced: sync tools fight with `node_modules`.
3. The zip has no `node_modules`, `.venv` or build output, on purpose. Those are
   rebuilt for Windows in the next step — never copy them from the Mac.

## 3. Set it up

Double-click **`scripts\setup.cmd`**. Or, in PowerShell in `C:\privagent`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -PullModel -Train
```

- `-PullModel` downloads the vision model that fits the GPU it finds (3–6 GB).
- `-Train` installs GPU training — about 3 GB — and must end with `CUDA available: True`.
  If it says `False`, the NVIDIA driver is missing or too old.

It prints the model it chose. Rule of thumb for this laptop:

| GPU memory (`nvidia-smi`) | Start with | Then try, for quality |
|---|---|---|
| 4 GB | `qwen3-vl:4b-instruct` (3.3 GB, fits) | `qwen3-vl:8b-instruct` (6.1 GB, runs split between GPU and RAM — slower) |
| 6 GB | `qwen3-vl:4b-instruct` | `qwen3-vl:8b-instruct` (mostly on the GPU) |

Always the **`-instruct`** versions: the `-thinking` ones spend seconds reasoning before
every single step.

## 4. Run these, in order

Each one answers a question we cannot answer from the Mac. Run them in PowerShell from
`C:\privagent`.

**a. The baseline** — no model at all. Must be 19 / 19, as on the Mac:

```powershell
uv run python -m eval.run_tasks
```

**b. The small model on the GPU** — how fast a step is with a GPU:

```powershell
uv run python -m eval.run_tasks --vlm ollama --model qwen3-vl:4b-instruct --strategy rules-first --image auto
```

**c. The larger model** — whether it fixes the two tasks the 3B misses:

```powershell
ollama pull qwen3-vl:8b-instruct
```
```powershell
uv run python -m eval.run_tasks --vlm ollama --model qwen3-vl:8b-instruct --strategy rules-first --image auto
```

**d. The model doing everything** — every step decided by the model, the screenshot
always attached. The hardest test; slow, run it last:

```powershell
uv run python -m eval.run_tasks --vlm ollama --model qwen3-vl:8b-instruct --strategy vlm-first --image always
```

**e. Edge** — the packed extension boots clean in Edge:

```powershell
uv run python -m eval.smoke_extension --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

**f. The detection numbers on Windows** — should match the Mac (precision 1.000, leak test 0):

```powershell
uv run python -m eval.run_all
```

## 5. What to send back

Zip and send:

- the whole `eval\results\` folder (every run writes a file there, named by model);
- the output of `nvidia-smi`;
- anything that printed an error, copied as text.

Or, if Git is installed there, commit on the laptop and send the repository back — it is
the same history.

## 6. Demo day on this laptop

```powershell
.\scripts\start.ps1 -Model qwen3-vl:4b-instruct
```

opens three windows — demo pages, planner, Chrome with the extension — and the server's
live view at `http://localhost:8000/view` for the second screen. Without `-Model` it uses
the rule-based planner, which needs no GPU and no internet. Load the demo profile in the
side panel and follow `docs/DEMO.md`.

## 7. If something goes wrong

| Symptom | Fix |
|---|---|
| "running scripts is disabled on this system" | use `scripts\setup.cmd`, or the `powershell -ExecutionPolicy Bypass -File …` form above |
| `uv` or `node` "is not recognized" | close the terminal and open a new one after installing |
| Windows SmartScreen blocks `setup.cmd` | More info → Run anyway (it only runs `setup.ps1`) |
| `npm ci` is very slow or fails with EPERM | antivirus scanning `node_modules` — exclude `C:\privagent`, or pause it for the install |
| Planner falls back to "rule-based" with "VLM timed out" | Ollama not running (tray icon), or the model not pulled — `ollama list` |
| Steps are slow and `ollama ps` shows a high CPU % | the model does not fit the GPU; use the 4B |
| Out-of-memory in Ollama | close other GPU apps (games, browsers with many tabs), or use the 4B |
| `CUDA available: False` after `-Train` | update the NVIDIA driver, then run `setup.ps1 -Train` again |
| The extension's side panel is blank | `uv run python -m eval.smoke_extension` says why in 20 seconds |
| The Edge smoke test (4e) times out | recent branded browsers can refuse extensions loaded from the command line; load it by hand — `edge://extensions` → Developer mode → Load unpacked → `extension\.output\chrome-mv3` — and open the side panel on a demo page |

Every setting the planner reads is documented in `server\.env.example`; copy it to
`server\.env` to set them permanently.
