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
#         deploy/deploy.sh --dry-run [git-ref] check prerequisites, print the plan, run the server tests on the current checkout; changes nothing
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
  (cd "$DATA" && tar czf "$out" $(ls -d config.json* accounts users inbox.json machines.json history.json 2>/dev/null)); chmod 600 "$out"; echo "$out"
}
healthy() { for _ in 1 2 3 4 5 6; do sleep 2; curl -fsS "$HEALTH" >/dev/null 2>&1 && return 0; done; return 1; }
build_web() { [ "${FOXFLEET_SKIP_WEB:-}" = 1 ] && return 0; (cd web && "$NPM" ci --no-audit --no-fund && "$NPM" run build); }

if [ "${1:-}" = "--dry-run" ]; then
  REF="${2:-origin/main}"; bad=0
  need() { command -v "$1" >/dev/null 2>&1 && echo "ok       $1" || { echo "MISSING  $1"; bad=1; }; }
  echo "== prerequisites"; for c in git curl tar "$NODE" "$NPM" systemctl; do need "$c"; done
  "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' && echo "ok       node >= 22" || { echo "WARN     node < 22 (CI and the Docker image use 22)"; }
  [ -d "$SRC/.git" ] && echo "ok       checkout $SRC" || { echo "MISSING  git checkout at \$FOXFLEET_SRC"; bad=1; }
  [ -d "$DATA" ] && [ -w "$DATA" ] && echo "ok       data dir is writable" || { echo "MISSING  writable data dir (\$FOXFLEET_DATA)"; bad=1; }
  echo "== plan for $REF"; printf '  %s\n' "git fetch origin" "backup config.json* accounts/ users/ inbox.json -> $BACKUPS (0600)" "git checkout --detach $REF" "node --test server/test/*.test.js   (abort + restore on failure)" "web: npm ci && npm run build   (abort + restore on failure)" "systemctl --user restart $UNIT" "poll $HEALTH   (automatic rollback on failure)"
  echo "== server tests on the current checkout (read-only)"; "$NODE" --test server/test/*.test.js >/tmp/foxfleet-dryrun.log 2>&1 && echo "ok       tests pass (log: /tmp/foxfleet-dryrun.log)" || { echo "FAIL     tests (see /tmp/foxfleet-dryrun.log)"; bad=1; }
  [ "$bad" = 0 ] && echo "Dry run OK: nothing was changed." || { echo "Dry run found problems: nothing was changed."; exit 1; }
  exit 0
fi

if [ "${1:-}" = "--rollback" ]; then
  PREV="${2:?previous git ref}"
  LAST="$(ls -1t "$BACKUPS"/pre-deploy-*.tar.gz 2>/dev/null | head -1 || true)"
  systemctl --user stop "$UNIT" || true
  if [ -n "$LAST" ]; then
    # Keep what the new version wrote aside, then put the pre-deploy state back.
    (cd "$DATA" && tar czf "$BACKUPS/rolled-back-$(date +%Y%m%d%H%M%S).tar.gz" $(ls -d config.json* accounts users inbox.json machines.json history.json 2>/dev/null)) || true
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
