#!/usr/bin/env bash
# One-command setup for macOS and Linux. On Windows use scripts/setup.ps1.
#
# Installs every dependency fresh for this machine and builds the extension. Never
# copy node_modules between machines: some packages are native binaries built for
# one operating system, and a folder copied from a Mac does not run on Windows.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 not found — $2" >&2; exit 1; }; }
need node "install Node.js 20 or newer: https://nodejs.org"
need npm "it comes with Node.js"
need uv "install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then echo "✗ Node $node_major found; 20 or newer is needed" >&2; exit 1; fi

echo "→ extension: installing dependencies"
(cd extension && npm ci)
echo "→ extension: building for Chrome, Edge, Brave (chrome-mv3) and Firefox (firefox-mv3)"
(cd extension && npm run build && npm run build:firefox)
echo "→ server: installing"
(cd server && uv sync --dev)
echo "→ benchmarks: installing (optional)"
if uv sync && uv run playwright install chromium; then :; else echo "  skipped — only needed for eval/"; fi

cat <<'EOF'

Done. Three terminals:

  python3 -m http.server 5173 --directory demo-site                          # the demo pages
  cd server && uv run uvicorn app.main:app --port 8000                       # the planner
  cd extension && npm run dev                                                # Chrome, with the extension loaded

Or load it into your own browser: chrome://extensions → Developer mode →
Load unpacked → extension/.output/chrome-mv3   (Firefox: about:debugging →
Load Temporary Add-on → extension/.output/firefox-mv3/manifest.json)
EOF
