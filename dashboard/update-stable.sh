#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

TAG="${1:-}"
if [[ -z "${TAG}" && -f STABLE ]]; then
  TAG="$(tr -d '\r' < STABLE | sed 's/^\xEF\xBB\xBF//' | head -n1 | tr -d '[:space:]')"
fi

if [[ -z "${TAG}" ]]; then
  echo "No stable tag. Pass it: ./update-stable.sh v1.14.0"
  exit 1
fi

if [[ ! -d .git ]]; then
  echo "This folder is not a git clone (ZIP copy)."
  echo "One-time on the production Linux host:"
  echo "  1. Stop start.sh or: sudo systemctl stop developer-hours-dashboard"
  echo "  2. Copy dashboard/.env and dashboard/users.json aside"
  echo "  3. Rename this folder (example: developer-hours-dashboard.bak)"
  echo "  4. git clone --branch ${TAG} https://github.com/lvovserg7-beep/developer-hours-dashboard.git"
  echo "  5. Copy .env and users.json back into dashboard/"
  echo "  6. Run dashboard/start.sh or enable the systemd unit"
  echo "Do not unpack a ZIP from the Cursor project folder."
  exit 1
fi

echo "Fetching tags..."
git fetch --tags origin

echo "Checking out ${TAG} ..."
git checkout --force "${TAG}"

echo "Now at ${TAG}. dashboard/.env and dashboard/users.json stay local (not in git)."

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet developer-hours-dashboard 2>/dev/null; then
  echo "Restarting systemd service developer-hours-dashboard..."
  sudo systemctl restart developer-hours-dashboard
  echo "Service restarted."
else
  echo "Start the app: dashboard/start.sh"
  echo "Or: sudo systemctl restart developer-hours-dashboard"
fi
