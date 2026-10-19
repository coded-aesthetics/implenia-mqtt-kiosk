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
1024x768 capacitive touch, 10 points. Ships with Windows; the shipped disk is
imaged before wiping, so the disk can be erased without further thought.

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
the stick, appends a second partition `KIOSK-PROV`, and fills that with the
release archive, the speech model, `provision-kiosk.sh` and a `kiosk.conf`
holding the token. One stick is therefore both the installer and the payload,
and it is reusable on every machine — nothing an install does changes it.

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
| Restore on AC Power Loss | **Power On** | The cabinet gets power when the rig does, and nobody will look for a power button behind the monitor |
| SATA mode | **AHCI** | Not IDE/RAID |
| Fast Boot | **Disabled** | Otherwise the USB keyboard is not up in time to reach the boot menu |
| Secure Boot | **Disabled** | Simpler; nothing here needs it |
| Boot order | Internal disk first, after the install | A stick left in the machine must not strand it in an installer |

## 3. Debian installer

Boot the stick, pick **Graphical install**, and answer:

| Step | Answer |
|---|---|
| Language / location | English, Germany, locale `de_DE.UTF-8` |
| Keyboard | German |
| Hostname | `kiosk-<rig>`, e.g. `kiosk-g08`. Domain blank |
| Root password | **Leave empty** — the first user then gets `sudo`, which the provisioning script needs |
| User | Full name `Kiosk`, username **`kiosk`** |
| Partitioning | Guided – use entire disk, all files in one partition. **Check the target is the internal disk, not the stick** |
| Mirror | `deb.debian.org`, no proxy |
| Popularity contest | No |
| Software selection | **Deselect everything** except *SSH server* and *standard system utilities* |
| GRUB | Install to the internal disk |

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
| App | Extracts the release archive into `/opt/kiosk` | Exactly what the self-updater does, so `kiosk.db`, `.env`, `node_modules` and the speech model survive it. Verifies `checksum.sha256` first |
| Dependencies | `npm install --omit=dev --no-workspaces` inside `server/`, or the offline archive | The bundle's root `package.json` declares `workspaces: ["server","ui"]` but ships no `ui/package.json`, so a root install fails. `server/node_modules` is where Node resolves from for `server/dist/*` anyway. An `.npmrc` with the token is written because `@coded-aesthetics/din4023` is a private GitHub Packages dependency and the bundle carries no `.npmrc`. It then loads `better-sqlite3` to prove the native modules match this machine |
| Config | `.env` from `.env.example`, sets `PORT`, `NODE_ENV`, `GITHUB_OWNER/REPO/TOKEN`, `chmod 600` | Everything else — broker, Verfahren, API credentials — is site configuration and belongs in the wizard, not on a stick |
| Speech model | `ui/dist/vosk-model-de.tar.gz` from the stick, or downloaded | **No release contains it**: it is gitignored and CI never runs `download-vosk-model.sh`, so voice commands are silently off on a kiosk installed from a release. Shipping it in the bundle would add ~45 MB to every hourly update check's download over a mobile link, so it is provisioned once and survives updates |
| Service | PM2, `kiosk-server`, systemd startup, `pm2 save` | The updater restarts by exiting and letting PM2 bring it back. Then waits for `/status` to answer before declaring success |
| Session | agetty autologin on tty1 → `startx` → `~/.xinitrc` | No display manager: one less service, ~150 MB less RAM, and the recovery path is a login |
| Remote access | AnyDesk from its own apt repo, service enabled, unattended password set, id recorded | See [Remote access](#remote-access-anydesk). Never fatal: a kiosk that records and uploads but cannot be reached is still a kiosk |

### The kiosk session

`~/.xinitrc` is the whole front end, and four things in it are load-bearing:

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
`~/.xinitrc.bak` — but remember that re-running provisioning overwrites it.

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

Provisioning needs the network for exactly two things: NodeSource and the npm
dependencies. Both can travel on the stick.

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

- **No unattended-upgrades.** It downloads packages, and the link on site is
  metered mobile — the same link the data reduction exists to spare. OS updates
  are a service task, done deliberately with a wired connection
- **No desktop environment, no display manager, no file manager.** Every one of
  them is RAM this machine does not have and a surface a worker could land in
- **`--max-restarts` is not capped** for `kiosk-server`, unlike
  `scripts/install-service.sh`. A kiosk that gives up needs a site visit; one
  that keeps retrying every 5 s recovers by itself when a transient cause clears
- **`scripts/kiosk.desktop` is not used.** It belongs to an install that has a
  desktop environment honouring `/etc/xdg/autostart`; a provisioned kiosk
  launches Chromium from `~/.xinitrc`

## Troubleshooting

Reach a shell with `Ctrl+Alt+F2` (the kiosk session is on tty1), or over SSH.

| Symptom | Cause and fix |
|---|---|
| Black screen after boot | X failed to start. `Ctrl+Alt+F2`, `startx` by hand and read the error. Missing `~/.xinitrc` → re-run provisioning |
| Chromium shows "site cannot be reached" | The server is down: `pm2 logs kiosk-server`. The session waits for `/status`, so this means it answered once and stopped |
| Screen goes blank after minutes | `xset` line missing from `~/.xinitrc` — re-run provisioning |
| Random freezes, no logs | `cat /proc/cmdline | grep max_cstate`. If empty, the GRUB step did not take effect — re-run provisioning and reboot |
| **Touch does nothing at all, mouse works** | udev mis-classified the controller, which is the normal state on this panel. Its eGalax/D-WAV SAW controller (`0eef:0001`) claims pen *and* finger tools, so libinput rejects the interface named "Touchscreen" (`missing tablet capabilities: resolution`) and adds another as a touchpad with pointer acceleration — the kernel sees every touch, X maps none to a coordinate. Provisioning installs `/etc/udev/rules.d/99-egalax-touchscreen.rules` to force the class; on a machine provisioned before that, re-run provisioning and reboot. Confirm with `DISPLAY=:0 xinput list`, and `~/.local/share/xorg/Xorg.0.log` is where the rejection is visible |
| Touch taps land in the wrong place | `DISPLAY=:0 xinput list` for the id, then a calibration matrix: `xinput set-prop <id> "libinput Calibration Matrix" <9 floats>`. eGalax panels commonly need an inverted or swapped axis. Put the working command in `~/.xinitrc` so it survives a reboot |
| Voice commands do nothing | `ls -l /opt/kiosk/ui/dist/vosk-model-de.tar.gz`. Missing → provision it: that file is in no release |
| A USB update stick is not detected | `findmnt /media/*` — nothing there means `udiskie` is not running (check `~/.xinitrc`). `USB_UPDATE_PATHS` defaults to `/media` |
| No update banner ever | Private repo without a token: `grep GITHUB /opt/kiosk/.env`. Also `curl localhost:3000/api/logs?module=updater` |
| "Restore pages?" bubble after power loss | The `Preferences` rewrite in `~/.xinitrc` is missing — re-run provisioning |
| No AnyDesk ID on the settings screen | `cat /opt/kiosk/anydesk-id.txt`. Empty or missing → the service had not registered when provisioning ran: `sudo anydesk --get-id`, write it into that file, no restart needed |
| AnyDesk connects but the screen is black | The service is not capturing the X session. Add `anydesk &` to `~/.xinitrc` before the Chromium loop and reboot. It is not there by default because the AnyDesk window would appear over the kiosk |
| `apt install anydesk` fails on unmet dependencies | `libgcc1` — re-run provisioning, which builds the shim package, or install it by hand (see [Remote access](#remote-access-anydesk)) |
| `anydesk --set-password` fails silently | It rejects weak passwords. Use a longer one |
| The on-screen keyboard never appears | It is enabled by `any-pointer: coarse`. On a machine with no touchscreen, force it: `localStorage.touchKeyboard = 'on'` in the browser console. `'off'` disables it |
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
