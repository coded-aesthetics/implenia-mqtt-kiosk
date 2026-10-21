#!/usr/bin/env bash
#
# Tests provision-kiosk.sh's migrate_ifupdown_wifi.
#
#     ./scripts/test-wlan-migration.sh
#
# That function rewrites /etc/network/interfaces, which is the file a machine
# needs to reach the network at all — and it runs on machines whose only link is
# the interface being migrated. An awk program that is one state-machine bug
# away from leaving a kiosk with no network is not something to eyeball.
#
# The function text is lifted out of the script with sed rather than copied, so
# this tests what ships. `provision-kiosk.sh` only runs `main` when executed and
# not when sourced, for the same reason.
#
# Stubs stand in for sudo, nmcli and systemctl; the fixture replaces the real
# /etc/network/interfaces path. Nothing here touches this machine.
set -uo pipefail
REPO="/home/jan/dev/implenia/implenia-mqtt-kiosk"
TMP="$(mktemp -d)"
sed -n '/^migrate_ifupdown_wifi() {/,/^}/p' "$REPO/scripts/provision-kiosk.sh" > "$TMP/func.sh"
[[ -s "$TMP/func.sh" ]] || { echo "could not extract the function"; exit 1; }

PASS=0; FAIL=0
check() {
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n    expected: %q\n    actual:   %q\n' "$1" "$2" "$3"; fi
}

# Stubs.
sudo() { "$@"; }
systemctl() { return 0; }
warn() { WARNED="$*"; }
ok() { OKED="$*"; }
DEV_STATE="unmanaged"
nmcli() {
  if [[ "${1:-}" == "-t" ]]; then echo "$CUR_DEV:$DEV_STATE"; return 0; fi
  if [[ "${1:-}" == "connection" && "${2:-}" == "add" ]]; then NMCLI_ARGS="$*"; return 0; fi
  return 0
}

run_case() { # name device content
  CUR_DEV="$2"; FILE="$TMP/interfaces"; printf '%s' "$3" > "$FILE"
  NMCLI_ARGS=""; WARNED=""; OKED=""; NEEDS_REBOOT=0
  # Re-source per case and repoint the hardcoded path at the fixture.
  eval "$(sed "s#file=/etc/network/interfaces#file=\"$FILE\"#" "$TMP/func.sh")"
  printf '\n── %s\n' "$1"
  migrate_ifupdown_wifi "$2"
  RESULT="$(cat "$FILE")"
  # SHOW=1 prints each resulting file, which is how you read a failure.
  [[ "${SHOW:-}" == "1" ]] && { echo "--- resulting file ---"; cat "$FILE"; echo "---"; }
}

COLLEAGUE='# This file describes the network interfaces available on your system
# and how to activate them. For more information, see interfaces(5).

source /etc/network/interfaces.d/*

# The loopback network interface
auto lo
iface lo inet loopback

# The primary network interface
allow-hotplug wlp3s0
iface wlp3s0 inet dhcp
        wpa-ssid IP-Portscanner_0
        wpa-psk  74207420
'
run_case "colleague's machine: wlp3s0 dhcp + wpa" wlp3s0 "$COLLEAGUE"
check "no wireless config lines" "0" "$(grep -cE "^[[:space:]]*(iface|auto|allow-hotplug)[[:space:]]+wlp3s0" <<<"$RESULT")"
check "wpa-ssid gone"        "0" "$(grep -c 'wpa-ssid' <<<"$RESULT")"
check "wpa-psk gone"         "0" "$(grep -c 'wpa-psk' <<<"$RESULT")"
check "loopback kept"        "1" "$(grep -c 'iface lo inet loopback' <<<"$RESULT")"
check "source line kept"     "1" "$(grep -c 'interfaces.d' <<<"$RESULT")"
check "profile ssid"         "1" "$(grep -c 'ssid IP-Portscanner_0' <<<"$NMCLI_ARGS")"
check "profile psk"          "1" "$(grep -c 'wifi-sec.psk 74207420' <<<"$NMCLI_ARGS")"
check "autoconnect yes"      "1" "$(grep -c 'connection.autoconnect yes' <<<"$NMCLI_ARGS")"
check "reboot flagged"       "1" "$NEEDS_REBOOT"
check "no warning"           ""  "$WARNED"

WIRED='source /etc/network/interfaces.d/*

auto lo
iface lo inet loopback

allow-hotplug enp1s0
iface enp1s0 inet dhcp
iface enp1s0 inet6 auto
'
run_case "wired install: no wireless stanza" wlp3s0 "$WIRED"
check "file untouched"       "$(printf '%s' "$WIRED")" "$RESULT"
check "warned not migrated"  "1" "$(grep -c 'not in' <<<"$WARNED")"
check "no profile built"     ""  "$NMCLI_ARGS"

STATIC='auto lo
iface lo inet loopback

auto wlp3s0
iface wlp3s0 inet static
        address 192.168.1.50/24
        wpa-conf /etc/wpa_supplicant/wpa_supplicant.conf

auto eth0
iface eth0 inet dhcp
'
run_case "wpa-conf / static: refuses" wlp3s0 "$STATIC"
check "file untouched"       "$(printf '%s' "$STATIC")" "$RESULT"
check "warned about form"    "1" "$(grep -c 'will not migrate' <<<"$WARNED")"
check "no profile built"     ""  "$NMCLI_ARGS"

QUOTED='auto lo
iface lo inet loopback

auto wlp3s0
iface wlp3s0 inet dhcp
        wpa-ssid "Implenia Box G08"
        wpa-psk  "geheim 123"

auto eth0
iface eth0 inet dhcp
'
run_case "quoted ssid with spaces, trailing stanza" wlp3s0 "$QUOTED"
check "ssid unquoted"        "1" "$(grep -c 'ssid Implenia Box G08' <<<"$NMCLI_ARGS")"
check "psk unquoted"         "1" "$(grep -c 'wifi-sec.psk geheim 123' <<<"$NMCLI_ARGS")"
check "later stanza kept"    "1" "$(grep -c 'iface eth0 inet dhcp' <<<"$RESULT")"
check "no wireless config lines" "0" "$(grep -cE "^[[:space:]]*(iface|auto|allow-hotplug)[[:space:]]+wlp3s0" <<<"$RESULT")"

DEV_STATE="connected"
run_case "already managed: does nothing" wlp3s0 "$COLLEAGUE"
check "file untouched"       "$(printf '%s' "$COLLEAGUE")" "$RESULT"
check "no profile built"     ""  "$NMCLI_ARGS"
check "reported ok"          "1" "$(grep -c 'manages wlp3s0' <<<"$OKED")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
rm -rf "$TMP"
[[ $FAIL -eq 0 ]]
