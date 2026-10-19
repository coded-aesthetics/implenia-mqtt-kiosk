#!/usr/bin/env bash
# Build a release bundle from the working tree, in the layout CI produces.
#
#     ./scripts/make-bundle.sh
#
# The GitHub release is the normal way code reaches a kiosk. This exists for a
# machine that needs code which is not tagged yet — a pilot kiosk, or the first
# install of a branch being iterated on — without waiting for a tag and a CI
# run. It runs lint and the test suites first, because the thing it produces
# gets installed on a machine where a broken deploy costs a shift.
#
# The bundle it writes is a valid USB update too (`USB_UPDATE_PATHS`), so the
# same file can be dropped on a stick for a kiosk that is already running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_DIR="$REPO_ROOT/dist-bundle"
VERSION=""
RUN_BUILD=1
RUN_TESTS=1

usage() {
  cat <<'USAGE'
Usage: ./scripts/make-bundle.sh [options]

  --out DIR        Where to write the bundle (default ./dist-bundle)
  --version V      Override the derived version (no leading "v")
  --no-build       Use the existing server/dist and ui/dist as they are
  --skip-tests     Skip lint and the test suites
  -h, --help       This text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT_DIR="$2"; shift 2 ;;
    --version)    VERSION="$2"; shift 2 ;;
    --no-build)   RUN_BUILD=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

#
# Next minor plus a prerelease tail.
#
# It has to sort **above** the newest real release and **below** the eventual
# release of that minor. Above, because the self-updater compares semver against
# the installed version: stamping this 0.2.0 or lower would have a kiosk running
# today's code offered April's tag as an "update" and quietly downgraded. Below,
# because the real v0.3.0 must still supersede it.
#
# `app-v<version>.tar.gz` stays parseable by the updater's own TAR_PATTERN,
# which accepts a `-prerelease` of alphanumerics and dots.
#
derive_version() {
  local last base major minor n sha dirty=""
  # The highest tag in the repo, not `git describe`. describe only considers
  # tags **reachable from HEAD**, and v0.2.0 sits off this line of history — so
  # it answered v0.1.0 and the derived version came out 0.2.0-dev.81, *below*
  # the published v0.2.0. A kiosk installed with that would have been offered
  # April's release as an update and quietly downgraded: exactly what the next
  # minor is here to prevent.
  last="$(git -C "$REPO_ROOT" tag --list 'v[0-9]*' --sort=-v:refname | head -n1)"
  [[ -n "$last" ]] || last="v0.0.0"
  base="${last#v}"
  IFS=. read -r major minor _ <<< "$base"
  n="$(git -C "$REPO_ROOT" rev-list --count "${last}..HEAD" 2>/dev/null || echo 0)"
  sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    # Said out loud in the version, because a bundle built from uncommitted work
    # is otherwise indistinguishable from one built from the commit it names.
    dirty=".dirty"
  fi
  printf '%d.%d.0-dev.%s.%s%s' "$major" "$((minor + 1))" "$n" "$sha" "$dirty"
}

[[ -n "$VERSION" ]] || VERSION="$(derive_version)"

log "Bundling $VERSION"

if [[ $RUN_TESTS -eq 1 ]]; then
  log "Lint and tests"
  (cd "$REPO_ROOT" && npm run lint >/dev/null) || die "Lint failed. Fix it before putting this on a machine."
  (cd "$REPO_ROOT" && npm test >/dev/null 2>&1) || die "Tests failed. Fix them before putting this on a machine."
  ok "Lint clean, suites green"
fi

if [[ $RUN_BUILD -eq 1 ]]; then
  log "Build"
  (cd "$REPO_ROOT" && npm run build >/dev/null)
  ok "server/dist and ui/dist built"
fi

[[ -d "$REPO_ROOT/server/dist" ]] || die "No server/dist — drop --no-build."
[[ -d "$REPO_ROOT/ui/dist" ]] || die "No ui/dist — drop --no-build."

log "Staging"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Mirrors .github/workflows/release.yml exactly. server/assets is not optional:
# the server reads the sensor CSVs and topic maps from disk at runtime, and a
# kiosk without them resolves no topics while looking perfectly healthy.
mkdir -p "$STAGE/server/dist" "$STAGE/server/assets" "$STAGE/ui/dist"
cp -r "$REPO_ROOT/server/dist/." "$STAGE/server/dist/"
cp -r "$REPO_ROOT/server/assets/." "$STAGE/server/assets/"
cp -r "$REPO_ROOT/ui/dist/." "$STAGE/ui/dist/"
# The speech model is in ui/dist on a machine that has run
# download-vosk-model.sh, and CI never has it — keeping it would make this
# bundle 46 MB bigger than the release it imitates, for a file provisioning
# already places and that survives every update.
rm -f "$STAGE/ui/dist/vosk-model-de.tar.gz"
cp "$REPO_ROOT/server/package.json" "$STAGE/server/"
cp "$REPO_ROOT/package.json" "$STAGE/"
cp "$REPO_ROOT/.env.example" "$STAGE/"

# Only the copies. The repo's own package.json files are never touched — CI
# stamps those from the git tag, and a bumped version in source control is how
# the tag and the code disagree.
(cd "$STAGE" && npm pkg set version="$VERSION" >/dev/null)
(cd "$STAGE/server" && npm pkg set version="$VERSION" >/dev/null)
ok "Version stamped into both package.json copies"

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/app-v${VERSION}.tar.gz"
(cd "$STAGE" && tar -czf "$TARBALL" .)
(cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "${TARBALL%.tar.gz}").sha256")

log "Done"
cat <<SUMMARY
  $TARBALL
  $(du -h "$TARBALL" | cut -f1), sha256 beside it

  First install:
    ./scripts/make-provision-stick.sh --device /dev/sdX --bundle "$TARBALL" …
  Already-provisioned machine:
    ./scripts/deploy-kiosk.sh kiosk@<host>        # faster, no stick
    or drop the .tar.gz on a USB stick for the updater to find

SUMMARY
