# One-command setup for Windows (PowerShell). On macOS and Linux use scripts/setup.sh.
#
# Installs every dependency fresh for this machine and builds the extension. Never
# copy node_modules between machines: some packages are native binaries built for
# one operating system, and a folder copied from a Mac does not run on Windows.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "$name not found - $hint"
  }
}
Need node 'install Node.js 20 or newer: https://nodejs.org'
Need npm 'it comes with Node.js'
Need uv 'install uv: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Write-Error "Node $nodeMajor found; 20 or newer is needed" }

function Run($where, $command) {
  Push-Location $where
  try {
    cmd /c $command
    if ($LASTEXITCODE -ne 0) { throw "failed in ${where}: $command" }
  } finally { Pop-Location }
}

Write-Host '-> extension: installing dependencies'
Run 'extension' 'npm ci'
Write-Host '-> extension: building for Chrome, Edge, Brave (chrome-mv3) and Firefox (firefox-mv3)'
Run 'extension' 'npm run build'
Run 'extension' 'npm run build:firefox'
Write-Host '-> server: installing'
Run 'server' 'uv sync --dev'
Write-Host '-> benchmarks: installing (optional)'
try { Run '.' 'uv sync'; Run '.' 'uv run playwright install chromium' } catch { Write-Host '  skipped - only needed for eval/' }

Write-Host @'

Done. Three terminals:

  python -m http.server 5173 --directory demo-site               # the demo pages
  cd server; uv run uvicorn app.main:app --port 8000             # the planner
  cd extension; npm run dev                                      # Chrome, with the extension loaded

Or load it into your own browser: chrome://extensions -> Developer mode ->
Load unpacked -> extension\.output\chrome-mv3   (Firefox: about:debugging ->
Load Temporary Add-on -> extension\.output\firefox-mv3\manifest.json)
'@
