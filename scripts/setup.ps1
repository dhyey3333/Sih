# One-command setup for Windows (PowerShell). On macOS and Linux use scripts/setup.sh.
#
#   .\scripts\setup.ps1                  install everything and build the extension
#   .\scripts\setup.ps1 -PullModel       also download the vision model that fits this GPU
#   .\scripts\setup.ps1 -Train           also install GPU training (CUDA PyTorch, ~3 GB)
#
# If Windows says "running scripts is disabled", double-click scripts\setup.cmd, or run
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#
# Installs every dependency fresh for this machine. Never copy node_modules or .venv
# between machines: some packages are native binaries built for one operating system.
# (This file is ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 without a BOM.)
param([switch]$PullModel, [switch]$Train)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "MISSING: $name - $hint" -ForegroundColor Red
    exit 1
  }
}
Need node 'install Node.js 20 or newer: https://nodejs.org'
Need npm 'it comes with Node.js'
Need uv 'install uv: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"  (then open a new terminal)'
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Write-Host "Node $nodeMajor found; 20 or newer is needed" -ForegroundColor Red; exit 1 }

# Commands are script blocks, run directly - not strings through cmd /c, whose quoting
# rules and PowerShell 5.1's argument passing disagree in ways that break silently.
function Run($where, [scriptblock]$block) {
  Push-Location $where
  try {
    $global:LASTEXITCODE = 0
    & $block
    if ($LASTEXITCODE -ne 0) { throw "failed in ${where}: $block" }
  } finally { Pop-Location }
}

Write-Host '-> extension: installing dependencies'
Run 'extension' { npm ci }
Write-Host '-> extension: building for Chrome, Edge, Brave (chrome-mv3) and Firefox (firefox-mv3)'
Run 'extension' { npm run build }
Run 'extension' { npm run build:firefox }
Write-Host '-> server: installing'
Run 'server' { uv sync --dev }
Write-Host '-> benchmarks: installing'
Run '.' { uv sync }
Run '.' { uv run playwright install chromium }
Run 'extension' { npm run build:domcheck }

# ---- The GPU, and the model that fits it --------------------------------------------
$model = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $gpu = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits) | Select-Object -First 1
  $parts = $gpu -split ','
  $vramMB = [int]($parts[1].Trim())
  Write-Host ("-> GPU: {0}, {1} GB" -f $parts[0].Trim(), [math]::Round($vramMB / 1024, 1))
  # Sizes from the Ollama library: qwen3-vl:4b-instruct 3.3 GB, qwen3-vl:8b-instruct 6.1 GB.
  # The 8B still runs on a smaller card, split between GPU and system RAM - just slower.
  if ($vramMB -ge 7000) { $model = 'qwen3-vl:8b-instruct' } else { $model = 'qwen3-vl:4b-instruct' }
} else {
  Write-Host '-> no NVIDIA GPU found (nvidia-smi missing); a model will run on the CPU, slowly'
  $model = 'qwen3-vl:4b-instruct'
}

if ($PullModel) {
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "-> downloading $model"
    Run '.' { ollama pull $model }
  } else {
    Write-Host 'MISSING: ollama - install it from https://ollama.com/download, then run this again with -PullModel' -ForegroundColor Yellow
  }
}

if ($Train) {
  Write-Host '-> ml: installing training (CUDA PyTorch on this machine)'
  Run 'ml' { uv sync --group train --group dev }
  Run 'ml' { uv run python -c "import torch; print('CUDA available:', torch.cuda.is_available())" }
}

Write-Host @"

Done. To run it, three terminals from this folder (or run scripts\start.ps1):

  uv run python -m http.server 5173 --directory demo-site         # the demo pages
  cd server; uv run uvicorn app.main:app --port 8000              # the planner
  cd extension; npm run dev                                       # Chrome, with the extension loaded

Or load it into your own browser: chrome://extensions (or edge://extensions) ->
Developer mode -> Load unpacked -> extension\.output\chrome-mv3

The vision model for this machine: $model
  ollama pull $model
  uv run python -m eval.run_tasks --vlm ollama --model $model --strategy rules-first --image auto

What to send back is in docs\NEW_LAPTOP.md.
"@
