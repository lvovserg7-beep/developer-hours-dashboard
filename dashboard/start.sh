#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"

if [[ ! -f .env && ! -f odata.env ]]; then
  cp -f .env.example .env
  echo
  echo "Created .env. Enter 1C OData login and password, save the file, then re-run this script."
  echo "Do not use the Linux OS account. Use the OData publication user."
  echo
  if command -v "${EDITOR:-}" >/dev/null 2>&1; then
    "${EDITOR}" .env
  elif command -v nano >/dev/null 2>&1; then
    nano .env
  elif command -v vi >/dev/null 2>&1; then
    vi .env
  else
    echo "Open dashboard/.env in any editor, then run: ./start.sh"
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js LTS and ensure node is on PATH."
  exit 1
fi

free_port() {
  local pids=""
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}

while true; do
  echo "Stopping previous dashboard on port ${PORT} if it is running..."
  free_port
  sleep 1
  echo "Starting dashboard..."
  echo "Local:  http://localhost:${PORT}/"
  echo "On start: hours + SEO trailing (Ozon auto-refresh is off by default)."
  echo "If the process exits, it will restart in 5 seconds. Ctrl+C to stop."
  set +e
  node server.mjs
  EXITCODE=$?
  set -e
  echo
  echo "Dashboard exited with code ${EXITCODE}."
  if [[ "${EXITCODE}" -eq 401 ]]; then
    echo "Code 401 means OData login or password was rejected."
    echo "Set ODATA_DB_TRADE_* and ODATA_DB_ECOTIDY_* in dashboard/.env"
    exit 401
  fi
  echo "Restarting in 5 seconds..."
  sleep 5
done
