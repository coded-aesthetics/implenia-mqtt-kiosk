#!/usr/bin/env bash
# Push the working tree's build straight to a provisioned kiosk over SSH.
#
#     ./scripts/deploy-kiosk.sh kiosk@kiosk-g08.local
#
# For iterating on the machine itself. The release path (tag, CI, stick or
# update check) is the right way to ship, but it is minutes per round trip, and
# some things — a keyboard under a gloved finger, a layout at 1024x768 — can
# only be judged on the real screen.
#
# It ships `server/dist`, `server/assets` and `ui/dist` and nothing else: no
# package.json, so the installed version string stays whatever was provisioned,
# and no node_modules, so dependencies are never half-replaced over the wire.
# Add a dependency and this is not enough — reprovision or npm install there.
#
# tar over ssh rather than rsync: a minimal Debian has no rsync, and the payload
# is a couple of MB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST=""
APP_DIR="/opt/kiosk"
PORT=3000
RUN_BUILD=1
RESTART_BROWSER=1

usage() {
  cat <<'USAGE'
Usage: ./scripts/deploy-kiosk.sh <user@host> [options]

  --app-dir PATH    Install location on the kiosk (default /opt/kiosk)
  --port N          Port to verify afterwards (default 3000)
  --no-build        Ship server/dist and ui/dist as they are
  --no-browser      Leave Chromium alone (it keeps showing the old UI)
  -h, --help        This text

The host is anything ssh understands — provisioning registers the machine with
avahi, so kiosk@kiosk-g08.local works on the same network.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)   APP_DIR="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --no-build)  RUN_BUILD=0; shift ;;
    --no-browser) RESTART_BROWSER=0; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; usage; exit 1 ;;
    *)           HOST="$1"; shift ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$HOST" ]] || { usage; exit 1; }

log "Checking $HOST"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "test -d '$APP_DIR/server' && test -f '$APP_DIR/package.json'" \
  || die "$HOST is not a provisioned kiosk (no $APP_DIR). Run scripts/provision-kiosk.sh on it first, or pass --app-dir."
ok "Reachable, $APP_DIR looks provisioned"

if [[ $RUN_BUILD -eq 1 ]]; then
  log "Build"
  (cd "$REPO_ROOT" && npm run build >/dev/null) || die "Build failed — nothing shipped."
  ok "server/dist and ui/dist built"
fi

log "Shipping"
# Extracting over the tree is what the updater does, so kiosk.db, .env,
# node_modules and the speech model are all left alone.
tar -czf - -C "$REPO_ROOT" server/dist server/assets ui/dist \
  | ssh "$HOST" "tar -xzf - -C '$APP_DIR'" \
  || die "Transfer failed."
ok "server/dist, server/assets, ui/dist"

log "Restarting"
ssh "$HOST" "pm2 restart kiosk-server --update-env >/dev/null" || die "PM2 restart failed. Check: ssh $HOST pm2 logs kiosk-server"
ok "kiosk-server restarted"

if [[ $RESTART_BROWSER -eq 1 ]]; then
  # The service worker precaches the UI, and the build is registered as
  # `prompt` — but with skipWaiting and clientsClaim, so a fresh load takes the
  # new build immediately. The ~/.xinitrc loop brings Chromium back in two
  # seconds; that loop is why killing it is safe rather than a black screen.
  ssh "$HOST" "pkill -u \$(id -un) chromium || true" >/dev/null 2>&1 || true
  ok "Chromium restarted — it reloads into the new UI"
fi

log "Verifying"
for _ in $(seq 1 20); do
  if ssh "$HOST" "curl -fsS -o /dev/null http://localhost:$PORT/status"; then
    ok "Server answers on $PORT"
    exit 0
  fi
  sleep 1
done
die "Server did not answer on $PORT within 20 s. Check: ssh $HOST pm2 logs kiosk-server"
