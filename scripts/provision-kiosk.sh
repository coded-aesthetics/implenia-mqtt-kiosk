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
# Kept in step with the machines that build the offline dependency bundle: a
# prebuilt server/node_modules only works on a matching Node major.
NODE_MAJOR=24
GITHUB_OWNER="coded-aesthetics"
GITHUB_REPO="implenia-mqtt-kiosk"
GITHUB_TOKEN=""
TIMEZONE="Europe/Berlin"
SYS_LOCALE="de_DE.UTF-8"
BUNDLE=""
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
  --bundle PATH       Release archive app-vX.Y.Z.tar.gz
                      (default: newest one next to this script)
  --deps PATH         Offline dependency archive (server/node_modules).
                      Without one, dependencies are installed from the network,
                      which needs --token.
  --vosk PATH         vosk-model-de.tar.gz for offline voice setup
  --token TOKEN       GitHub token: read access to the repo's releases and
                      packages. Used for npm and written to .env so the kiosk
                      can self-update from the private repo.
  --app-dir PATH      Install location (default /opt/kiosk)
  --port N            Server port (default 3000)
  --node-major N      Node.js major version to install (default 24)
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
  sudo apt-get install -y -qq --no-install-recommends \
    xserver-xorg xserver-xorg-core xinit x11-xserver-utils \
    xserver-xorg-input-libinput xserver-xorg-video-intel \
    openbox chromium unclutter fonts-dejavu-core \
    curl ca-certificates unzip sqlite3 \
    dbus dbus-user-session udisks2 udiskie avahi-daemon
  ok "X, Openbox, Chromium, udiskie (USB updates), avahi (reach it as $(hostname).local)"
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

  command -v pm2 >/dev/null || sudo npm install -g pm2 --silent
  ok "PM2 $(pm2 -v 2>/dev/null)"
}

# --- 5. the app -----------------------------------------------------------

find_payload() {
  # Newest by version, not by mtime: a stick accumulates releases and the one
  # copied last is not necessarily the newest.
  local pattern="$1"
  ls -1 "$SCRIPT_DIR"/$pattern 2>/dev/null | sort -V | tail -1
}

app_payload() {
  log "Application"
  [[ -n "$BUNDLE" ]] || BUNDLE="$(find_payload 'app-v*.tar.gz')"
  [[ -n "$BUNDLE" && -f "$BUNDLE" ]] || die "No release archive found. Put app-vX.Y.Z.tar.gz next to this script or pass --bundle."

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
  ok "$(basename "$BUNDLE") extracted to $APP_DIR (version $(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?'))"
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

  local tries=0
  until curl -fsS -o /dev/null "http://localhost:$PORT/status"; do
    tries=$((tries + 1))
    [[ $tries -lt 30 ]] || die "Server did not answer on port $PORT within 30 s. Check: pm2 logs kiosk-server"
    sleep 1
  done
  ok "Server answers on http://localhost:$PORT/status"
}

kiosk_session() {
  log "Kiosk session"
  # No display manager: autologin on tty1 and startx. One less service, ~150 MB
  # less RAM than a desktop environment, and the recovery path is a login.
  sudo install -d /etc/systemd/system/getty@tty1.service.d
  sudo tee /etc/systemd/system/getty@tty1.service.d/override.conf >/dev/null <<OVERRIDE
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $USER --noclear %I \$TERM
OVERRIDE
  sudo systemctl daemon-reload
  ok "Autologin for $USER on tty1"

  if ! grep -q 'exec startx' "$HOME/.bash_profile" 2>/dev/null; then
    # bash reads .bash_profile *instead of* .profile, and Debian's .profile is
    # what sources .bashrc — so creating this file without it would hand every
    # service SSH session a bare shell.
    [[ -f "$HOME/.bash_profile" ]] || cat > "$HOME/.bash_profile" <<'KEEPPROFILE'
# shellcheck source=/dev/null
[ -f "$HOME/.profile" ] && . "$HOME/.profile"
KEEPPROFILE
    cat >> "$HOME/.bash_profile" <<'PROFILE'

# Start the kiosk session on the console login, and only there, so an SSH
# session from a service laptop still gets a plain shell.
if [ "$(tty)" = "/dev/tty1" ] && [ -z "$DISPLAY" ]; then
  exec startx
fi
PROFILE
    ok "startx on console login"
  else
    skip "startx already in .bash_profile"
  fi

  local chromium_bin
  chromium_bin="$(command -v chromium || command -v chromium-browser)" \
    || die "No chromium binary found."

  [[ -f "$HOME/.xinitrc" ]] && cp "$HOME/.xinitrc" "$HOME/.xinitrc.bak"
  cat > "$HOME/.xinitrc" <<XINITRC
#!/bin/sh
# Kiosk session — written by provision-kiosk.sh (previous version: ~/.xinitrc.bak).
#
# X exits when this script exits, and agetty logs the kiosk user straight back
# in, so the loop below is the whole recovery story: Chromium killed by the OOM
# killer is back in two seconds, and a dead X server gets a fresh session.

xset s off -dpms s noblank          # a blanked screen reads as a dead kiosk
setxkbmap de 2>/dev/null || true
unclutter -idle 0 &                 # no mouse pointer on a touchscreen
udiskie --no-notify 2>/dev/null &   # mounts USB sticks under /media for USB updates
openbox &

# Chromium does not retry a failed load, so starting it before PM2 has the port
# open would leave a permanent error page on a screen nobody can navigate.
until curl -fsS -o /dev/null http://localhost:$PORT/status; do sleep 1; done

while : ; do
  # Power loss is routine on site, and Chromium greets an unclean shutdown with
  # a "Restore pages?" bubble on top of the UI.
  if [ -f "$HOME/.config/chromium/Default/Preferences" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \\
      "$HOME/.config/chromium/Default/Preferences"
  fi
  $chromium_bin --kiosk --app=http://localhost:$PORT \\
    --no-first-run --no-default-browser-check \\
    --disable-infobars --noerrdialogs --disable-session-crashed-bubble \\
    --disable-features=Translate,TranslateUI \\
    --password-store=basic \\
    --overscroll-history-navigation=0 \\
    --disable-pinch \\
    --use-fake-ui-for-media-stream \\
    --autoplay-policy=no-user-gesture-required \\
    --check-for-update-interval=31536000 \\
    --disable-component-update || true
  sleep 2
done
XINITRC
  chmod +x "$HOME/.xinitrc"
  ok "Chromium kiosk session written to ~/.xinitrc"
  skip "--overscroll-history-navigation=0 and --disable-pinch: a gloved swipe must not navigate back or zoom the 1024x768 layout"
  skip "--use-fake-ui-for-media-stream: grants the microphone without a prompt nobody could answer (voice commands)"
}

# --- 7. remote access -----------------------------------------------------

#
# AnyDesk's .deb declares `Depends: libgcc1 (>= 1:4.1.1)`. Debian renamed that
# package to libgcc-s1 and nothing in trixie provides the old name, so apt
# refuses the install outright.
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
  unit="$(systemctl list-unit-files --type=service --no-legend 'anydesk*' 2>/dev/null | awk '{print $1; exit}')"
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
    if printf '%s\n' "$ANYDESK_PASSWORD" | sudo anydesk --set-password >/dev/null 2>&1; then
      ok "Unattended access password set"
    else
      warn "AnyDesk refused the password — it rejects weak ones. Set it by hand: printf '%s\\n' '<password>' | sudo anydesk --set-password"
    fi
  else
    warn "No password set, so a remote session must be accepted on the touchscreen. Pass --anydesk-password or put ANYDESK_PASSWORD in kiosk.conf."
  fi

  # The id only exists once the service has registered with AnyDesk's servers,
  # which needs internet — hence the wait rather than one hopeful call.
  local id="" tries=0
  while [[ $tries -lt 10 ]]; do
    id="$(sudo anydesk --get-id 2>/dev/null | tr -dc '0-9')"
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
