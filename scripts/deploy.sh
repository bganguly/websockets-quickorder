#!/usr/bin/env bash
set -euo pipefail

# Start the Quick Order app. Requires the dashboard backend to be running first.
# Override the dashboard URL with BACKEND_URL (default: http://localhost:3004).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_URL="${BACKEND_URL:-http://localhost:3004}"
export BACKEND_URL

# Kill any existing Quick Order process on 3005.
if lsof -ti:3005 >/dev/null 2>&1; then
  echo "Stopping existing Quick Order process on :3005..."
  kill "$(lsof -ti:3005)" 2>/dev/null || true
  sleep 1
fi

echo ""
echo "[1/2] Installing dependencies..."
npm install --prefer-offline

echo ""
echo "[2/2] Building and starting Quick Order on http://localhost:3005"
echo "      BACKEND_URL=$BACKEND_URL"
npm run build
npm run start
