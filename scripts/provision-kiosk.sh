#!/usr/bin/env bash
# Turn a freshly installed Debian machine into an Implenia kiosk.
#
# Run it as the kiosk user — not as root, not with sudo in front — on a machine
# that is nothing but a standard Debian install:
#
#     ./provision-kiosk.sh --hostname kiosk-g08
#
# Everything it does is idempotent: re-running it repairs a machine somebody
# has fiddled with, and it is the supported way to move a kiosk to a new
# release by hand. The steps that come before it — BIOS settings and the Debian
# installer answers — are in docs/kiosk-provisioning.md.
#
# Defaults come from kiosk.conf next to this script (written onto the
# provisioning stick by scripts/make-provision-stick.sh), so the service team
# types a hostname and nothing else.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- defaults -------------------------------------------------------------

APP_DIR="/opt/kiosk"
PORT=3000
# 22, deliberately, and not the newest.
#
# better-sqlite3 11.x publishes no prebuilt binary for Node 24, so Node 24
# compiles it from source — and that build aborts the process during
# environment teardown (`Assertion failed: (env) != nullptr` in
# RemoveEnvironmentCleanupHook). It took down nine test workers in CI. The
# kiosk's database layer is the last place for an unvetted native build, and
# node-v127 (Node 22) is the prebuild the project actually ships.
#
# It also has to match whatever built an offline dependency archive, since
# those binaries are compiled, not portable.
NODE_MAJOR=22
GITHUB_OWNER="coded-aesthetics"
GITHUB_REPO="implenia-mqtt-kiosk"
GITHUB_TOKEN=""
TIMEZONE="Europe/Berlin"
SYS_LOCALE="de_DE.UTF-8"
BUNDLE=""
RELEASE_VERSION=""
DEPS=""
VOSK=""
NEW_HOSTNAME=""
WITH_ZRAM=1
WITH_VOSK=1
WITH_ANYDESK=1
ANYDESK_PASSWORD=""
ANYDESK_ID=""
ASSUME_YES=0
EXPORT_DEPS=""

[[ -f "$SCRIPT_DIR/kiosk.conf" ]] && . "$SCRIPT_DIR/kiosk.conf"

usage() {
  cat <<'USAGE'
Usage: ./provision-kiosk.sh [options]

  --hostname NAME     Set the machine's hostname (e.g. kiosk-g08)
  --bundle PATH       Install this release archive instead of fetching one
  --version vX.Y.Z    Fetch this release instead of the newest. Without either,
                      the newest GitHub release is fetched, and an archive next
                      to this script is the fallback if that fails
  --deps PATH         Offline dependency archive (server/node_modules).
                      Without one, dependencies are installed from the network,
                      which needs --token.
  --vosk PATH         vosk-model-de.tar.gz for offline voice setup
  --token TOKEN       GitHub token: read access to the repo's releases and
                      packages. Used for npm and written to .env so the kiosk
                      can self-update from the private repo.
  --app-dir PATH      Install location (default /opt/kiosk)
  --port N            Server port (default 3000)
  --node-major N      Node.js major version to install (default 22)
  --no-zram           Skip compressed swap
  --no-vosk           Skip the speech model (voice commands stay off)
  --anydesk-password PW
                      Password for unattended remote access. Without one, a
                      remote session has to be accepted on the touchscreen.
  --no-anydesk        Skip remote access entirely
  --export-deps PATH  Write this machine's server/node_modules to PATH as a
                      reusable offline dependency archive, then exit
  --yes               No prompts, no reboot at the end
  -h, --help          This text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)    NEW_HOSTNAME="$2"; shift 2 ;;
    --bundle)      BUNDLE="$2"; shift 2 ;;
    --version)     RELEASE_VERSION="$2"; shift 2 ;;
    --deps)        DEPS="$2"; shift 2 ;;
    --vosk)        VOSK="$2"; shift 2 ;;
    --token)       GITHUB_TOKEN="$2"; shift 2 ;;
    --app-dir)     APP_DIR="$2"; shift 2 ;;
    --port)        PORT="$2"; shift 2 ;;
    --node-major)  NODE_MAJOR="$2"; shift 2 ;;
    --no-zram)     WITH_ZRAM=0; shift ;;
    --no-vosk)     WITH_VOSK=0; shift ;;
    --anydesk-password) ANYDESK_PASSWORD="$2"; shift 2 ;;
    --no-anydesk)  WITH_ANYDESK=0; shift ;;
    --export-deps) EXPORT_DEPS="$2"; shift 2 ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

NEEDS_REBOOT=0

log()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '    \033[2m·\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. preflight ---------------------------------------------------------

preflight() {
  log "Preflight"
  [[ $EUID -ne 0 ]] || die "Run this as the kiosk user, not as root — the kiosk session, PM2 and the app directory all belong to that user."
  # Not redirected: sudo writes its password prompt to stderr, and hiding it
  # leaves the script looking hung on the one machine nobody can read logs from.
  sudo -v || die "This user needs sudo. Leave the root password empty in the Debian installer and the first user gets it."
  [[ -f /etc/debian_version ]] || warn "Not a Debian system — proceeding, but nothing here is tested elsewhere."
  [[ "$(uname -m)" == "x86_64" ]] || warn "Not x86_64 ($(uname -m)) — the prebuilt native modules will not match."
  ok "Running as $USER, sudo available, Debian $(cat /etc/debian_version 2>/dev/null || echo '?')"

  # The mistake that cost a provisioning run: /media/prov is an ordinary
  # directory when the stick is not mounted, and a script copied into it runs
  # perfectly well with no kiosk.conf, no token and no payload beside it.
  if [[ ! -f "$SCRIPT_DIR/kiosk.conf" ]] && ! ls "$SCRIPT_DIR"/app-v*.tar.gz >/dev/null 2>&1; then
    warn "No kiosk.conf and no release archive next to this script ($SCRIPT_DIR) — if this should be the provisioning stick, it is probably not mounted. Carrying on; credentials must then come from the command line."
  fi

  # AnyDesk refuses short or patterned passwords, and it refuses them at the
  # very end of the run — fifteen minutes after the only moment anybody could
  # have done something about it. Said here instead.
  if [[ $WITH_ANYDESK -eq 1 && -n "$ANYDESK_PASSWORD" && ${#ANYDESK_PASSWORD} -lt 12 ]]; then
    warn "The AnyDesk password is ${#ANYDESK_PASSWORD} characters. AnyDesk requires at least 8 and rejects simple patterns; under 12 it is usually refused. Remote access will stay interactive unless you pass a longer --anydesk-password."
  fi
}

# --- 1. system ------------------------------------------------------------

system_basics() {
  log "System basics"

  if [[ -n "$NEW_HOSTNAME" && "$(hostname)" != "$NEW_HOSTNAME" ]]; then
    sudo hostnamectl set-hostname "$NEW_HOSTNAME"
    # Keep /etc/hosts in step, or sudo stalls on every call looking the name up.
    if grep -q '^127\.0\.1\.1' /etc/hosts; then
      sudo sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
    else
      echo -e "127.0.1.1\t$NEW_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null
    fi
    ok "Hostname: $NEW_HOSTNAME"
  else
    skip "Hostname: $(hostname)"
  fi

  sudo timedatectl set-timezone "$TIMEZONE"
  ok "Timezone: $TIMEZONE"

  if ! locale -a 2>/dev/null | grep -qi "${SYS_LOCALE/UTF-8/utf8}"; then
    sudo sed -i "s/^# *${SYS_LOCALE}/${SYS_LOCALE}/" /etc/locale.gen
    sudo locale-gen >/dev/null
    ok "Locale generated: $SYS_LOCALE"
  else
    skip "Locale present: $SYS_LOCALE"
  fi
  sudo update-locale "LANG=$SYS_LOCALE" >/dev/null

  log "Packages"
  sudo apt-get update -qq
  # --no-install-recommends on purpose: this machine has 4 GB of RAM and no
  # business running a desktop environment, a print spooler or a mail agent.
  # The X input and video drivers are Recommends of xserver-xorg, so they have to
  # be named explicitly here — without the libinput driver the server comes up
  # and sees no touchscreen at all. dbus-user-session is what udiskie needs to
  # reach udisks. polkit is not named: udisks2 depends on it.
  # ncurses-term is the one entry here that is purely for the people, not the
  # kiosk: without it a service tech SSHing in from kitty, alacritty, wezterm or
  # foot gets `Error opening terminal: xterm-kitty` from anything curses-based —
  # top, nano, htop — on the machine they were sent to fix.
  sudo apt-get install -y -qq --no-install-recommends \
    xserver-xorg xserver-xorg-core xinit x11-xserver-utils \
    xserver-xorg-input-libinput xserver-xorg-video-intel \
    lightdm lightdm-gtk-greeter \
    openbox chromium unclutter fonts-dejavu-core \
    curl ca-certificates unzip sqlite3 ncurses-term xinput \
    dbus dbus-user-session udisks2 udiskie avahi-daemon
  ok "X, lightdm, Openbox, Chromium, udiskie (USB updates), avahi (reach it as $(hostname).local), terminfo for modern terminals"
}

# --- 2. kernel ------------------------------------------------------------

kernel_cmdline() {
  log "Kernel parameters"
  # Bay Trail (Celeron J1900) hangs at random in deep C-states. A frozen screen
  # on a construction site is the failure this whole product exists to avoid, so
  # the workaround goes on every machine rather than waiting for a report.
  if grep -q 'intel_idle.max_cstate' /etc/default/grub; then
    skip "intel_idle.max_cstate already set"
  else
    sudo sed -i 's/^\(GRUB_CMDLINE_LINUX_DEFAULT="[^"]*\)"/\1 intel_idle.max_cstate=1"/' /etc/default/grub
    sudo update-grub 2>/dev/null || sudo grub-mkconfig -o /boot/grub/grub.cfg
    NEEDS_REBOOT=1
    ok "intel_idle.max_cstate=1 added (Bay Trail freeze workaround)"
  fi
}

# --- 2b. touch input ------------------------------------------------------

touch_input() {
  log "Touch input"
  local rules=/etc/udev/rules.d/99-egalax-touchscreen.rules
  if [[ -f "$rules" ]]; then
    skip "eGalax touch rule already in place"
    return
  fi
  #
  # The iSPOS panel carries an eGalax/D-WAV Titan6001 SAW controller
  # (0eef:0001) whose HID descriptors claim a pen tool *and* a finger tool. So
  # udev tags its interfaces Tablet and Touchpad, and libinput — which is
  # right to trust those tags — rejects the one named "Touchscreen" with
  # `missing tablet capabilities: resolution` and adds the other as a touchpad
  # with pointer acceleration. The screen is then inert: the kernel sees every
  # touch, X maps none of it to a coordinate.
  #
  # Tagging it for what it is costs nothing on a machine without the device,
  # since the rule matches on the USB id.
  #
  sudo tee "$rules" >/dev/null <<'RULES'
# eGalax/D-WAV SAW touch controller: its descriptors claim pen and finger
# tools, so udev's input_id tags it Tablet/Touchpad and libinput either refuses
# it or treats it as a relative pointing device. Force the real class.
SUBSYSTEM=="input", ATTRS{idVendor}=="0eef", ATTRS{idProduct}=="0001", \
  ENV{ID_INPUT_TABLET}="", ENV{ID_INPUT_TOUCHPAD}="", ENV{ID_INPUT_MOUSE}="", \
  ENV{ID_INPUT_TOUCHSCREEN}="1"
RULES
  sudo udevadm control --reload-rules 2>/dev/null || true
  NEEDS_REBOOT=1
  ok "eGalax touch controller tagged as a touchscreen (takes effect on reboot)"
}

# --- 3. swap --------------------------------------------------------------

compressed_swap() {
  [[ $WITH_ZRAM -eq 1 ]] || { skip "zram skipped"; return; }
  log "Compressed swap"
  sudo apt-get install -y -qq zram-tools
  # 4 GB shared with Chromium. Compressed swap in RAM is cheaper than swapping
  # to the disk the database also lives on.
  sudo tee /etc/default/zramswap >/dev/null <<'ZRAM'
ALGO=zstd
PERCENT=50
PRIORITY=100
ZRAM
  sudo systemctl enable --now zramswap >/dev/null 2>&1 || true
  ok "zram swap, 50% of RAM, zstd"
}

# --- 4. node --------------------------------------------------------------

node_runtime() {
  log "Node.js"
  local have=""
  command -v node >/dev/null && have="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [[ -n "$have" && "$have" -ge 20 ]]; then
    skip "Node $(node -v) already installed"
  else
    # NodeSource lags a fresh Debian release by weeks sometimes. Debian's own
    # nodejs satisfies the >= 20 requirement, so a failure here is not fatal —
    # but it does mean a prebuilt dependency archive may not match.
    if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null 2>&1; then
      sudo apt-get install -y -qq nodejs
      ok "Node $(node -v) from NodeSource"
    else
      warn "NodeSource unavailable — falling back to Debian's nodejs"
      sudo apt-get install -y -qq nodejs npm
      ok "Node $(node -v) from Debian"
    fi
  fi
  [[ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -ge 20 ]] || die "Node >= 20 required, got $(node -v)."

  #
  # npm 10.x cannot resolve this tree at all. It crashes with `Cannot read
  # properties of null (reading 'edgesOut')` — an arborist bug this project's
  # workspaces-plus-overrides tree reaches, with no manifest of ours at fault.
  # Node 22 bundles 10.9, which fails exactly as 10.8.2 does; npm 11 resolves
  # the same tree in seconds.
  #
  # The CI workflows carry the same pin. It is needed here just as much — this
  # is where the dependencies actually get installed, and without it the whole
  # provisioning run dies at the Dependencies step with no node_modules and an
  # error that names nothing in this repository.
  #
  local npm_major
  npm_major="$(npm -v 2>/dev/null | cut -d. -f1 || true)"
  if [[ -z "$npm_major" ]] || [[ "$npm_major" -lt 11 ]]; then
    sudo npm install -g npm@11 --silent
    ok "npm $(npm -v) — Node's bundled 10.x cannot resolve this tree"
  else
    skip "npm $(npm -v)"
  fi

  command -v pm2 >/dev/null || sudo npm install -g pm2 --silent
  ok "PM2 $(pm2 -v 2>/dev/null)"
}

# --- 5. the app -----------------------------------------------------------

find_payload() {
  # Newest by version, not by mtime: a stick accumulates releases and the one
  # copied last is not necessarily the newest.
  #
  # A glob rather than `ls`, because "no match" is an ordinary answer here and
  # `ls` reports it as a failure. Under `set -o pipefail` that failure became
  # the pipeline's status, then the status of the assignment this feeds, and
  # `set -e` killed the whole run — silently, right after a step header. A
  # stick with no offline dependency archive, which is the normal stick, could
  # never get past "Dependencies".
  local pattern="$1"
  local matches=() f
  shopt -s nullglob
  # Filtered to files that exist: nullglob drops a *pattern* that matches
  # nothing, but a pattern with no wildcard in it (vosk-model-de.tar.gz)
  # expands to itself whether the file is there or not.
  for f in "$SCRIPT_DIR"/$pattern; do [[ -f "$f" ]] && matches+=( "$f" ); done
  shopt -u nullglob
  [[ ${#matches[@]} -gt 0 ]] || return 0
  printf '%s\n' "${matches[@]}" | sort -V | tail -1
}

#
# Fetch the release from GitHub rather than carrying it on the stick.
#
# A stick that holds app-v*.tar.gz ages, silently: provision a machine six
# weeks later and it installs six-week-old code with nothing on screen saying
# so, and the person who then reports the bugs is the one least able to know
# they were fixed. The offline argument for bundling does not survive the rest
# of this script either — apt, NodeSource and npm all need the network a few
# steps earlier, so the archive was the one offline-capable part of an
# otherwise online process.
#
# A private repo's assets cannot be fetched by browser_download_url; the API's
# asset endpoint with `Accept: application/octet-stream` can. Node is installed
# by the time this runs, which is what parses the release JSON — no hand-rolled
# sed over someone else's API.
#
download_release() {
  local tag="$1" outdir="$2"
  [[ -n "$GITHUB_TOKEN" ]] || return 1
  command -v node >/dev/null || return 1

  local api="https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases"
  local url="$api/latest"
  [[ "$tag" == "latest" ]] || url="$api/tags/$tag"

  local json
  json="$(curl -fsSL --max-time 60 \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" "$url")" || return 1

  local lines
  lines="$(printf '%s' "$json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const r = JSON.parse(s);
      console.log("tag	" + (r.tag_name || ""));
      for (const a of r.assets || []) {
        if (/^app-v.+\.tar\.gz$/.test(a.name) || a.name === "checksum.sha256") {
          console.log("asset	" + a.id + "	" + a.name);
        }
      }
    });
  ')" || return 1

  RELEASE_TAG="$(printf '%s\n' "$lines" | awk -F"\t" '$1=="tag" {print $2}')"
  local got=0 id name
  while IFS=$'\t' read -r kind id name; do
    [[ "$kind" == "asset" ]] || continue
    curl -fsSL --max-time 300 \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/octet-stream" \
      -o "$outdir/$name" "$api/assets/$id" || return 1
    [[ "$name" == app-v* ]] && got=1
  done < <(printf '%s\n' "$lines")
  [[ $got -eq 1 ]] || return 1
  return 0
}

app_payload() {
  log "Application"

  local source="" dl=""
  if [[ -n "$BUNDLE" ]]; then
    source="von --bundle"
  else
    local want="latest"
    if [[ -n "$RELEASE_VERSION" ]]; then
      # Tags carry the v; accept it either way rather than failing on a typo.
      want="$RELEASE_VERSION"
      [[ "$want" == v* ]] || want="v$want"
    fi
    dl="$(mktemp -d)"
    if download_release "$want" "$dl"; then
      BUNDLE="$(ls -1 "$dl"/app-v*.tar.gz 2>/dev/null | head -1)"
      source="aus GitHub Release ${RELEASE_TAG:-$want}"
      ok "Fetched $(basename "$BUNDLE") from GitHub"
    else
      rm -rf "$dl"; dl=""
      BUNDLE="$(find_payload 'app-v*.tar.gz')"
      source="vom Stick"
      if [[ -n "$BUNDLE" ]]; then
        # Not fatal, but it must be said out loud: this is how a machine ends
        # up on an old version without anybody choosing that.
        warn "Could not fetch the release from GitHub — falling back to $(basename "$BUNDLE") on the stick, which may be older than the current release."
      fi
    fi
  fi

  #
  # Keep going with what is installed rather than dying here.
  #
  # Dying left a machine half-provisioned on the first real repair run: the
  # packages step had already installed lightdm, and the session was never
  # configured because the script exited two steps earlier — so the machine
  # booted to a greeter and then a black screen. Re-running provisioning is the
  # documented way to repair a machine, and a repair tool that refuses to
  # configure anything because it could not reach GitHub is worse than useless;
  # the app on disk is usually exactly the one wanted anyway.
  #
  if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
    if [[ -f "$APP_DIR/package.json" ]]; then
      warn "No release available (GitHub unreachable or no token, and none on the stick) — keeping the installed version $(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?') and carrying on with the rest of the setup."
      [[ -n "$dl" ]] && rm -rf "$dl"
      return 0
    fi
    die "No release to install, and nothing installed yet: GitHub could not be reached (or no token is set) and there is no app-vX.Y.Z.tar.gz next to this script. Is the stick mounted? Otherwise pass --bundle or --version."
  fi

  # Verify the checksum the release ships, if it came along.
  local sum="${BUNDLE%.tar.gz}.sha256"
  [[ -f "$sum" ]] || sum="$(dirname "$BUNDLE")/checksum.sha256"
  if [[ -f "$sum" ]]; then
    (cd "$(dirname "$BUNDLE")" && sha256sum -c --ignore-missing "$(basename "$sum")" >/dev/null) \
      && ok "Checksum verified" \
      || die "Checksum mismatch for $(basename "$BUNDLE") — the archive is damaged, do not install it."
  else
    warn "No checksum file next to the archive — skipping verification"
  fi

  sudo mkdir -p "$APP_DIR"
  sudo chown "$USER:$USER" "$APP_DIR"
  # Untarring over the tree is exactly what the self-updater does, so this
  # leaves kiosk.db, .env, node_modules and the speech model in place.
  tar -xzf "$BUNDLE" -C "$APP_DIR"
  ok "$(basename "$BUNDLE") extracted to $APP_DIR — Version $(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?'), $source"
  [[ -n "$dl" ]] && rm -rf "$dl"
}

app_deps() {
  log "Dependencies"
  [[ -n "$DEPS" ]] || DEPS="$(find_payload 'node_modules*.tar.gz')"

  if [[ -n "$DEPS" && -f "$DEPS" ]]; then
    # Offline path. The archive holds server/node_modules built on a machine
    # with the same Node major and the same Debian release — native modules
    # (better-sqlite3, serialport) are compiled, not portable.
    tar -xzf "$DEPS" -C "$APP_DIR"
    ok "$(basename "$DEPS") extracted (offline install, no token needed)"
  else
    [[ -n "$GITHUB_TOKEN" ]] || die "Dependencies need either an offline archive (--deps) or a token (--token): @coded-aesthetics/din4023 is a private GitHub Packages dependency."
    # The scope line is in the repo's .npmrc, which the release bundle does not
    # carry; write both it and the token here.
    umask 077
    cat > "$APP_DIR/.npmrc" <<NPMRC
@coded-aesthetics:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=$GITHUB_TOKEN
NPMRC
    cp "$APP_DIR/.npmrc" "$APP_DIR/server/.npmrc"
    umask 022
    # --no-workspaces, and inside server/: the bundle's root package.json
    # declares workspaces ["server","ui"] but ships no ui/package.json, so a
    # root install fails. Deps land in server/node_modules, which is where node
    # resolves them from for server/dist/*.
    (cd "$APP_DIR/server" && npm install --omit=dev --no-workspaces --no-audit --no-fund)
    ok "Dependencies installed from the network"
  fi

  (cd /tmp && node -e "require('$APP_DIR/server/node_modules/better-sqlite3')") 2>/dev/null \
    && ok "better-sqlite3 loads (native modules match this machine)" \
    || die "better-sqlite3 does not load. With an offline archive this means it was built for a different Node version or Debian release — install with --token instead."

  # The other compiled module, and a warning rather than a failure: it is only
  # needed by the serial transport, so a kiosk on MQTT runs fine without it and
  # must not be refused an install over it. A serial site would otherwise find
  # out when the rig is already waiting.
  (cd /tmp && node -e "require('$APP_DIR/server/node_modules/serialport')") 2>/dev/null \
    && ok "serialport loads" \
    || warn "serialport does not load — the serial (Elvis) transport will not work on this machine. MQTT is unaffected. Re-run with --token to rebuild it from the network."
}

set_env() {
  local key="$1" value="$2" file="$APP_DIR/.env"
  if grep -q "^#\? *${key}=" "$file" 2>/dev/null; then
    sed -i "s|^#\? *${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

app_env() {
  log "Configuration"
  if [[ ! -f "$APP_DIR/.env" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    ok ".env created from .env.example"
  else
    skip ".env kept (site settings live in it)"
  fi
  set_env PORT "$PORT"
  set_env NODE_ENV production
  set_env GITHUB_OWNER "$GITHUB_OWNER"
  set_env GITHUB_REPO "$GITHUB_REPO"
  [[ -n "$GITHUB_TOKEN" ]] && set_env GITHUB_TOKEN "$GITHUB_TOKEN"
  chmod 600 "$APP_DIR/.env"
  ok "Updater points at $GITHUB_OWNER/$GITHUB_REPO$([[ -n "$GITHUB_TOKEN" ]] && echo ' with a token' || echo ' (no token: GitHub updates skipped, USB updates still work)')"
  skip "MQTT broker, Verfahren and API credentials are set on site in the wizard"
}

vosk_model() {
  [[ $WITH_VOSK -eq 1 ]] || { skip "Speech model skipped — voice commands stay off"; return; }
  log "Speech model"
  local target="$APP_DIR/ui/dist/vosk-model-de.tar.gz"
  # No release bundle contains the model (it is gitignored and CI never fetches
  # it), and putting it there would add ~45 MB to every hourly self-update over
  # a mobile link. It is provisioned once instead, and survives updates because
  # the updater only untars over the tree.
  if [[ -s "$target" ]]; then
    skip "Model already present ($(du -h "$target" | cut -f1))"
    return
  fi
  [[ -n "$VOSK" ]] || VOSK="$(find_payload 'vosk-model-de.tar.gz')"
  if [[ -n "$VOSK" && -f "$VOSK" ]]; then
    cp "$VOSK" "$target"
    ok "Model copied from the stick ($(du -h "$target" | cut -f1))"
    return
  fi
  # Same repackaging as scripts/download-vosk-model.sh: vosk-browser wants a
  # tar.gz with a top-level 'model' directory.
  local tmp; tmp="$(mktemp -d)"
  if curl -fsSL -o "$tmp/model.zip" https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip; then
    unzip -q "$tmp/model.zip" -d "$tmp"
    mv "$tmp"/vosk-model-small-de-* "$tmp/model"
    tar -czf "$target" -C "$tmp" model
    ok "Model downloaded ($(du -h "$target" | cut -f1))"
  else
    warn "Model download failed — voice commands stay off until it is provisioned. Everything else works."
  fi
  rm -rf "$tmp"
}

# --- 6. service -----------------------------------------------------------

pm2_service() {
  log "Server service"
  pm2 delete kiosk-server >/dev/null 2>&1 || true
  # No --max-restarts cap: a kiosk that gives up needs a site visit, while one
  # that keeps retrying recovers by itself once a transient cause clears (a full
  # disk, an unplugged serial adapter). The 5 s delay keeps a crash loop cheap.
  pm2 start "$APP_DIR/server/dist/index.js" \
    --name kiosk-server --cwd "$APP_DIR" --restart-delay 5000 >/dev/null
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null
  pm2 save >/dev/null
  ok "kiosk-server under PM2, starting on boot"

  # -fs, not -fsS: the first attempt lands before the server is listening, and
  # `curl: (7) Failed to connect` printed directly above a green tick is how a
  # clean provisioning run gets distrusted.
  local tries=0
  until curl -fs -o /dev/null "http://localhost:$PORT/status"; do
    tries=$((tries + 1))
    [[ $tries -lt 30 ]] || die "Server did not answer on port $PORT within 30 s. Check: pm2 logs kiosk-server"
    sleep 1
  done
  ok "Server answers on http://localhost:$PORT/status"
}

kiosk_session() {
  log "Kiosk session"
  #
  # lightdm with autologin, not `startx` from a tty.
  #
  # The first machine ran the session from an agetty autologin, which saves a
  # service and a few megabytes and looked like the right trade for a 4 GB
  # machine. It is not: `startx` from a tty never registers a *graphical*
  # session with logind, so `loginctl` reports `Type=tty` with no `Display`,
  # and every tool that asks logind what display server is running concludes
  # there is none. AnyDesk reports exactly that — "display server not supported
  # (e.g. Wayland)" — on an X11 machine, which cost an evening to track down.
  #
  # The original reasoning confused a display manager with a desktop
  # environment. GNOME is 1.2 GB; lightdm is single-digit megabytes, shows no
  # greeter when autologin works, and brings the thing that was actually
  # missing: a session logind calls `x11`, with the X cookie published where
  # root can find it.
  #
  # The greeter is installed on purpose even though it is never shown. If
  # autologin ever fails, a greeter is a login prompt a service tech can use;
  # without one it is a black screen.
  #
  sudo install -d /usr/share/xsessions
  sudo tee /usr/share/xsessions/kiosk.desktop >/dev/null <<SESSION
[Desktop Entry]
Name=Implenia Kiosk
Comment=Chromium kiosk under Openbox
Exec=$HOME/.xsession
Type=Application
SESSION

  sudo install -d /etc/lightdm/lightdm.conf.d
  sudo tee /etc/lightdm/lightdm.conf.d/50-kiosk.conf >/dev/null <<LIGHTDM
[Seat:*]
autologin-user=$USER
autologin-user-timeout=0
user-session=kiosk
autologin-session=kiosk
LIGHTDM
  ok "lightdm autologin for $USER into the kiosk session"

  # Migration: a machine provisioned the old way starts X twice otherwise, once
  # from the tty autologin and once from lightdm.
  if [[ -f /etc/systemd/system/getty@tty1.service.d/override.conf ]]; then
    sudo rm -f /etc/systemd/system/getty@tty1.service.d/override.conf
    sudo systemctl daemon-reload
    ok "Removed the old tty1 autologin override"
  fi
  if [[ -f "$HOME/.bash_profile" ]] && grep -q 'exec startx' "$HOME/.bash_profile"; then
    sed -i '/# Start the kiosk session on the console login/,/^fi$/d' "$HOME/.bash_profile"
    ok "Removed 'exec startx' from .bash_profile"
  fi

  local chromium_bin
  chromium_bin="$(command -v chromium || command -v chromium-browser)" \
    || die "No chromium binary found."

  [[ -f "$HOME/.xsession" ]] && cp "$HOME/.xsession" "$HOME/.xsession.bak"
  cat > "$HOME/.xsession" <<XSESSION
#!/bin/sh
# Kiosk session — written by provision-kiosk.sh (previous version: ~/.xsession.bak).
#
# Started by lightdm, which registers it with logind as a real x11 session and
# publishes the X cookie where root can find it. lightdm restarts the session
# if it exits, which is the recovery story; the Chromium loop below covers the
# browser dying on its own.

xset s off -dpms s noblank          # a blanked screen reads as a dead kiosk
setxkbmap de 2>/dev/null || true
unclutter -idle 0 &                 # no mouse pointer on a touchscreen
udiskie --no-notify 2>/dev/null &   # mounts USB sticks under /media for USB updates
openbox &

# AnyDesk wants a client inside the session. The service usually starts one
# itself once there is a session to attach to; this makes it certain. Before
# Chromium, so the fullscreen kiosk window ends up on top.
command -v anydesk >/dev/null && anydesk >/dev/null 2>&1 &

# Chromium does not retry a failed load, so starting it before PM2 has the port
# open would leave a permanent error page on a screen nobody can navigate.
until curl -fs -o /dev/null http://localhost:$PORT/status; do sleep 1; done

while : ; do
  # Power loss is routine on site, and Chromium greets an unclean shutdown with
  # a "Restore pages?" bubble on top of the UI.
  if [ -f "$HOME/.config/chromium/Default/Preferences" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
      "$HOME/.config/chromium/Default/Preferences"
  fi
  $chromium_bin --kiosk --app=http://localhost:$PORT \
    --no-first-run --no-default-browser-check \
    --disable-infobars --noerrdialogs --disable-session-crashed-bubble \
    --disable-features=Translate,TranslateUI \
    --password-store=basic \
    --overscroll-history-navigation=0 \
    --disable-pinch \
    --use-fake-ui-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --disable-component-update || true
  sleep 2
done
XSESSION
  chmod +x "$HOME/.xsession"
  ok "Chromium kiosk session written to ~/.xsession"

  sudo systemctl set-default graphical.target >/dev/null 2>&1 || true
  sudo systemctl enable lightdm >/dev/null 2>&1 || true
  ok "lightdm enabled at boot"
  skip "--overscroll-history-navigation=0 and --disable-pinch: a gloved swipe must not navigate back or zoom the 1024x768 layout"
  skip "--use-fake-ui-for-media-stream: grants the microphone without a prompt nobody could answer (voice commands)"
}

# --- 7. remote access -----------------------------------------------------

#
# AnyDesk's .deb declares `Depends: libgcc1 (>= 1:4.1.1)`, a package name Debian
# dropped after bookworm in favour of libgcc-s1.
#
# **On the first real install — Debian 13.7, AnyDesk 8.1.0 — apt resolved it
# anyway and this was never built.** Something in the archive still provides the
# name. It stays as a fallback because it is built only when apt's own
# simulation says the dependency is unmet, so it costs a passing install
# nothing; do not read its presence as proof the problem exists.
#
# A shim is the right fix rather than repacking the .deb: repacking leaves apt
# unable to satisfy the repo version ever again, so AnyDesk silently stops
# receiving updates on a fleet that updates itself. The Provides is versioned
# because an unversioned one does not satisfy a versioned dependency, and the
# shim depends on libgcc-s1, which is the package that actually carries
# libgcc_s.so.1 — so the runtime dependency is real, not papered over.
#
anydesk_libgcc_shim() {
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/shim/DEBIAN"
  cat > "$tmp/shim/DEBIAN/control" <<'CTRL'
Package: anydesk-libgcc1-shim
Version: 1:14.2.0
Architecture: amd64
Maintainer: Implenia Kiosk provisioning <kiosk@localhost>
Provides: libgcc1 (= 1:14.2.0)
Depends: libgcc-s1
Section: libs
Priority: optional
Description: satisfy AnyDesk's dependency on the pre-trixie libgcc1 name
 AnyDesk's .deb depends on libgcc1 (>= 1:4.1.1). Debian renamed that package to
 libgcc-s1 after bookworm and nothing in trixie provides the old name, so apt
 refuses to install AnyDesk. This package provides the name and depends on the
 library that actually carries libgcc_s.so.1, which keeps the runtime
 dependency real and leaves `apt upgrade anydesk` working.
CTRL
  dpkg-deb --build "$tmp/shim" "$tmp/shim.deb" >/dev/null
  if sudo apt-get install -y -qq "$tmp/shim.deb" >/dev/null 2>&1; then
    ok "libgcc1 shim installed (Debian dropped the name, AnyDesk still asks for it)"
  else
    warn "Could not install the libgcc1 shim"
  fi
  rm -rf "$tmp"
}

remote_access() {
  [[ $WITH_ANYDESK -eq 1 ]] || { skip "Remote access skipped"; return; }
  log "Remote access (AnyDesk)"

  # Never fatal. A kiosk that records and uploads but cannot be reached
  # remotely is a kiosk; one that fails provisioning over a support tool is a
  # machine that goes back in the van.
  if command -v anydesk >/dev/null; then
    skip "AnyDesk already installed"
  else
    sudo install -m 0755 -d /etc/apt/keyrings
    if ! sudo curl -fsSL https://keys.anydesk.com/repos/DEB-GPG-KEY -o /etc/apt/keyrings/keys.anydesk.com.asc; then
      warn "Could not fetch AnyDesk's signing key — skipping remote access. Everything else is set up."
      return
    fi
    sudo chmod a+r /etc/apt/keyrings/keys.anydesk.com.asc
    echo "deb [signed-by=/etc/apt/keyrings/keys.anydesk.com.asc] https://deb.anydesk.com all main" \
      | sudo tee /etc/apt/sources.list.d/anydesk-stable.list >/dev/null
    sudo apt-get update -qq
    # Simulated first: only build the shim if the dependency really is unmet on
    # this release, so a fixed AnyDesk package installs on its own terms.
    sudo apt-get install -s -qq anydesk >/dev/null 2>&1 || anydesk_libgcc_shim
    if ! sudo apt-get install -y -qq anydesk; then
      warn "AnyDesk could not be installed — skipping remote access. Everything else is set up."
      return
    fi
    ok "AnyDesk installed"
  fi

  # The unit name has moved between AnyDesk releases, so it is discovered.
  local unit
  unit="$(systemctl list-unit-files --type=service --no-legend 'anydesk*' 2>/dev/null | awk '{print $1; exit}' || true)"
  if [[ -n "$unit" ]]; then
    sudo systemctl enable --now "$unit" >/dev/null 2>&1 || true
    ok "$unit enabled at boot"
  else
    sudo anydesk --service >/dev/null 2>&1 || true
    warn "No systemd unit found; started with 'anydesk --service'"
  fi

  if [[ -n "$ANYDESK_PASSWORD" ]]; then
    # Unattended access is the point: a worker cannot be talked through
    # accepting a session, and nobody is driving to the site to click Accept.
    # -H matters: Debian's sudo keeps the *invoking* user's HOME, so a plain
    # `sudo anydesk` writes AnyDesk's config into /home/kiosk/.anydesk owned by
    # root with mode 700. The user-level client then cannot open its own config
    # directory and aborts instantly — no output, and no trace file, because
    # the trace lives in that directory. Nothing in the session exposes the
    # display after that, and the service reports display_server_not_supported,
    # which sounds like anything but a permissions problem.
    if printf '%s\n' "$ANYDESK_PASSWORD" | sudo -H anydesk --set-password >/dev/null 2>&1; then
      ok "Unattended access password set"
    else
      warn "AnyDesk refused the ${#ANYDESK_PASSWORD}-character password — it wants at least 8, recommends over 12, and rejects simple patterns. Unattended access is NOT active. Set it by hand (the -H matters, or root takes ~/.anydesk back): printf '%s\\n' '<longer password>' | sudo -H anydesk --set-password"
    fi
  else
    warn "No password set, so a remote session must be accepted on the touchscreen. Pass --anydesk-password or put ANYDESK_PASSWORD in kiosk.conf."
  fi

  # Repair a home directory an earlier provisioning run poisoned: a root-owned
  # ~/.anydesk is what makes the client abort, and re-running this script is how
  # somebody would reasonably expect that to be fixed.
  if [[ -d "$HOME/.anydesk" && ! -w "$HOME/.anydesk" ]]; then
    sudo chown -R "$USER:$USER" "$HOME/.anydesk"
    ok "Took back ~/.anydesk from root (an earlier run left it unusable for the client)"
  fi

  # The id only exists once the service has registered with AnyDesk's servers,
  # which needs internet — hence the wait rather than one hopeful call.
  local id="" tries=0
  while [[ $tries -lt 10 ]]; do
    id="$(sudo -H anydesk --get-id 2>/dev/null | tr -dc '0-9' || true)"
    [[ ${#id} -ge 6 ]] && break
    id=""
    tries=$((tries + 1))
    sleep 2
  done

  if [[ -n "$id" ]]; then
    ANYDESK_ID="$id"
    # Read by the server (remote-access.ts) and shown on Einstellungen →
    # System, because `anydesk --get-id` answers nobody but root and the
    # server runs as this user.
    printf '%s\n' "$id" > "$APP_DIR/anydesk-id.txt"
    ok "AnyDesk-ID $id — also shown on the kiosk under Einstellungen → System"
    # A register on the stick, so the service team has the fleet's ids in one
    # place. Silently skipped when the stick is mounted read-only for us.
    if [[ -w "$SCRIPT_DIR" ]]; then
      printf '%s\t%s\t%s\n' "$(hostname)" "$id" "$(date -Iseconds)" >> "$SCRIPT_DIR/machines.tsv"
      ok "Recorded in machines.tsv on the stick"
    fi
  else
    warn "AnyDesk has no id yet (it registers over the internet on first run). Re-run this script once the machine is online, or write the id into $APP_DIR/anydesk-id.txt by hand."
  fi
}

# --- 8. summary -----------------------------------------------------------

export_deps() {
  log "Exporting dependencies"
  [[ -d "$APP_DIR/server/node_modules" ]] || die "No $APP_DIR/server/node_modules to export."
  tar -czf "$EXPORT_DEPS" -C "$APP_DIR" server/node_modules
  ok "$EXPORT_DEPS ($(du -h "$EXPORT_DEPS" | cut -f1))"
  echo
  echo "Reuse this only on identical hardware running the same Debian release and"
  echo "Node $(node -v | sed 's/^v\([0-9]*\).*/\1/') — better-sqlite3 and serialport are compiled, not portable."
  exit 0
}

summary() {
  log "Done"
  cat <<SUMMARY
  Machine     $(hostname) — reachable as $(hostname).local over SSH
  App         $APP_DIR (version $(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?'))
  Server      http://localhost:$PORT  ·  pm2 logs kiosk-server
  Fernwartung ${ANYDESK_ID:-nicht eingerichtet}
  Next        On site: the setup wizard asks for Verfahren, data source and
              MQTT settings. Nothing else needs typing on this machine.

SUMMARY
  if [[ $NEEDS_REBOOT -eq 1 ]]; then
    warn "A reboot is needed for the kernel parameter, and it is also the test that matters: the machine must come up into the kiosk on its own."
    if [[ $ASSUME_YES -eq 0 ]]; then
      read -r -p "    Reboot now? [j/N] " answer
      [[ "$answer" =~ ^[jJyY]$ ]] && sudo reboot
    fi
  else
    echo "  Reboot to confirm the machine comes up into the kiosk on its own: sudo reboot"
  fi
}

main() {
  preflight
  [[ -n "$EXPORT_DEPS" ]] && export_deps
  system_basics
  touch_input
  kernel_cmdline
  compressed_swap
  node_runtime
  app_payload
  app_deps
  app_env
  vosk_model
  pm2_service
  kiosk_session
  remote_access
  summary
}

main "$@"
