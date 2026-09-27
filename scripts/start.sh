#!/usr/bin/env bash
# Start everything for a demo on macOS or Linux. Ctrl-C stops all of it.
#
#   ./scripts/start.sh                          demo pages, planner, Chrome with the extension
#   ./scripts/start.sh qwen2.5vl:3b             ...with a local vision model (Ollama)
#
# The planner runs with PLANNER_VIEW=1: open http://localhost:8000/view on a second
# screen to show what the server receives.
set -euo pipefail
cd "$(dirname "$0")/.."
model="${1:-}"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

uv run python -m http.server 5173 --directory demo-site >/dev/null 2>&1 &
pids+=($!)

(
  cd server
  export PLANNER_VIEW=1
  if [ -n "$model" ]; then
    # rules-first + image auto: the settings measured to suit a laptop-class model.
    export VLM_BASE_URL=http://localhost:11434/v1 VLM_MODEL="$model" \
           VLM_STRATEGY=rules-first VLM_IMAGE=auto VLM_TIMEOUT=120
  fi
  exec uv run uvicorn app.main:app --port 8000
) &
pids+=($!)

echo "Demo pages: http://localhost:5173   Server view: http://localhost:8000/view"
[ -n "$model" ] && echo "Planner model: $model (Ollama must be running with it pulled)"
sleep 2
cd extension && npm run dev
