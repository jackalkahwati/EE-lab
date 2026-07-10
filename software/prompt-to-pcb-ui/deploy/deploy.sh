#!/usr/bin/env bash
# Run ON the Oracle VM to (re)deploy Compose. Idempotent.
#   cd ~/EE-lab/software/prompt-to-pcb-ui && ./deploy/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> Pulling latest"
git pull --ff-only

echo "==> Installing deps (ci = lockfile-exact)"
npm ci

echo "==> Ensuring persistent data dirs exist (survive redeploys)"
mkdir -p data public/runs

echo "==> Building production bundle"
npm run build

echo "==> Restarting service"
sudo systemctl restart firstlight-compose
sleep 2
sudo systemctl --no-pager status firstlight-compose | head -5

echo "==> Local health check (loopback)"
curl -fsS -o /dev/null -w "compose 127.0.0.1:4500 -> %{http_code}\n" http://127.0.0.1:4500/login \
  || echo "WARN: local health check failed — check: journalctl -u firstlight-compose -n 50"

echo "==> Done."
