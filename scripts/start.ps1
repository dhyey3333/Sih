# Start everything for a demo on Windows, each in its own window.
#
#   .\scripts\start.ps1                   demo pages, planner, Chrome with the extension
#   .\scripts\start.ps1 -Model qwen3-vl:4b-instruct   ...with a local vision model (Ollama)
#
# The planner runs with PLANNER_VIEW=1: open http://localhost:8000/view on a second
# screen to show what the server receives. Close a window to stop that part.
# (ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 without a BOM.)
param([string]$Model = '')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Open-Window($title, $where, $command) {
  $script = "`$Host.UI.RawUI.WindowTitle = '$title'; $command"
  Start-Process powershell -WorkingDirectory (Join-Path $root $where) -ArgumentList '-NoExit', '-NoProfile', '-Command', $script
}

Open-Window 'PrivAgent - demo pages' '.' 'uv run python -m http.server 5173 --directory demo-site'

$planner = "`$env:PLANNER_VIEW = '1'; "
if ($Model) {
  # rules-first + image auto: the settings measured to suit a laptop-class model.
  $planner += "`$env:VLM_BASE_URL = 'http://localhost:11434/v1'; `$env:VLM_MODEL = '$Model'; " +
              "`$env:VLM_STRATEGY = 'rules-first'; `$env:VLM_IMAGE = 'auto'; `$env:VLM_TIMEOUT = '120'; "
}
$planner += 'uv run uvicorn app.main:app --port 8000'
Open-Window 'PrivAgent - planner' 'server' $planner

Start-Sleep -Seconds 2
Open-Window 'PrivAgent - extension' 'extension' 'npm run dev'

Write-Host ''
Write-Host 'Started. Demo pages: http://localhost:5173   Server view: http://localhost:8000/view'
if ($Model) { Write-Host "Planner model: $Model (make sure Ollama is running and the model is pulled)" }
