#!/usr/bin/env bash
# Runs on the VPS (piped over ssh by .semaphore/deploy.yml, or run by the Semaphore UI template via deploy/bump.yml).
# Pulls both repos, installs dependencies, restarts bump-backend, and waits for /api/health.
# Touches only the bump service: other apps on the box are never restarted.
set -euo pipefail

BUMP_DIR="${BUMP_DIR:-$HOME/bump}"
BUN="${BUN:-/usr/local/bin/bun}"
PORT="${BUMP_PORT:-7000}"

# `bun install` can rewrite bun.lock on the server (newer bun, a workspace the committed lockfile did not list yet).
# That is never a deliberate edit, and a dirty lockfile makes the next `git pull --ff-only` refuse. Drop it first.
pull() {
  git checkout -- bun.lock 2>/dev/null || true
  git pull --ff-only
}

echo "==> bump-packages"
cd "$BUMP_DIR/bump-packages"
pull
"$BUN" install

echo "==> bump-backend"
cd "$BUMP_DIR/bump-backend"
pull
"$BUN" install

echo "==> restart bump-backend"
sudo systemctl restart bump-backend.service

echo "==> health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health"; then
    echo
    echo "deploy ok: $(git -C "$BUMP_DIR/bump-backend" rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

echo "health check failed; recent logs:" >&2
sudo journalctl -u bump-backend -n 40 --no-pager >&2
exit 1
