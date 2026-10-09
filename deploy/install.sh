#!/bin/sh
# Foxfleet installer: puts the `foxfleet` command on your PATH from a release tarball (checksum-verified).
#   curl -fsSL https://raw.githubusercontent.com/TinkerDoge/FoxFleet/main/deploy/install.sh | sh
# Read it first if you like; it only writes under your home folder and never needs root.
# Options (environment):
#   FOXFLEET_VERSION   release to install, e.g. 0.2.1-alpha            (default: the newest release, pre-releases included)
#   FOXFLEET_REPO      GitHub owner/name                               (default: TinkerDoge/FoxFleet)
#   FOXFLEET_APPS_DIR  where versions are unpacked                     (default: ~/.local/share/foxfleet-app)
#   FOXFLEET_BIN_DIR   where the `foxfleet` link goes                  (default: ~/.local/bin)
#   FOXFLEET_API       releases API base (for mirrors and tests)       (default: https://api.github.com/repos/$REPO)
# Later updates: `foxfleet update`.
set -eu
REPO="${FOXFLEET_REPO:-TinkerDoge/FoxFleet}"
API="${FOXFLEET_API:-https://api.github.com/repos/$REPO}"
APPS="${FOXFLEET_APPS_DIR:-$HOME/.local/share/foxfleet-app}"
BIN="${FOXFLEET_BIN_DIR:-$HOME/.local/bin}"
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need curl; need tar; need node
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is required (found $(node -v))"
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SUM="shasum -a 256"; else die "sha256sum or shasum is required"; fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -n "${FOXFLEET_VERSION:-}" ]; then V="${FOXFLEET_VERSION#v}"; TAG="v$V"
else
  say "Looking up the newest release…"
  curl -fsSL -H 'Accept: application/vnd.github+json' "$API/releases?per_page=20" -o "$TMP/releases.json" || die "could not reach $API"
  TAG="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).filter(x=>!x.draft&&/^v?\d+\.\d+\.\d+/.test(x.tag_name));const k=(t)=>{const m=/(\d+)\.(\d+)\.(\d+)(-.*)?/.exec(t);return [+m[1],+m[2],+m[3],m[4]?0:1,m[4]||""]};r.sort((a,b)=>{const x=k(a.tag_name),y=k(b.tag_name);for(let i=0;i<4;i++)if(x[i]!==y[i])return y[i]-x[i];return y[4]<x[4]?-1:y[4]>x[4]?1:0});if(!r[0])process.exit(1);console.log(r[0].tag_name)' "$TMP/releases.json")" || die "no releases found"
  V="${TAG#v}"
fi
BASE="${FOXFLEET_DOWNLOAD:-https://github.com/$REPO/releases/download/$TAG}"
say "Installing Foxfleet $V"
curl -fsSL "$BASE/foxfleet-server-$V.tar.gz" -o "$TMP/server.tar.gz" || die "download failed: foxfleet-server-$V.tar.gz (is $TAG published with that file?)"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "download failed: SHA256SUMS"
WANT="$(grep " \*\{0,1\}foxfleet-server-$V.tar.gz\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -1)"
[ -n "$WANT" ] || die "SHA256SUMS does not list foxfleet-server-$V.tar.gz"
GOT="$($SUM "$TMP/server.tar.gz" | awk '{print $1}')"
[ "$WANT" = "$GOT" ] || die "checksum mismatch: the download is corrupt or has been tampered with. Nothing was installed."
say "Checksum OK."

mkdir -p "$APPS" "$BIN"
rm -rf "$APPS/$V.new"; mkdir -p "$APPS/$V.new"
tar -xzf "$TMP/server.tar.gz" -C "$APPS/$V.new" --strip-components=1
[ -f "$APPS/$V.new/server/index.js" ] || die "the tarball does not look like a Foxfleet server release"
rm -rf "$APPS/$V"; mv "$APPS/$V.new" "$APPS/$V"
ln -sfn "$APPS/$V" "$APPS/current.tmp" && mv -T "$APPS/current.tmp" "$APPS/current" 2>/dev/null || { rm -f "$APPS/current"; ln -s "$APPS/$V" "$APPS/current"; }
chmod +x "$APPS/$V/server/bin/foxfleet"
ln -sfn "$APPS/current/server/bin/foxfleet" "$BIN/foxfleet"
say "Installed to $APPS/$V; command: $BIN/foxfleet"
case ":$PATH:" in *":$BIN:"*) ;; *) say "Add it to your PATH:  export PATH=\"$BIN:\$PATH\"   (put that line in ~/.profile)";; esac
say "Next:  foxfleet doctor    then    foxfleet setup --show-code   (first run)"
