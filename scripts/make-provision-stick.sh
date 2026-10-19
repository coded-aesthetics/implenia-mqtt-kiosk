#!/usr/bin/env bash
# Build the USB stick that provisions a kiosk: Debian installer plus the
# payload provision-kiosk.sh needs. Run once per release, in the office.
#
#     ./scripts/make-provision-stick.sh --device /dev/sdX --latest --token ghp_…
#
# The stick comes out with two things on it:
#
#   partition 1-2   the Debian netinst image, bootable (written with dd)
#   last partition  KIOSK-PROV, holding provision-kiosk.sh, the release
#                   archive, the speech model and kiosk.conf
#
# Without --device it only assembles the payload into a directory, which is the
# way to refresh a stick that is already prepared: copy the directory onto the
# KIOSK-PROV partition.
#
# See docs/kiosk-provisioning.md for the procedure this stick serves.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEVICE=""
ISO=""
VERSION=""
TOKEN=""
ANYDESK_PASSWORD=""
DEPS=""
OUT=""
PAYLOAD_PART_SIZE="8G"
ASSUME_YES=0
REPO="coded-aesthetics/implenia-mqtt-kiosk"
ISO_BASE="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd"
VOSK_URL="https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip"

usage() {
  cat <<'USAGE'
Usage: ./scripts/make-provision-stick.sh [options]

  --device /dev/sdX   USB stick to write. Everything on it is destroyed.
                      Omit to only assemble the payload directory.
  --latest            Take the newest GitHub release
  --version vX.Y.Z    Take a specific release
  --token TOKEN       GitHub token written into kiosk.conf, so the kiosk can
                      install private dependencies and self-update. Read-only
                      access to this repo's contents and packages is enough.
  --iso PATH          Debian netinst ISO (default: download current stable)
  --anydesk-password PW
                      Password for unattended remote access, written into
                      kiosk.conf. Without one, a remote session has to be
                      accepted on the kiosk's touchscreen.
  --deps PATH         Offline dependency archive from a provisioned kiosk
                      (provision-kiosk.sh --export-deps), for sites with no
                      internet during setup
  --out DIR           Where to assemble the payload (default: a temp dir, or
                      ./provision-stick when no --device is given)
  --yes               No confirmation prompt before writing the stick
  -h, --help          This text
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)  DEVICE="$2"; shift 2 ;;
    --iso)     ISO="$2"; shift 2 ;;
    --latest)  VERSION="latest"; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    --token)   TOKEN="$2"; shift 2 ;;
    --anydesk-password) ANYDESK_PASSWORD="$2"; shift 2 ;;
    --deps)    DEPS="$2"; shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$OUT" ]] || OUT="$([[ -n "$DEVICE" ]] && mktemp -d || echo "$REPO_ROOT/provision-stick")"
mkdir -p "$OUT"

# --- payload --------------------------------------------------------------

log "Assembling payload in $OUT"

cp "$SCRIPT_DIR/provision-kiosk.sh" "$OUT/"
chmod +x "$OUT/provision-kiosk.sh"
ok "provision-kiosk.sh"

if [[ -n "$VERSION" ]]; then
  command -v gh >/dev/null || die "The GitHub CLI (gh) is needed to download a release. Install it, or pass the archive in with --out and copy it by hand."
  gh auth status >/dev/null 2>&1 || die "gh is not logged in: run 'gh auth login'."
  rm -f "$OUT"/app-v*.tar.gz "$OUT/checksum.sha256"
  if [[ "$VERSION" == "latest" ]]; then
    gh release download --repo "$REPO" --pattern 'app-v*.tar.gz' --pattern 'checksum.sha256' -D "$OUT" --clobber
  else
    gh release download "$VERSION" --repo "$REPO" --pattern 'app-v*.tar.gz' --pattern 'checksum.sha256' -D "$OUT" --clobber
  fi
  ok "$(basename "$(ls -1 "$OUT"/app-v*.tar.gz | tail -1)") with checksum"
else
  ls -1 "$OUT"/app-v*.tar.gz >/dev/null 2>&1 \
    && ok "Release archive already in the payload: $(basename "$(ls -1 "$OUT"/app-v*.tar.gz | tail -1)")" \
    || warn "No release archive — pass --latest or --version, or copy app-vX.Y.Z.tar.gz into $OUT by hand"
fi

# The speech model ships with no release (gitignored, and CI never fetches it),
# and adding ~45 MB to every hourly self-update over a mobile link would be the
# wrong fix. It goes on the stick and is provisioned once per machine.
if [[ -s "$OUT/vosk-model-de.tar.gz" ]]; then
  ok "Speech model already in the payload"
elif [[ -s "$REPO_ROOT/ui/public/vosk-model-de.tar.gz" ]]; then
  cp "$REPO_ROOT/ui/public/vosk-model-de.tar.gz" "$OUT/"
  ok "Speech model taken from ui/public/"
else
  tmp="$(mktemp -d)"
  if curl -fL# -o "$tmp/model.zip" "$VOSK_URL"; then
    unzip -q "$tmp/model.zip" -d "$tmp"
    mv "$tmp"/vosk-model-small-de-* "$tmp/model"
    tar -czf "$OUT/vosk-model-de.tar.gz" -C "$tmp" model
    ok "Speech model downloaded and repackaged ($(du -h "$OUT/vosk-model-de.tar.gz" | cut -f1))"
  else
    warn "Speech model download failed — voice commands will stay off on kiosks built from this stick"
  fi
  rm -rf "$tmp"
fi

if [[ -n "$DEPS" ]]; then
  cp "$DEPS" "$OUT/node_modules.tar.gz"
  ok "Offline dependencies ($(du -h "$OUT/node_modules.tar.gz" | cut -f1)) — this stick provisions without internet"
fi

umask 077
cat > "$OUT/kiosk.conf" <<CONF
# Defaults for provision-kiosk.sh. Written by make-provision-stick.sh.
#
# This file carries a GitHub token and the remote-access password, so the stick
# belongs with the service team and nowhere else. The token needs read-only
# access to this repo's contents (releases) and packages, and can be rotated
# without touching a kiosk — until the next provisioning, a kiosk only uses it
# for update checks.
GITHUB_OWNER="${REPO%%/*}"
GITHUB_REPO="${REPO##*/}"
GITHUB_TOKEN="$TOKEN"
# Unattended remote access. One password for the fleet is the usual choice;
# pass --anydesk-password per stick if you would rather not have that.
ANYDESK_PASSWORD="$ANYDESK_PASSWORD"
NODE_MAJOR=24
PORT=3000
CONF
umask 022
[[ -n "$ANYDESK_PASSWORD" ]] && ok "kiosk.conf carries the AnyDesk password (unattended access)" || warn "kiosk.conf without an AnyDesk password — remote sessions must be accepted on the touchscreen"
[[ -n "$TOKEN" ]] && ok "kiosk.conf with token" || warn "kiosk.conf without a token — the kiosk then needs --deps for dependencies, and GitHub self-updates stay off"

cat > "$OUT/README.txt" <<'STICKREADME'
Implenia Kiosk — provisioning stick
===================================

1. Boot the kiosk PC from this stick and install Debian.
   The BIOS settings and the installer answers are in
   docs/kiosk-provisioning.md. Short version: user "kiosk", empty root
   password, deselect every software collection except "SSH server" and
   "standard system utilities".

2. Log in as "kiosk" after the first boot, plug this stick back in and run:

     sudo mkdir -p /media/prov
     sudo mount /dev/disk/by-label/KIOSK-PROV /media/prov
     /media/prov/provision-kiosk.sh --hostname kiosk-<rig>

   It takes 10-15 minutes and ends by asking to reboot. Say yes: the machine
   has to come up into the kiosk on its own, and that is the test.

3. On site, the touchscreen wizard asks for the Verfahren, the data source and
   the MQTT settings. The on-screen keyboard appears by itself when a field is
   tapped — no USB keyboard needed from here on.

4. Note the AnyDesk ID the script prints at the end. It is appended to
   machines.tsv on this stick when it is writable, and the kiosk also shows it
   under Einstellungen -> System.

Re-running provision-kiosk.sh is safe — it repairs a machine rather than
duplicating anything, and keeps the database, the .env and recorded data.
STICKREADME
ok "README.txt"

du -sh "$OUT" | awk '{printf "    payload size: %s\n", $1}'

[[ -n "$DEVICE" ]] || { log "Done"; echo "  Payload assembled in $OUT."; echo "  Copy it onto the KIOSK-PROV partition of a prepared stick, or re-run with --device to build one."; exit 0; }

# --- the stick ------------------------------------------------------------

log "Preparing $DEVICE"

# Checked before anything is written, not when it is needed: mkfs.vfat lives in
# dosfstools and is missing on plenty of workstations, and discovering that
# after the image is on the stick leaves a half-built one.
missing=()
for tool in dd sfdisk mkfs.vfat partprobe udevadm; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "Missing: ${missing[*]}
    Debian/Ubuntu:  sudo apt install dosfstools parted util-linux
    Arch:           sudo pacman -S dosfstools parted util-linux"
fi

[[ -b "$DEVICE" ]] || die "$DEVICE is not a block device."
base="$(basename "$DEVICE")"
[[ "$(cat "/sys/block/$base/removable" 2>/dev/null || echo 0)" == "1" ]] \
  || die "$DEVICE is not a removable device. Refusing — this writes a disk image over it."
findmnt -n --source "$DEVICE" >/dev/null 2>&1 && die "$DEVICE has mounted partitions. Unmount them first."
for p in "$DEVICE"?*; do findmnt -n --source "$p" >/dev/null 2>&1 && die "$p is mounted. Unmount it first."; done

if [[ -z "$ISO" ]]; then
  log "Debian ISO"
  mkdir -p "$REPO_ROOT/.cache"
  (
    cd "$REPO_ROOT/.cache"
    curl -fsSL -o SHA256SUMS "$ISO_BASE/SHA256SUMS"
    # Read the filename out of the checksum file rather than hardcoding a point
    # release: current/ moves with every Debian update.
    name="$(awk '$2 ~ /-amd64-netinst\.iso$/ && $2 !~ /edu|mac/ { print $2 }' SHA256SUMS | head -1)"
    [[ -n "$name" ]] || exit 1
    [[ -f "$name" ]] || curl -fL# -o "$name" "$ISO_BASE/$name"
    sha256sum -c --ignore-missing SHA256SUMS >/dev/null || { rm -f "$name"; exit 1; }
    echo "$name" > .iso-name
  ) || die "Could not download or verify the Debian ISO."
  ISO="$REPO_ROOT/.cache/$(cat "$REPO_ROOT/.cache/.iso-name")"
  ok "$(basename "$ISO") verified against SHA256SUMS"
fi
[[ -f "$ISO" ]] || die "ISO not found: $ISO"

printf '\n\033[1;31m    Everything on %s (%s, %s) will be destroyed.\033[0m\n' \
  "$DEVICE" \
  "$(lsblk -dno SIZE "$DEVICE" | tr -d ' ')" \
  "$(lsblk -dno MODEL "$DEVICE" | sed 's/ *$//')"
if [[ $ASSUME_YES -eq 0 ]]; then
  read -r -p "    Type the device name to confirm ($DEVICE): " answer
  [[ "$answer" == "$DEVICE" ]] || die "Not confirmed."
fi

log "Writing the installer image"
sudo dd if="$ISO" of="$DEVICE" bs=4M status=progress oflag=sync conv=fsync
sudo partprobe "$DEVICE" 2>/dev/null || true
sudo udevadm settle
ok "$(basename "$ISO") written"

log "Adding the payload partition"
before="$(lsblk -nlo NAME "$DEVICE" | tail -n +2)"
# Appended after the image's own partitions, in the free space a stick this size
# has left over. The image's partition entries are untouched, so it still boots.
echo "start=,size=$PAYLOAD_PART_SIZE,type=c" | sudo sfdisk --append --no-reread "$DEVICE" >/dev/null
sudo partprobe "$DEVICE" 2>/dev/null || true
sudo udevadm settle
sleep 1
after="$(lsblk -nlo NAME "$DEVICE" | tail -n +2)"
part="/dev/$(comm -13 <(echo "$before" | sort) <(echo "$after" | sort) | head -1)"
[[ -b "$part" ]] || die "The payload partition did not appear. The stick still has a working installer — copy the payload from $OUT onto a second stick instead."
sudo mkfs.vfat -F 32 -n KIOSK-PROV "$part" >/dev/null
ok "$part formatted as KIOSK-PROV"

mnt="$(mktemp -d)"
sudo mount "$part" "$mnt"
sudo cp -r "$OUT"/. "$mnt"/
sudo sync
sudo umount "$mnt"
rmdir "$mnt"
ok "Payload copied"

log "Done"
cat <<SUMMARY
  $DEVICE is now both the Debian installer and the provisioning payload.

  On the kiosk PC:
    1. Boot from it, install Debian (docs/kiosk-provisioning.md)
    2. Log in as kiosk, plug the stick back in, then:
         mkdir -p /media/prov && sudo mount /dev/disk/by-label/KIOSK-PROV /media/prov
         /media/prov/provision-kiosk.sh --hostname kiosk-<rig>

SUMMARY
