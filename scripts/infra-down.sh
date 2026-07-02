#!/usr/bin/env bash
set -euo pipefail

# Stop the Quick Order process. No AWS resources to destroy.

if lsof -ti:3005 >/dev/null 2>&1; then
  echo "Stopping Quick Order process on :3005..."
  kill "$(lsof -ti:3005)" 2>/dev/null || true
  echo "Done."
else
  echo "No Quick Order process found on :3005."
fi
