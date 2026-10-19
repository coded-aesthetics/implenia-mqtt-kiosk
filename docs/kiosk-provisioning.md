# Kiosk Provisioning (Debian)

How to turn a bare industry PC into a kiosk that boots into the app, recovers
from power loss and self-updates. Two commands do the work; the rest of this
document is the part that cannot be scripted — BIOS settings, the Debian
installer, and what to check before the machine leaves for a site.

Budget **45 minutes** per machine, most of it waiting.

```
office, once per release        on the machine, once per machine
┌──────────────────────────┐    ┌───────────────────────────────────┐
│ make-provision-stick.sh  │ →  │ BIOS → Debian installer →         │
│  Debian ISO + payload    │    │ provision-kiosk.sh → reboot       │
└──────────────────────────┘    └───────────────────────────────────┘
                                             ↓
                                  on site: the touchscreen wizard
```

## The target machine

Senor Tech **iSPOS 195 P V** — Celeron J1900 (Bay Trail, 4 cores), 4 GB RAM,
1024x768. Ships with Windows; the shipped disk is imaged before wiping, so it
can be erased without further thought.

The touch panel is an **eGalax/D-WAV Titan6001 Surface Acoustic Wave**
controller (`0eef:0001`), **single touch** — not the 10-point capacitive panel
the spec sheet suggested. SAW responds to a gloved finger, which is what
matters on site, and also to a resting palm or a water drop, which capacitive
would ignore. There is no multi-touch on this hardware, so no gesture can be
designed for it. It also needs a udev rule before X will use it at all — see
[the troubleshooting table](#troubleshooting).

Anything else x86_64 works, but the two hardware-specific decisions below
(`intel_idle.max_cstate=1`, no desktop environment) are made for this one.

## The kit

- The provisioning stick (built below). 8 GB is enough; a larger one is fine
- **A USB keyboard.** The Debian installer is not touch-driven
- A wired network connection with internet, unless the stick carries the
  offline dependency archive (see [Sites with no internet](#sites-with-no-internet))
- The GitHub token for the service team

## 1. Build the stick — office, once per release

```bash
./scripts/make-provision-stick.sh --device /dev/sdX --latest \
  --token ghp_… --anydesk-password '<fleet password>'
```

It downloads and verifies the current Debian stable netinst image, writes it to
the stick, appends a second partition `KIOSK-PROV`, and fills that with
`provision-kiosk.sh`, the speech model and a `kiosk.conf` holding the token.
One stick is therefore both the installer and the payload, and it is reusable
on every machine — nothing an install does changes it.

**The release archive is not on it, on purpose.** Provisioning fetches the
newest GitHub release itself, so a stick cannot age into installing old code —
which it otherwise does silently, and the person who then reports the
long-fixed bugs is the one least able to know they were fixed. `--latest` still
puts an archive on the stick for a pinned version or a machine that cannot
reach GitHub.

That second partition is new empty space, so it needs a filesystem written into
it; `mkfs.vfat` (from `dosfstools`) is what does that, and any other filesystem
needs its own `mkfs` just the same. The builder uses **vfat** when it can and
falls back to **ext4**, which Debian reads just as well — the only thing vfat
buys is a colleague on Windows or macOS being able to drop a newer release onto
the stick. `--filesystem` forces either.

Find the device first and be sure of it — `dd` does not ask twice:

```bash
lsblk -o NAME,SIZE,TRAN,MODEL      # match size AND model
```

The script refuses a device that is not removable or has anything mounted, and
asks you to type the device name. To refresh an existing stick with a new
release, leave `--device` out: it assembles the payload into `./provision-stick`
and you copy that onto the `KIOSK-PROV` partition.

## 2. BIOS — AMI, `DEL` at power-on (`F2`/`ESC` on some revisions; boot menu `F7`/`F11`)

| Setting | Value | Why |
|---|---|---|
| Restore on AC Power Loss | **Look for it; this revision has none** | See the note below — it is not a blocker for getting a machine up, but it decides whether a kiosk comes back on its own after a power cut |
| Fast Boot | **Disabled** | Otherwise the USB keyboard is not up in time to reach the boot menu |
| Quiet Boot | **Disabled** | Shows POST and the boot-menu key prompt instead of a logo |
| mSATA/PCIe Control | **Leave as found** | The slot is muxed: an mSATA SSD is invisible to the installer while this says `PCIe`. On the machines seen so far it ships on `PCIe` and the disk is elsewhere, so leave it — and only switch it to `mSATA` if the partitioner finds no disk |
| Boot order | Internal disk first, after the install | A stick left in the machine must not strand it in an installer |

**Not on this board**, though generic AMI guides list them: *SATA mode* (Bay Trail is
AHCI-only, nothing to set) and *Secure Boot* (no UEFI Secure Boot in this
firmware, so the install is legacy BIOS and GRUB goes to the MBR — Debian
detects that by itself).

### Open: this revision does not come back by itself after a power cut

The BIOS on the first machine (2026-10-19) has **no** restore-on-AC-power-loss
setting under any of its names. After mains is removed and restored, the
machine stays off until somebody presses the power button — behind the monitor.

Deliberately deferred rather than solved, because it does not block an install.
It matters as soon as a machine's socket is switched rather than permanent:
then it needs a press every morning, by the people least able to care about it.
Three ways out, in order of preference, for whoever picks this up:

- **Another name for the same setting.** `State After G3` is AMI's own term and
  the likeliest label, under **Chipset → South Bridge**. `Power Mode: AT / ATX`
  is the POS-board idiom and is *better* — in AT mode the machine powers up
  whenever mains is applied and the power button stops mattering. Also
  `AC Back Function`, `PWRON After PWR-Fail`, `Power On by AC`.
- **A mainboard jumper.** POS boards commonly carry an AT/ATX select jumper
  that does it in hardware. Needs the unit opened and the service manual.
- **A daily RTC wake**, armed from Linux (`/sys/class/rtc/rtc0/wakealarm`) by a
  systemd unit on shutdown, so the machine returns by itself once mains is
  back. Needs *Wake system from S5 by RTC* in the BIOS, which boards often have
  even without AC-loss restore. Cruder: it recovers at the next alarm, not in
  seconds.

## 3. Debian installer

Boot the stick, pick **Graphical install**, and answer:

| Step | Answer |
|---|---|
| Language / location | English, then **`other` → Europe → Germany** — Germany is not in the first list when the language is English |
| Locale | **Any `en_*.UTF-8`.** `de_DE.UTF-8` is *not offered*: the list only carries locales for the language picked, so choosing English rules German out. It does not matter — provisioning runs `locale-gen de_DE.UTF-8` and `update-locale` itself, and the app formats every date and number with an explicit `'de-DE'` in JS rather than from the system locale. Pick Deutsch as the *language* at the top if you want the installer itself in German |
| Keyboard | German |
| Hostname | `kiosk-<rig>`, e.g. `kiosk-g08`. Domain blank |
| Root password | **Leave empty** — the first user then gets `sudo`, which the provisioning script needs |
| User | Full name `Kiosk`, username **`kiosk`** |
| Partitioning | Guided – use entire disk, all files in one partition. **Pick the disk by its model string, never by its device letter** — see below |
| Mirror | `deb.debian.org`, no proxy |
| Popularity contest | No |
| Software selection | **Deselect everything** except *SSH server* and *standard system utilities* |
| GRUB | Install to the internal disk |

**At the partitioning step, pick the disk by model, not by letter.** The SSD and
the installer stick are both `/dev/sd?`, and the order depends on enumeration —
the stick can perfectly well be `sda`. The installer prints both with their
models:

```
SCSI1 (0,0,0) (sda) - 64.0 GB ATA ADATA ISSS316-…      ← the internal SSD
SCSI2 (0,0,0) (sdb) - 123.5 GB USB SanDisk 3.2Gen1     ← the installer stick
```

Take the ATA/ADATA one. Size separates them too, unless the SSD happens to
match the stick.

No desktop environment: GNOME would spend a third of the 4 GB before Chromium
opens. The session is set up by the next step instead, and is a single Chromium
under Openbox.

## 4. Provision

Log in as `kiosk` on the console, plug the stick back in:

```bash
sudo mkdir -p /media/prov
sudo mount -o uid=$(id -u) /dev/disk/by-label/KIOSK-PROV /media/prov
/media/prov/provision-kiosk.sh --hostname kiosk-g08
```

`/media` belongs to root, hence the `sudo` on both — and the stick's own
`README.txt` carries the exact mount command for the filesystem it was built
with, which is the one to use:

- **vfat** needs `-o uid=$(id -u)`. A plain `sudo mount` of a FAT partition
  gives every file to root, and provisioning then cannot append this machine to
  `machines.tsv` — it skips the register silently, and that register is the one
  record of the fleet's AnyDesk ids.
- **ext4** takes no `uid=` option at all (and `mount` refuses it): ownership
  comes from the filesystem, which the stick builder sets to uid 1000, the
  first user the Debian installer creates.

Only the first run needs any of this. Once the kiosk session is up, `udiskie`
mounts the stick itself, as the kiosk user, at `/media/kiosk/KIOSK-PROV`.

Ten to fifteen minutes, then it offers a reboot. **Take it** — the machine
coming up into the kiosk by itself is the only test that matters here.

The script is idempotent. Re-running it repairs a machine somebody has fiddled
with, keeps `kiosk.db`, `.env` and recorded data, and is the supported way to
move a kiosk to a new release by hand. `--help` lists the options; the ones
worth knowing are `--bundle` (install a specific release archive), `--no-vosk`
(skip the 45 MB speech model) and `--export-deps` (below).

### What it does, and why

| Step | What | Why |
|---|---|---|
| System | Hostname, `Europe/Berlin`, `de_DE.UTF-8`, X + Openbox + Chromium + `unclutter`, `udiskie`, `avahi-daemon` | `--no-install-recommends` throughout: no print spooler, no mail agent, no desktop. `udiskie` mounts USB sticks under `/media`, which is where `USB_UPDATE_PATHS` looks — with no desktop environment nothing would mount them otherwise. `avahi` makes the machine reachable as `kiosk-g08.local` for service SSH |
| Kernel | `intel_idle.max_cstate=1` | Bay Trail hangs at random in deep C-states. A frozen screen on site is the failure this product exists to avoid, so the workaround goes on every machine rather than waiting for a report |
| Swap | zram, 50% of RAM, zstd | 4 GB shared with Chromium. Compressed swap in RAM beats swapping to the disk the database is on |
| Node | NodeSource, major 22, **npm 11 over it**, plus PM2 | Two separate pins. Node 22 because better-sqlite3 11.x ships no prebuild for Node 24, so Node 24 compiles it from source and that build aborts on teardown (`Assertion failed: (env) != nullptr`); 22 is the prebuild the project ships, and the major also has to match whatever built an offline dependency archive. npm 11 because Node 22's bundled npm 10.9 **cannot resolve this tree at all** — it dies with `Cannot read properties of null (reading 'edgesOut')`, which is what the Dependencies step looks like without the pin |
| App | **Fetches the newest GitHub release**, verifies `checksum.sha256`, extracts into `/opt/kiosk` | `--version` pins one, `--bundle` installs a local archive, and an archive on the stick is the fallback when GitHub cannot be reached — announced as a warning, since that is how a machine ends up on an old version without anybody choosing it. Extracting is what the self-updater does, so `kiosk.db`, `.env`, `node_modules` and the speech model survive |
| Dependencies | `npm install --omit=dev --no-workspaces` inside `server/`, or the offline archive | The bundle's root `package.json` declares `workspaces: ["server","ui"]` but ships no `ui/package.json`, so a root install fails. `server/node_modules` is where Node resolves from for `server/dist/*` anyway. An `.npmrc` with the token is written because `@coded-aesthetics/din4023` is a private GitHub Packages dependency and the bundle carries no `.npmrc`. It then loads `better-sqlite3` to prove the native modules match this machine |
| Config | `.env` from `.env.example`, sets `PORT`, `NODE_ENV`, `GITHUB_OWNER/REPO/TOKEN`, `chmod 600` | Everything else — broker, Verfahren, API credentials — is site configuration and belongs in the wizard, not on a stick |
| Speech model | **Skipped** unless `--with-vosk` | Voice control is out of scope for the MVP, and the model is 46 MB of an otherwise ~5 MB payload. It is also in no release — gitignored, and CI never runs `download-vosk-model.sh` — so when voice returns it has to come from the stick or a download, never from an update, which would otherwise put 46 MB on every hourly check over a mobile link |
| Service | PM2, `kiosk-server`, systemd startup, `pm2 save` | The updater restarts by exiting and letting PM2 bring it back. Then waits for `/status` to answer before declaring success |
| Session | **lightdm autologin** → `~/.xsession` → Openbox + Chromium | A display manager *is* needed, which the first version of this got wrong by confusing it with a desktop environment. `startx` from a tty autologin never registers a graphical session, so `loginctl` reports `Type=tty` with no `Display`, and anything that asks logind what display server is running — AnyDesk, portals, screen sharing — concludes there is none. GNOME is 1.2 GB; lightdm is single-digit megabytes and shows no greeter when autologin works |
| Remote access | AnyDesk from its own apt repo, service enabled, unattended password set, id recorded | See [Remote access](#remote-access-anydesk). Never fatal: a kiosk that records and uploads but cannot be reached is still a kiosk |

### The kiosk session

`~/.xsession` is the whole front end, and four things in it are load-bearing:

- **Chromium runs in a loop, and X exits with the script.** Chromium killed by
  the OOM killer is back in two seconds; a dead X server ends the session and
  agetty logs straight back in. Nothing here needs a watchdog
- **It waits for `/status` before launching Chromium.** Chromium does not retry
  a failed load, so starting before PM2 has the port open would leave a
  permanent error page on a screen nobody can navigate away from
- **It rewrites Chromium's `exited_cleanly` flag on every start.** Power loss is
  routine on site, and the "Restore pages?" bubble would sit on top of the UI
- **The flags are chosen for gloves on a touchscreen.**
  `--overscroll-history-navigation=0` stops an edge swipe navigating back,
  `--disable-pinch` stops two fingers zooming the 1024x768 layout out of shape,
  and `--use-fake-ui-for-media-stream` grants the microphone without a
  permission prompt nobody could answer (voice commands)

Edit it by hand if you must — the script keeps the previous version as
`~/.xsession.bak` — but remember that re-running provisioning overwrites it.

## Remote access (AnyDesk)

Unattended, because the alternative does not work on a construction site: a
worker cannot be talked through accepting a session, and nobody is driving out
to click Accept. The password comes from `kiosk.conf` on the stick (or
`--anydesk-password`), and `anydesk --set-password` **rejects weak passwords** —
if the step warns, that is usually why.

The machine's **AnyDesk ID** is recorded in three places, because losing it
means a site visit:

- printed at the end of provisioning,
- appended to `machines.tsv` on the stick, when the stick is writable (it is
  not when mounted read-only for the kiosk user — then write it down),
- `/opt/kiosk/anydesk-id.txt`, which the kiosk reads and shows under
  **Einstellungen → System** as a card a worker can read out over the phone.

The id is read from that file rather than from `anydesk --get-id`, which
answers an empty line and exit status 1 for anyone but root — and the server
runs as the kiosk user.

Three things worth knowing:

- **The id does not exist until AnyDesk has reached its own servers.** It
  registers on first run, so provisioning a machine with no internet leaves no
  id. The script waits 20 s and then says so; re-run it once the machine is
  online, or write the id into `/opt/kiosk/anydesk-id.txt` by hand
- **AnyDesk's `.deb` declares `Depends: libgcc1`**, a package name Debian
  dropped after bookworm in favour of `libgcc-s1`. **In practice this did not
  bite:** on the first real install — Debian 13.7, AnyDesk 8.1.0 — apt resolved
  it and the shim was never built. Provisioning carries a shim package that
  provides the name (versioned, since an unversioned `Provides` does not
  satisfy a versioned dependency) and depends on `libgcc-s1`, but it is built
  *only* when apt's own simulation says the dependency is unmet. Treat it as a
  fallback for a future archive state, not as a problem you will meet.
  Repacking AnyDesk's `.deb` instead would have left apt permanently unable to
  satisfy the repo version — a fleet that silently stops getting AnyDesk updates
- **An idle AnyDesk keeps a connection to AnyDesk's servers**, over the metered
  mobile link this project otherwise works hard to spare. It is a keepalive,
  not a stream, but it is not nothing — worth watching on the first pilot
  machine. `--no-anydesk` skips the whole step

Licensing is a commercial question, not a technical one: AnyDesk's free tier is
for personal use, so a fleet on customer sites needs a licence.

## The on-screen keyboard

There is no physical keyboard on a kiosk, so the app brings its own — a German
QWERTZ layout with the umlauts in the letter rows, a digits-and-symbols layer
for broker URLs, and a numeric pad for the decimal fields. It appears when any
input is focused and needs no setup; `scripts/provision-kiosk.sh` installs
nothing for it.

It is **part of the app, not the OS**, which is what lets it keep the house
rules: 64px keys for gloves, the app's own light theme, and — because it is a
flex child of the shell rather than an overlay — it shrinks the content instead
of covering the recording bar. An OS keyboard (`onboard`) would have hidden the
bar, and with it the live depth and the stop button, while somebody typed; and
auto-showing it over Chromium needs `--force-renderer-accessibility`, which
builds an accessibility tree on every DOM change — on a J1900 with sensors
arriving every 290 ms, that is a cost for nothing.

Service personnel still want a real keyboard for the console: either a USB one
or, more usually, their own over AnyDesk.

## 5. On site

The touchscreen wizard asks for **Verfahren → data source (MQTT or serial) →
the settings for that choice**. Both the Verfahren and the transport are
write-once; see *First-start setup* in the README. Nothing else needs typing on
the machine.

Before the machine leaves:

- [ ] Power-cycle it at the socket. It must come up into the element list with
      no keyboard attached
- [ ] Tap through to a detail screen and back — no scrollbars anywhere
- [ ] `pm2 status` shows `kiosk-server` online, `pm2 logs kiosk-server` has no
      repeating errors
- [ ] Tap a text field — the on-screen keyboard appears and the recording bar
      stays visible
- [ ] `ssh kiosk@kiosk-<rig>.local` works from a service laptop
- [ ] **Einstellungen → System** shows the AnyDesk ID, and a test session from
      a service laptop connects without anybody touching the screen
- [ ] The update banner appears, or `curl localhost:3000/api/logs?module=updater`
      shows a successful check (a private repo needs the token in `.env`)

## Sites with no internet

Provisioning needs the network for three things: the GitHub release, NodeSource
and the npm dependencies. All three can travel on the stick — the release via
`--latest` when the stick is built, or `--bundle` at provisioning time.

Build the dependency archive on an already-provisioned kiosk — same hardware,
same Debian release, same Node major — because `better-sqlite3` and
`serialport` are compiled, not portable:

```bash
# on a provisioned kiosk — into the home directory, because the stick is
# mounted read-only for this user
/media/prov/provision-kiosk.sh --export-deps ~/node_modules.tar.gz
sudo cp ~/node_modules.tar.gz /media/prov/        # or copy it off over SSH
```

Then build sticks with `--deps node_modules.tar.gz`, and provisioning runs with
no network at all and no token on the machine. Node still has to come from
somewhere: either the machine gets internet once, or add Debian's own
`nodejs` package from the installer's mirror before provisioning — Debian 13
ships 20.19, which satisfies the `>= 20` requirement and has a better-sqlite3
prebuild of its own.

## Deliberately not done

- **No voice control, for now.** It is out of scope for the MVP, so the 46 MB
  speech model is not installed and `--with-vosk` is what brings it back. The
  audio stack *is* installed regardless — AnyDesk's backend crashes without a
  PulseAudio server — so the machine is ready for voice whenever it returns,
  minus a microphone, which the panel does not have built in
- **No unattended-upgrades.** It downloads packages, and the link on site is
  metered mobile — the same link the data reduction exists to spare. OS updates
  are a service task, done deliberately with a wired connection
- **No desktop environment and no file manager.** Both are RAM this machine does
  not have and a surface a worker could land in. A **display manager is
  installed**, which is not the same thing and was the mistake in the first
  version: lightdm costs single-digit megabytes and is what makes logind
  register a real `x11` session. Its greeter is installed but never shown — if
  autologin ever fails, a greeter is a login prompt, and no greeter is a black
  screen
- **`--max-restarts` is not capped** for `kiosk-server`, unlike
  `scripts/install-service.sh`. A kiosk that gives up needs a site visit; one
  that keeps retrying every 5 s recovers by itself when a transient cause clears
- **`scripts/kiosk.desktop` is not used.** It belongs to an install that has a
  desktop environment honouring `/etc/xdg/autostart`; a provisioned kiosk
  launches Chromium from `~/.xsession`, started by lightdm

## Troubleshooting

Reach a shell with `Ctrl+Alt+F2` (the kiosk session is on tty1), or over SSH.

| Symptom | Cause and fix |
|---|---|
| Black screen after boot | `systemctl status lightdm` and `journalctl -u lightdm -b`. A missing or non-executable `~/.xsession` is the usual cause → re-run provisioning. If autologin failed you get lightdm's greeter, which is a login prompt rather than a dead machine |
| Chromium shows "site cannot be reached" | The server is down: `pm2 logs kiosk-server`. The session waits for `/status`, so this means it answered once and stopped |
| Screen goes blank after minutes | `xset` line missing from `~/.xsession` — re-run provisioning |
| Random freezes, no logs | `cat /proc/cmdline | grep max_cstate`. If empty, the GRUB step did not take effect — re-run provisioning and reboot |
| **Touch does nothing at all, mouse works** | udev mis-classified the controller, which is the normal state on this panel. Its eGalax/D-WAV SAW controller (`0eef:0001`) claims pen *and* finger tools, so libinput rejects the interface named "Touchscreen" (`missing tablet capabilities: resolution`) and adds another as a touchpad with pointer acceleration — the kernel sees every touch, X maps none to a coordinate. Provisioning installs `/etc/udev/rules.d/99-egalax-touchscreen.rules` to force the class; on a machine provisioned before that, re-run provisioning and reboot. Confirm with `DISPLAY=:0 xinput list`, and `~/.local/share/xorg/Xorg.0.log` is where the rejection is visible |
| Touch taps land in the wrong place | `DISPLAY=:0 xinput list` for the id, then a calibration matrix: `xinput set-prop <id> "libinput Calibration Matrix" <9 floats>`. eGalax panels commonly need an inverted or swapped axis. Put the working command in `~/.xsession` so it survives a reboot |
| Voice commands do nothing | Three things in this order: `pactl list sources short` for a microphone the machine can see (the panel has an analog input and no microphone of its own, so one has to be fitted), `pgrep -u kiosk pipewire` for a running sound server, and `ls -l /opt/kiosk/ui/dist/vosk-model-de.tar.gz` for the speech model, which is in no release and is placed by provisioning |
| A USB update stick is not detected | `findmnt /media/*` — nothing there means `udiskie` is not running (check `~/.xsession`). `USB_UPDATE_PATHS` defaults to `/media` |
| No update banner ever | Private repo without a token: `grep GITHUB /opt/kiosk/.env`. Also `curl localhost:3000/api/logs?module=updater` |
| "Restore pages?" bubble after power loss | The `Preferences` rewrite in `~/.xsession` is missing — re-run provisioning |
| No AnyDesk ID on the settings screen | `cat /opt/kiosk/anydesk-id.txt`. Empty or missing → the service had not registered when provisioning ran: `sudo anydesk --get-id`, write it into that file, no restart needed |
| **AnyDesk crashes, session ends with `desk_rt_ipc_error`** | No PulseAudio server. `audio.pa_wrapper - Connection to PulseAudio server failed with Error 6` in `~/.anydesk/anydesk.trace`, and AnyDesk's backend *crashes* rather than carrying on without audio. Provisioning installs `pipewire pipewire-pulse wireplumber`; on an older machine install them and reboot. The same gap silently disables the microphone, so voice commands do nothing either |
| **AnyDesk says "display server not supported (e.g. Wayland)"** on an X11 machine | logind does not know about the session. `loginctl show-session <id> -p Type` must say `x11`; `tty` means the session was started by `startx` rather than a display manager, and every tool that asks logind concludes there is no display server. Fixed by lightdm — re-run provisioning on a machine set up before that. The message's parenthetical is a guess and sends people hunting Wayland for hours |
| AnyDesk connects, then the picture is black | The service sees the session but is not capturing it. `~/.xsession` starts a client in the session for this reason; check it is running with `pgrep -a -u kiosk anydesk` |
| `apt install anydesk` fails on unmet dependencies | `libgcc1` — re-run provisioning, which builds the shim package, or install it by hand (see [Remote access](#remote-access-anydesk)) |
| `anydesk --set-password` fails silently | It rejects weak passwords. Use a longer one |
| The on-screen keyboard never appears | A production build enables it unconditionally, so if it is missing you are looking at a dev build or `localStorage.touchKeyboard` is `'off'`. Builds before 2026-10-19 gated it on `(any-pointer: coarse)` and so hid it whenever the touchscreen was not registered with X — i.e. exactly when it was needed |
| `Error opening terminal: xterm-kitty` over SSH | The client's `TERM` has no terminfo entry on the machine. Provisioning installs `ncurses-term`, which covers kitty, alacritty, wezterm and foot; on a machine provisioned before that, `export TERM=xterm-256color` or `sudo apt install ncurses-term` |
| `npm install` fails with 401/403 | The token is missing, expired, or lacks `read:packages` for `@coded-aesthetics` |

## The token

One read-only GitHub token serves both jobs: `read:packages` to install
`@coded-aesthetics/din4023`, and read access to the repo's contents so the
updater can see releases of a private repo. It lives in `kiosk.conf` on the
stick and in `/opt/kiosk/.env` (mode 600) on each machine.

It can be rotated without visiting a kiosk — until the next provisioning, a
kiosk only uses it for update checks, and a kiosk that cannot check for updates
keeps running and keeps accepting USB updates.
