#!/usr/bin/env bash
# Foxfleet deploy for a systemd (user) install. Run ON the hub host.
# Site-specific values come from the environment or a gitignored deploy/deploy.local.env (never commit real hosts):
#   FOXFLEET_SRC      git checkout of this repo                      (default: $HOME/foxfleet)
#   FOXFLEET_DATA     data dir (config.json, accounts/, users/, ...)  (default: $HOME/.local/share/foxfleet)
#   FOXFLEET_HEALTH   health URL as seen from this host              (default: http://127.0.0.1:3080/health)
#   FOXFLEET_UNIT     systemd --user unit name                       (default: foxfleet)
#   NODE / NPM        binaries                                       (default: node / npm)
#   FOXFLEET_SKIP_WEB=1  skip the web build (when dist/ is shipped prebuilt)
# Usage:  deploy/deploy.sh [git-ref]            deploy (default origin/main)
#         deploy/deploy.sh --rollback <ref>     restore the latest pre-deploy backup and that code
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/deploy.local.env" ] && . "$HERE/deploy.local.env"
SRC="${FOXFLEET_SRC:-$HOME/foxfleet}"
DATA="${FOXFLEET_DATA:-$HOME/.local/share/foxfleet}"
HEALTH="${FOXFLEET_HEALTH:-http://127.0.0.1:3080/health}"
UNIT="${FOXFLEET_UNIT:-foxfleet}"
NODE="${NODE:-node}"; NPM="${NPM:-npm}"
BACKUPS="${FOXFLEET_BACKUPS:-$DATA/backups}"
cd "$SRC"

backup_data() { # config.json (+ .bak files), accounts/, users/, inbox.json -> one 0600 tarball
  mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
  local out="$BACKUPS/pre-deploy-$(date +%Y%m%d%H%M%S).tar.gz"
  (cd "$DATA" && tar czf "$out" $(ls -d config.json* accounts users inbox.json 2>/dev/null)); chmod 600 "$out"; echo "$out"
}
healthy() { for _ in 1 2 3 4 5 6; do sleep 2; curl -fsS "$HEALTH" >/dev/null 2>&1 && return 0; done; return 1; }
build_web() { [ "${FOXFLEET_SKIP_WEB:-}" = 1 ] && return 0; (cd web && "$NPM" ci --no-audit --no-fund && "$NPM" run build); }

if [ "${1:-}" = "--rollback" ]; then
  PREV="${2:?previous git ref}"
  LAST="$(ls -1t "$BACKUPS"/pre-deploy-*.tar.gz 2>/dev/null | head -1 || true)"
  systemctl --user stop "$UNIT" || true
  if [ -n "$LAST" ]; then
    # Keep what the new version wrote aside, then put the pre-deploy state back.
    (cd "$DATA" && tar czf "$BACKUPS/rolled-back-$(date +%Y%m%d%H%M%S).tar.gz" $(ls -d config.json* accounts users inbox.json 2>/dev/null)) || true
    (cd "$DATA" && rm -rf accounts users && tar xzf "$LAST")
  fi
  git checkout --detach "$PREV"; build_web || true; systemctl --user start "$UNIT"
  healthy && { curl -fsS "$HEALTH"; echo; echo "Rolled back to $PREV (data from ${LAST:-none})"; } || { echo "Health check FAILED after rollback"; exit 1; }
  exit 0
fi

REF="${1:-origin/main}"
git fetch origin
PREV="$(git rev-parse HEAD)"; echo "Current: $PREV  ->  target: $REF"
echo "== backup"; BK="$(backup_data)"; echo "$BK"
git checkout --detach "$REF"
echo "== tests (must be green before restart)"
if ! "$NODE" --test server/test/*.test.js; then
  echo "Tests failed; restoring worktree to $PREV (service untouched)"; git checkout --detach "$PREV"; exit 1
fi
echo "== web build"
if ! build_web; then echo "Web build failed; restoring $PREV (service untouched)"; git checkout --detach "$PREV"; exit 1; fi
echo "== restart"
systemctl --user restart "$UNIT"
if ! healthy; then echo "Health check failed; rolling back to $PREV"; "$0" --rollback "$PREV"; exit 1; fi
curl -fsS "$HEALTH"; echo
cat <<TXT

Deployed $REF (backup: $BK).

FIRST-RUN OWNER SETUP (nobody can sign in until an owner exists):
  Option A: set FOXFLEET_PASSWORD in the unit's env file once; the owner "owner" is created from it on start. Sign in, change the
            password under Settings > Devices & security, then remove FOXFLEET_PASSWORD.
  Option B (recommended): leave FOXFLEET_PASSWORD unset. Read the one-time setup code from the log
            ( journalctl --user -u $UNIT | grep 'setup code' ), open the hub in a browser or the app, and create the owner.
  Then: Admin > registration (closed by default) and Admin > Pair a phone (shows a foxfleet://connect QR).
TXT
