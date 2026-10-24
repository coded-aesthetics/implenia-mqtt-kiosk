# Implenia Kiosk

Local-first kiosk app for construction sites. Collects sensor data (MQTT or serial), displays live readings in a touch-optimised browser UI, buffers offline, uploads to Implenia REST API when online, self-updates from GitHub Releases.

## Stakeholders

**Construction site workers** — The primary users. They interact with the touchscreen while wearing gloves, often in bright or harsh conditions. The software must get out of the way. No learning curve, no unnecessary interactions, no surprises.

**Service personnel** — Set up industry PCs on site. They need minimal maintenance effort. The app should self-update, auto-recover from crashes (PM2), and require as little manual configuration as possible.

## Resilience

This software must never block construction progress. That is the single most important requirement. A confused worker or a frozen screen directly costs time and money on the ground.

- **Degrade gracefully** — No data source → show last known state. No internet → buffer everything locally. No shift assignment from API → allow manual file upload. Every feature must work offline or fail silently
- **Error states must be recoverable** — Workers must be able to recover from any error without calling service personnel. No dead ends
- **No blocking operations** — Never show a spinner that prevents interaction. Background tasks (uploads, updates, syncs) must not freeze the UI
- **Data integrity over features** — Losing recorded measurements is unacceptable. Buffer locally, retry uploads, never discard data. If an upload fails, keep the data and let the user retry or export it
- **Target resolution: 1024x768** — The stock industry monitor. All layouts must be tested at this resolution. No scrolling, no overflow, no content hidden below the fold

## UI Design Principles

This runs on construction sites, not office desks. Every UI decision should reflect that.

- **Tap targets: minimum 64px x 64px** — Users wear work gloves
- **Font sizes: 2rem+ for values, 1rem+ for everything else** — No text in the UI below 1rem. This includes labels, meta info, badges, timestamps — everything a user might read. `var(--font-sm)` is for non-essential decorative text only, never for information the user needs
- **High contrast** — Light text on dark backgrounds, bold color-coded status (green/red). Avoid `--text-dim` for any text the user needs to read. `--text-muted` is the lowest acceptable contrast for secondary information
- **No fine controls** — No small icons, sliders, or toggles. Everything oversized and obvious
- **No modals or multi-step flows** — Information is always visible, never hidden behind clicks
- **Destructive actions: tap-to-confirm** — No confirmation dialogs. First tap puts the element into a visually distinct "pending" state (solid danger-red background, white text, label changes to "Wirklich {verb}?"), second tap executes. Tapping anything else cancels. The entire element is the tap target — no small confirm/cancel buttons
- **Danger button style** — Default state: `var(--surface-3)` background, `var(--color-danger)` text. Confirmation state: `var(--color-danger)` background, white text. Consistent across all destructive buttons
- **No scrolling** — All content must fit within the viewport. Scrollbars mean the layout is wrong. Workers glance at a screen, they don't scroll. Design layouts to fill available space (e.g. use flex with `min-height: 0`, `modus="vollbild"` for visualizations) rather than overflowing
- **Keep screens shallow** — A screen with more than 3–4 cards or sections is too dense; split it into a hub page with navigation tiles and dedicated sub-screens. This applies especially to settings and configuration, where fields accumulate over time. When adding a new setting, check whether the page it lands on still fits at 1024x768 — if not, introduce a sub-screen rather than making the page scroll. Service-personnel screens (wizard steps, Rohrverlängerung) may scroll when the density is justified, but worker-facing screens never do
- **Landscape-first** — Industry PCs are typically widescreen. Use CSS Grid for responsive tile layouts
- **No emoji** — The kiosk installs `fonts-dejavu-core` and nothing else, so there is no emoji font on the machine: anything above `U+FFFF` renders as a tofu box. `✓` `✕` `⚠` `·` `„" ` `—` are covered and in use; a padlock, a wifi glyph or a warning emoji are not. Check a new symbol on the machine (`fc-list ':charset=<codepoint>' | wc -l`) rather than in a browser on a developer laptop, which has fonts the kiosk does not
- **Minimal text** — Use numbers, colors, and icons over paragraphs. Workers glance, they don't read
- **Language: German** — All UI-facing text must be in German. Code, comments, and documentation stay in English
- **Locale: `de-DE`** — All date/time formatting must use the `'de-DE'` locale. Use `date-fns` with `{ locale: de }` from `date-fns/locale` for formatting and relative times (e.g. `formatDistanceToNow`, `format`). For simple one-off timestamps, `toLocaleTimeString('de-DE')` is acceptable. Never rely on browser defaults
- **Number formatting: German locale, 2 decimal places** — All numeric values must be displayed in German format (comma as decimal separator, period as thousands separator) and rounded to 2 decimal places unless explicitly stated otherwise. Use `toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` for sensor readings and calculated values. Example: `1234.5678` → `"1.234,57"`. Only deviate from 2 decimals when precision requirements differ (e.g. timestamps, counts, percentages with specific precision)
- **Error messages: German, actionable, recoverable** — Every error a user can see must be in German, explain what went wrong, and tell them how to fix it. Workers can't call IT — they need to solve problems themselves. Server-side validation errors are shown to users too, so they must also be German and actionable. Example: not "Invalid JSON" but "Ungültiger Schichtauftrag: Die Datei enthält kein gültiges JSON-Objekt. Bitte eine vom Implenia-Portal exportierte Datei verwenden."

## Voice Commands (Experimental)

Voice control is available as an experimental feature. While workers' hands are often occupied or gloved, the voice interface is being refined on-site to assess real-world usability. Major navigation and actions have voice command support (element navigation, recording control, tab switching, comment dictation). When adding new features that would clearly benefit from hands-free operation, consider adding voice commands (phrases in `voiceCommands.ts`, grammar entries in `useVoskRecognition.ts`, test coverage in `matchCommand.test.ts`) — but it's not mandatory for every UI element.

## Development

```bash
npm run dev      # Server (tsx watch) + UI (Vite) concurrently
npm run build    # Build both server and UI
npm start        # Production: serves UI from server on PORT
```

## Keeping Docs Current

When making changes, keep these files in sync:

- **`README.md`** — Update when adding features, routes, env vars, or changing architecture. This is the entry point for anyone new to the project
- **`.env.example`** (project root) — Update whenever an environment variable is added, removed, or its default changes. Every env var in `config.ts` must have a corresponding entry

## Versioning & Releases

All `package.json` files have `"version": "0.0.0"` in source control. **Never manually bump versions.** CI stamps the version from the git tag during release.

To release:
```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds, stamps the tag version into package.json, bundles `server/dist/` + `ui/dist/` into a `.tar.gz`, generates a SHA256 checksum, and publishes both as a GitHub Release.

The self-updater polls GitHub Releases every five minutes (`UPDATE_CHECK_INTERVAL_MS`), comparing semver against the root `package.json` version. An update is announced by the version indicator in the header — two lines, `von vX` over `auf vY upgraden` — and applying it takes two taps there, the second confirming "Wirklich upgraden?". There is no banner: an update is never urgent, since the kiosk keeps recording and uploading on the version it has, and installing one restarts the app. `POST /api/update` refuses while a recording is running — and because it does, the indicator shrinks to the version plus a small red dot for the duration, with no tap target: an offer the server will decline is a dead end, and the header is carrying the phase stepper at the same time. The full offer returns on its own when the recording ends. The applying state and a failure note are never suppressed, since both report something that already happened.

**A UI-only release is delivered by the outgoing service worker.** The reload
that follows an update is a navigation, and a navigation is answered by
whichever worker still controls the page. The shell is therefore no longer
precached (`ui/vite.config.ts`: no `html` in `globPatterns`, navigations
`NetworkFirst`) and the page reloads itself when a new worker claims control
(`ui/src/sw-update.ts`). Before that, a kiosk could come up reporting the new
version — that comes from the restarted server — while running the old bundle,
recoverable only with F5, which a touchscreen on a construction site does not
have. It was a race, not a certainty, which is how it survived. The release
*introducing* either half is still delivered by the old worker and lands stale,
so such a release must not also carry a visible UI change; the next one and
every one after arrive correctly with nobody touching the machine.

**Release assets need `Accept: application/octet-stream`.** The assets hang off
`/releases/assets/<id>`, which serves the asset's **JSON metadata** under the
API's `application/vnd.github.v3+json` and its bytes only under octet-stream.
Downloading with the API headers succeeds — 200, a body, a plausible size — and
writes a JSON document into `app-vX.tar.gz`. The updater did exactly that until
2026-10-19, for both the tarball and the checksum, so every GitHub update on
every kiosk died at "Checksum mismatch" comparing the hash of one metadata blob
against a token parsed out of another. Nothing else failed and nothing else
said so; the USB path reads files off the stick and was never affected, which is
why it survived so long. `githubAssetHeaders` is the one place this lives and
`updater.test.ts` pins it. `browser_download_url` also serves bytes, but it
redirects to a signed URL that rejects the request if the Authorization header
follows — for a private repo the asset API plus that Accept is the only
combination that works.

**An apply that gives up has to say so.** `update-applying` is emitted before
the download and was never cleared, so a failure left the indicator announcing a
restart that was not coming, recoverable only by reloading the page. Every
failure path now calls `failApply`, which logs the technical detail and
broadcasts `update-failed` with a German, actionable reason the indicator shows
until it is tapped away. The two guards at the top of `applyFromGitHub` — no
GitHub configured, no connectivity — go through it too: they returned *before*
the `update-applying`, so the tap landed and the UI never moved at all.

## CI Quirks

**Rollup platform binaries**: `package-lock.json` is generated on macOS and only contains resolved entries for macOS-specific optional dependencies (e.g. `@rollup/rollup-darwin-arm64`). Running `npm ci` on Linux (GitHub Actions) fails because the linux binary (`@rollup/rollup-linux-x64-gnu`) isn't in the lockfile. The CI workflow uses `npm install` instead of `npm ci` to let npm resolve platform-appropriate binaries. Do not switch CI back to `npm ci` without first ensuring the lockfile contains cross-platform entries.

**CI runs Node 22 with npm 11 installed over it**, and both halves are load
bearing — the two obvious single-version choices each fail, in opposite ways.

*Why not Node 20's npm.* The workflows delete `package-lock.json` and run
`npm install`, so every run resolves the tree fresh. On 2026-10-19 that
started crashing npm 10.8.2 (Node 20's bundled npm) with `Cannot read
properties of null (reading 'edgesOut')` — an arborist bug reached by a
transitive dependency published since the previous green run, with no manifest
in this repo changed. npm 10.9 (Node 22's) crashes identically. npm 11
resolves the same tree in 18 s, hence the explicit `npm install -g npm@11`.

*Why not Node 24.* better-sqlite3 11.x publishes linux-x64 prebuilds for
node-v108/115/127/131 — Node 18, 20, 22, 23 — and **none for Node 24**. Node 24
therefore compiles it from source, and that build aborts the process during
environment teardown: `Assertion failed: (env) != nullptr` in
`RemoveEnvironmentCleanupHook`, with `Statement::~Statement()` on the native
stack. It killed nine vitest workers (43 of 52 files reported). Node 24.14
locally does not reproduce it; the runner's 24.21 does.

`scripts/provision-kiosk.sh` carries **both** pins on the kiosk, for the same
reasons — a compiled-from-source database driver is not something to discover
in the field, and the npm half is needed there even more than in CI, since the
kiosk is where the dependencies are actually installed. Missing it, provisioning
dies at its Dependencies step with no `node_modules` and an error naming nothing
in this repository; it cost a field install on 2026-10-19. Changing either half needs the other checked: a newer Node needs a
better-sqlite3 that has prebuilds for it, and dropping the npm pin needs `npm
ci` to be viable (see the Rollup note above), since the fresh resolve on every
run is what exposes this repo to registry churn at all.

**lodash pinned to 4.17.21**: lodash 4.18.0 removed `assignWith` which breaks `workbox-build` (used by `vite-plugin-pwa`). The root `package.json` pins `"lodash": "4.17.21"` as a top-level override. Do not remove this pin.

**GitHub Packages auth**: The `@coded-aesthetics/din4023` package is hosted on GitHub Packages (private). CI uses `GITHUB_TOKEN` with `packages: read` permission. The `.npmrc` scopes `@coded-aesthetics` to `npm.pkg.github.com`. The server depends on it too, for the DIN 4023 tables — only its root entry, which carries no React.

**Playwright browsers**: the smoke tests need a browser binary, which is not in `node_modules`. CI runs `npx playwright install --with-deps chromium` before them, after the build (they serve the built output). Chromium only — the kiosk browser is Chromium, so testing the other engines would spend CI minutes on something nobody runs. Locally, `npx playwright install chromium` once; a version bump of `@playwright/test` needs it again, because the expected browser build is pinned to the runner version.

## Architecture

```
DataSource (mqtt.ts | serial)  →  ingestion.ts  →  SQLite (mqtt_buffer + session_readings)
                                                 ↘  WebSocket → Browser UI (React)
                                  recording.ts   →  per-sensor batch upload → Implenia API
```

Data intake is abstracted behind a `DataSource` interface (`server/src/data-source.ts`). Each source (MQTT, serial, etc.) emits `SensorReading` events. The `DataIngestion` layer (`server/src/ingestion.ts`) routes readings to the SQLite buffer, WebSocket broadcast, and session recording — source-agnostic. To add a new data source, implement `DataSource` and wire it into `ingestion.ts`.

**Sensor schema**: The sensor definitions originate as CSV files in `../implenia-web/app/assets/`. Each machine type (DSV, Ankerbohren, etc.) has a `*-sensors.csv` (vorgaben/specifications) and a `*-sensors-herstellen.csv` (production/live readings). The herstellen CSV defines sensor name, type, unit, source (`mqtt`/`kiosk`/`server`/`user`), role, priority, and MQTT alias. These files are the shared contract between `implenia-web` and this kiosk.

The herstellen CSVs are **copied into this repo** at `server/assets/sensors/` so the kiosk can serve them locally (offline, no Schichtauftrag needed). The server exposes them via `GET /api/verfahren/:type/sensors` (with optional `?source=mqtt` filter). To sync after changes in `implenia-web`, run `./scripts/sync-sensors.sh`. Use `--check` to verify without copying (suitable for CI). The source of truth is always `implenia-web` — never edit the CSVs in this repo directly.

**Serial protocol**: The Elvis controller (ESP32) sends hex-encoded IEEE 754 floats over USB serial, one frame per line (`\r`-terminated). The parser lives in `server/src/elvis-parser.ts`. Frame format: `# <addr> <15 hex floats> <checksum>\r`. See the parser module for field positions and the test suite for encoding details.

## Framework vs. Use-Case Code

This software is a generic kiosk platform for construction machines. The first use case is DSV (Düsenstrahlverfahren), but it must support other machine types (Ankerbohren, Grosspfahlbohren, Injektionsbohren, etc.) without architectural changes.

**Framework (reusable across machine types):**
- Data source abstraction (MQTT, serial), Elvis parser, ingestion pipeline
- SQLite buffering, WebSocket broadcast, recording sessions, batch upload
- Sensor mapping UI (user assigns serial value indices → sensor names per port)
- Shift assignment import (file upload), session data export
- Auto-update, connectivity watchdog, kiosk shell
- UI shell: header, navigation, recording bar, config page

**Use-case specific (varies per machine type):**
- Which sensors exist, their names, units, and roles (defined in CSV)
- Display logic: which values are "hero", how to lay out the element detail view
- Derived calculations (e.g. DSV volume computations)
- Export format specifics (column names, formulas)

When evaluating a new feature, ask: "Would a different machine type need this?" If yes, it belongs in the framework. If it's specific to how DSV works, it's use-case code and should be structured so it can be swapped or extended.

## CSV timestamp format — shared convention across three projects

Session-data export/import shares one timestamp contract with
`../implenia-web` and `../implenia-machine-backend`. When this kiosk exports
recorded session data as CSV/XLSX, the timestamp column **must** be a single
ISO 8601 column named **`Zeitpunkt`** — a local time *with* an explicit offset
(e.g. `2024-05-31T08:15:03+02:00`) or `Z`. Do **not** pre-convert to UTC and do
**not** emit the legacy two-column `Datum` + `Uhrzeit` format: it is
Europe/Berlin wall-clock, ambiguous across DST, and deprecated on the import
side. The receivers convert the offset to UTC on intake.

Reference implementations to match: machine-backend `csvParseISO`
(`api/sensors/persistence/sensors.go`) and web `parseIsoTimestamp`
(`app/models/csv-upload.server.ts`). Keep all three projects in sync.

## Element completion (Ausführungsdatum) — shared convention across three projects

An element (pillar) is **complete** when its **`Ausführungsdatum`** string
sensor (CSV role `is_completed`) holds a non-empty value. That sensor is the
single source of truth for completion across the whole stack — and its value
doubles as the element's **data-version stamp**, which is how appended data
gets recomputed. Both roles are described below; neither works without the
other.

### The write

- **Value: a full ISO 8601 instant** — `2026-10-07T07:14:22.000Z`, UTC, as the
  kiosk writes it. Readers must also accept a bare `YYYY-MM-DD` and German
  `DD.MM.YYYY`, both of which occur in legacy imports (web's
  `parseExecutionDate` in `app/helpers/drilling-stats/profiles/dsv.ts` handles
  all three). Parse the value; never compare it against a date for equality and
  never slice it to get a day.
- **Reading date: the sentinel `2000-01-01T00:00:00Z`**, never "now". Sensor
  value inserts upsert on `(sensor_id, date)`, so a fixed date makes completion
  a single overwritable slot per element instead of a time series. Everything
  else here depends on that: clearing would otherwise be impossible (yesterday's
  row keeps the element complete forever) and a re-import would append a second
  execution date instead of replacing the first. It is the same sentinel
  implenia-web uses for materialized per-element values
  (`MATERIALIZATION_SENTINEL_DATE` in `app/helpers/drilling-stats/sentinel-read.ts`).
- **Cleared: an empty string, never `null`.** The batch endpoint types
  `string_sensors` as `map[string]string` and rejects a null with a 422
  (`expected string`). Empty un-completes the element — the rework path.
- **Who writes it:** only the kiosk. After every successful session upload
  (`uploadSession` → `autoMarkComplete`) **except a paused one** — Pausieren
  ends a session without finishing the element, and because completion hangs off
  the upload rather than the stop, the flag is read there (see README →
  "Pausieren and Abschließen") — on the manual
  `POST /api/elements/:name/complete`, and `''` on `DELETE …/complete` when an
  operator resumes an already-uploaded element. The backend never writes it;
  implenia-web writes it only from its legacy importers.

### The stamp: how appended data gets re-materialized

Because the kiosk rewrites the value on *every* successful upload, a changed
value means "this element's data moved". implenia-web uses exactly that as its
invalidation signal for derived values:

1. The kiosk uploads a session and writes `Ausführungsdatum = <that instant>`
   at the sentinel row, overwriting the previous stamp.
2. implenia-web still holds the stamp it last materialized from in
   `MeasuringDevice.config.__dsv_materialized`.
3. The next read of that site (`ensureDsvMaterializationForSite`) compares the
   two, finds them different, re-runs `computeAndMaterialize` and stores the new
   stamp. Recomputed values upsert onto the same sentinel rows, so nothing
   duplicates.

What follows from this, and must not be broken:

- **A date-only value would be too coarse.** An element recorded, uploaded,
  resumed and uploaded again within one shift would write the same value twice
  and web would skip the recompute — the appended readings would show up in raw
  charts while protocol totals, drilling stats and the BIM widget kept the old
  numbers. That is why the value is an instant, not a day.
- **Re-materialization is lazy.** Nothing happens when the kiosk uploads; the
  first read of the site afterwards pays for the recompute.
- **`''` drops the flag** instead of re-materializing (rework reset), so an
  un-completed element recomputes from scratch once it is completed again.
- **A flag holding `true` predates stamps.** It compares unequal to every
  stamp, so such a pillar re-materializes once and carries a stamp afterwards.
- **The stamp is UTC.** Anything rendering it as a day must format in
  `Europe/Berlin` (`formatInTimeZone` from `date-fns-tz`), or an element
  finished at 00:30 local time prints as the previous day.

### Per project

- **implenia-mqtt-kiosk** — `server/src/element-completion.ts` owns the whole
  payload (sentinel date, stamp, `''`) and posts to
  `POST /api/v1/measuring-device/<device_id>/readings/batch`, with the id
  resolved from the element name by `element-device.ts` (resolve once, cache in
  memory, retry once if the id turns out stale). It resolves rather than passing
  `name:<element>` as the device_id even though the backend now accepts that
  reference form — the support landed after this kiosk shipped, and kiosks
  self-update on their own schedule while the backend deploys separately, so both versions are
  live in the field at once. Resolve-then-write works against either.
  `element-completion.test.ts` and `element-device.test.ts` pin both halves.
- **implenia-machine-backend** — `GetUnfinishedElements` excludes elements whose
  `Ausführungsdatum` sensor has a non-empty value. No other condition (e.g.
  "has any float sensor data") may be used as a completion proxy.
- **implenia-web** — every completion reader must treat `''` exactly like
  `NULL` (`checkIfDeviceHasCreationData` and
  `checkDevicesHaveCreationDataBatched` in `app/models/bim-widget.server.ts`,
  the drilling-stats profiles). The materialization guards in
  `app/helpers/computed-values/ensure-materialization.ts` compare stamps, not
  booleans. The legacy bulk importer stores the execution date it wrote as the
  stamp, so importing a site does not force a site-wide recompute on first view.

**Known deviation:** values written before this convention — and everything
written by web's legacy DSV MySQL migration (`writeIstValues` in
`app/models/dsv-migration.server.ts` dates values at import time) — sit at real
timestamps rather than the sentinel. Readers therefore ask "does a non-empty
value exist", not "is the sentinel value non-empty", which keeps those elements
complete but means they cannot be un-completed until the stale row is
overwritten or deleted.

Keep all three projects in sync when this contract changes.

## An element name is only an identity within one site

The kiosk knows an element by its **name** and nothing else. Names repeat: a
bridge is a row of piers, **one API key per construction phase per site**, and
every pier has a `P-01`. So every store keyed by element name is scoped to a
**site id** — a truncated SHA-256 of the API key (`site.ts`) — and
`POST /api/config` is not merely a credential write, it is the sentence "the
machine is somewhere else now".

**The identity is the key, and nothing is fetched to establish it.** The
element list is what asks the question, so an answer needing the network would
be missing exactly when the kiosk is doing its offline job. The platform does
offer one (`root_measuring_device_id`, on `/shift-assignment`) and it is the
wrong source for that reason alone. **The API URL is deliberately not part of
the hash**: it comes from `.env` on some machines, so folding it in would let a
provisioning edit silently re-scope a machine's whole history, while two
platforms issuing one key is not a thing that happens.

`recording_sessions.site_id` had been in the schema, with a `siteId` parameter
on `createSession`, since the first release — never written, always `'default'`.
The column was the only part of this that existed.

### What leaked, and how visible each one was

- **`recording_sessions`** — the previous pier's finished elements sat in
  „Abgeschlossene Elemente"; its recordings marked this pier's untouched
  pillars „begonnen" at the depth the *other* pier reached, which is how an
  element gets drilled twice; a resumed `P-01` reopened on the phase its
  namesake was left in, so a fresh hole could open on Auffüllen with its
  drilling treated as done.
- **`element_sensors`** — **the silent one.** It holds the previous pier's
  platform *sensor ids*, which `beginRecording` pins into the session when the
  platform cannot be reached. The readings then upload successfully, to the
  pier next door. Nothing fails and nothing says so.
- **`element_vorgaben`** — the previous pier's Soll values and geology profile
  on this pier's element screen, which also means the geology back-fill at
  sign-off invents layers from the wrong Schichtauftrag.
- **`imported_shift_assignment`** — an import overrides every other source, so
  this one did not degrade: the kiosk listed the pier it had left, indefinitely.
- **`last_shift_assignment`** — the previous pier's list served whenever the
  backend was unreachable.
- **`deviceIds`** (in memory, `element-device.ts`) — the next
  `Ausführungsdatum` written to the previous pier's device. Partly self-healing,
  since a key with no access gets a 401 and `STALE_ID_STATUS` re-resolves, but
  not when both piers are reachable with the new key.

### What must not be broken

- **Nothing is deleted on a switch, and nothing is ever re-stamped from one
  real site to another.** A pier keeps its rows under its own id, so putting its
  key back brings everything back with it — which is also **the only route its
  still-pending measurements have to the platform**, since they upload to the
  sensor ids of the site they were recorded on with whatever key is configured
  at the time. An import is *scoped*, not cleared, for the same reason: a worker
  on an offline site must never have to re-import a file to undo a key change.
- **`default` rows are adopted by the first key, and only by the first.** That
  id means "recorded before this kiosk knew which site it was on", and the first
  key is the answer to that question. It covers both the update that introduced
  sites and a machine set up offline from an imported Schichtauftrag and keyed
  afterwards — whose recordings would otherwise drop out of the element list the
  moment a technician typed the key in. Where the adopting site already holds a
  row for one element name, **its own row wins** and the unattributed one is
  dropped: it is a cache, and a row the platform served *for this site* is the
  better answer by definition. That collision is currently unreachable, and it
  is handled rather than argued away because the alternative is a UNIQUE
  violation thrown out of the route that saves the key — leaving the credential
  written and the move half-applied, which is worse than either row winning.
- **A missing key leaves the site alone.** Entering a wrong key runs
  `POST /api/config` → validate → `DELETE /api/config/api-key` (see
  VerbindungConfig), so returning to `default` there would orphan the real
  site's history until somebody happened to retype its key. The site id means
  "the last key this kiosk was given", and a kiosk with no key shows the „Kein
  API-Schlüssel konfiguriert" notice in place of the element list anyway.
- **The switch is refused while a recording runs** — 409 and German, same guard
  as `POST /api/update` and the WLAN switch. The running session's sensor ids
  belong to the site being left, so carrying it across would leave the kiosk
  recording one pier's pillar while believing it is on the next, and its upload
  would then be refused by the key that was just entered.
- **Pending measurements are reported, not blocked, and they need nothing from
  the operator** — they keep uploading under their own site's key, see below.
  `POST /api/config` answers `pendingReadings` and the screen shows it as a
  `warning` overlay — which, unlike `success`, does not clear itself, because
  2.5 seconds is not long enough to read it. It is said at all because this is
  the one moment somebody is looking, and a machine carrying unsent data is one
  that should not be wiped or handed on yet.
- **That count is `getOtherSitesUnsafeSummary`, asked *after* the switch, and
  it is Baustellen plural.** `getUnsafeDataSummary` is machine-wide, which is
  right for the reset guard — a reset wipes the machine — and wrong here: paired
  with a sentence naming „die vorherige Baustelle" it reported every reading on
  the box as that site's, identically whichever key was entered, and said it
  when switching *to* the site that owns the data, which is the one case with
  nothing to report. Asked after `syncSite`, the new site's own backlog and the
  `default` rows it has just adopted both fall outside the count. Plural because
  a crew that has worked three piers can still be carrying the first pier's data
  when it reaches the third, so "the previous site" is not what the number
  means.
  **The card is sized for the overlay, and that took three measurements to get
  right**: a `CardOverlay` covers its own card, so the card's height *is* the
  message's budget — and the API-key card was the shortest on the screen while
  carrying the longest message. Two traps, both of which produced a
  comfortable-looking number and a clipped message on the machine:

  - **`scrollHeight` does not answer this.** With `justify-content: center` the
    content overflows both ends and `scrollHeight` reports the box, so a
    message 17px too tall measures as fitting exactly. Measure a clone at
    `height: auto` against the card instead.
  - **The UI declares no `font-family`.** It renders in whatever the machine
    has, and the kiosk installs `fonts-dejavu-core` and nothing else —
    materially wider than any default macOS sans. A budget measured in Chrome
    on a developer Mac is not a budget. Forcing a deliberately wide font
    (Verdana) in the measurement errs in the safe direction.

  The card therefore carries a measured `minHeight: 300` (the overlay needs 276
  at wide-font metrics), which costs one pixel: the cards sit in a grid whose
  row was already 299px tall from the Server-Adresse card beside it, with 248px
  of the column below them empty. Deliberately **not** `alignItems: stretch` on
  the shared container — that is `start` on purpose and would change every
  config screen, the Netzwerk one included.
- **`getMostRecentSession` stays unscoped**, and so does the auto-upload loop.
  "What is still waiting on this machine" is a question about the machine, not
  about the site — it is what pins the recording bar, and the loop is what
  eventually sends a left-behind pier's data. Scoping either would hide that
  session rather than finish it.
- **The site id survives a reset**, listed in `RESET_PRESERVED_META` beside the
  credentials it is derived from. Leaving it behind would put the kiosk on
  `default` while still holding the key that identifies the site, and have the
  next boot adopt it straight back.
- **`syncSite()` runs first in `start()`**, ahead of the routes and
  `resumeRecording`. Every element-name question is scoped, so a boot that
  served the element list before answering this would answer it from `default`.
- **The two element cache tables were rebuilt, not dropped.** `element_sensors`
  is what lets an offline site record at all, so dropping it on an update would
  leave a kiosk mid-shift unable to start an element until it saw the platform
  again. Each rebuild is one transaction: `db.exec` has no implicit one, and a
  power cut between the `DROP` and the `RENAME` would come back with the real
  table gone, `…_new` orphaned, and the next boot's `CREATE IF NOT EXISTS`
  quietly making an empty one.
- **It is the first migration in this repo that is not additive, and it is
  one-way.** Every other one adds a column, which older code simply does not
  select. This one moves a PRIMARY KEY from `element_name` to `(site_id,
  element_name)`, so the previous release's
  `ON CONFLICT(element_name) DO UPDATE` no longer matches any constraint — and
  because `db.ts` prepares every statement at *import* time, that release would
  not merely fail to write, it would throw on boot and PM2 would loop it.
  Nothing in the app can reach that state: the updater refuses any tarball not
  `semver.gt` the running version, on the GitHub, USB and upload paths alike,
  and it extracts over the app directory rather than keeping the previous one.
  A hand-extracted old tarball, or a `git checkout` of an older commit against
  a real `kiosk.db`, is the way in — so if a release ever has to be rolled back,
  the database needs rolling back with it.

One thing came out of that which has nothing to do with sites: the wizard's
**Verbindung step was already overflowing** `main` by 49px at 1024x768, with
its own „Zurück" and „Weiter" buttons off the bottom of the display — a dead
end on the first-install screen. The step embeds a whole config screen, whose
cards need 904px of grid track plus 64px of their own padding, and the wizard's
column gives 900: the grid silently drops to one track and the cards stack.
`mainWide` exists for exactly that and its comment said „the WLAN step only"
while describing this step's problem. `EMBEDS_CONFIG_SCREEN` now names both,
and a step that embeds a config screen must be added to it.

`site-switch.test.ts` pins the scoping, the adoption and the fingerprint;
`api-key-switch.test.ts` pins the route — the 409, the move, and what it
reports as pending.

### A session uploads under the key of the site that recorded it

Readings go to `/api/v1/sensor-<type>/<sensor id>/batch` and those ids belong to
the site that recorded them, so **only that site's key may write them**. Retried
under the next pier's key, a session left behind answered 401 on every
connectivity transition and every boot for the life of the machine, with nothing
on screen and the only way out retyping the old key by hand — which is a real
thing to ask of nobody, since the keys come from the portal and a crew on a
bridge has one per pier.

The site id is a one-way hash and cannot produce a key, so the keys are kept in
`site_credentials`, written by every `syncSite`. `uploadSession` wraps the
attempt in `withSiteCredentials(session.site_id, …)` (`site-credentials.ts`), an
`AsyncLocalStorage` that `fetchImplenia` consults ahead of `getApiConfig()`.

- **Ambient, not a parameter, and that is the point.** One upload fans out to
  the CSV batch endpoint, the per-sensor batch endpoint `element-device.ts`'s
  resolve and `element-completion.ts`'s write, each with its own layers and its
  own cache. Threaded as an argument, every one of them has to pass it on
  correctly or it silently reverts to the configured key — and "silently sends
  to the wrong site" is the failure this whole area exists to prevent. Being
  per-async-context, the stop route's upload and the connectivity sweep cannot
  read each other's.
- **It is wrapped at `uploadSession`, not inside `runUpload`.** That is the one
  choke point all three callers go through — the stop route, the connectivity
  watcher, the boot sweep — and the context has to cover the entire fan-out,
  including the `Ausführungsdatum` write that `runUpload` makes last.
- **Such a request never reaches `apiHealth`.** A 401 from a left-behind pier's
  revoked key would set the state to `rejected` and have the header tell the
  operator *this* kiosk's key is wrong: false, and the one message that sends
  them to the settings screen for nothing. `reportHealth` in `fetchImplenia`
  owns this, and a request made with the kiosk's own key still reports normally.
- **The element→device cache is keyed by `(site, name)`.** Clearing it on a key
  change is no longer enough: both piers' answers are in flight within one
  process now, and both piers have a `P-01`. Keyed by name alone the previous
  pier's resolve comes back for the current pier's element and the next
  `Ausführungsdatum` lands on the wrong pillar — with a 200 and nothing to
  notice.
- **No credentials means no override, never a refusal.** A `default` site and a
  site whose key was never stored both run on the configured key, which is
  exactly what they did before this existed. That is what keeps every session
  recorded before this release uploading the way it always did.
- **The stored URL is refreshed on every `syncSite`**, including from `PUT
  /api/config/api-url`, which does not move the site id because the URL is
  deliberately not part of the hash. A row left pointing at the previous backend
  would aim a left-behind pier's data at the wrong platform.
- **Keys accumulate and are not pruned.** Pruning needs to prove that no session
  of that site has a pending or failed reading left, and getting it wrong
  restores the exact bug this removes — against a kiosk that already stores the
  current key in the same table in the clear, on a machine with remote access,
  which is where the real exposure is.

`site-credentials.test.ts` pins the mechanism, the health suppression and the
cache split; `upload-site-key.test.ts` pins that a real `uploadSession` is
actually wired to it, checking *every* request of the fan-out rather than the
first.

## Sensor roles are pinned to the session

A sensor's **role** (`depth`, `is_completed`, `geology_profile`, …)
is a property of the *element*, not of the kiosk. implenia-web's wizard stamps
it into the sensor's `meta` when the element is created
(`sensor-blueprint.server.ts`), and the backend serves it back with
`include_meta=true`. The kiosk's copies of the same CSVs are whatever its last
release shipped, synced by hand with `./scripts/sync-sensors.sh`.

Those are **two independent snapshots of the same source**, and resolving a
role against the CSVs *at the moment of use* reads the wrong one in three
situations:

- an element created before a role moved to a different sensor,
- an element created before a sensor was renamed,
- any session that outlives an auto-update — a recording can run for a day, so the role can resolve differently at sign-off
  than it did at start.

`beginRecording` therefore writes each sensor's `role` into the session's
`sensor_map` alongside its id, and `sensorNameByRole` (recording.ts) resolves
from there, falling back to `findSensorNameByRole` for sessions recorded before
roles were persisted. Same reasoning as the ids, which have always been pinned
there rather than re-fetched: a recording keeps behaving the way it did when it
started.

- **The `source` is persisted alongside the role**, for the same reason and
  with just as much riding on it: it decides whether a sensor's readings may be
  reduced onto a grid on the way out (`GRIDDABLE_SOURCES`), and a session that
  re-resolved it after an auto-update could grid a channel it had not been
  gridding an hour earlier. Sessions recorded before it was pinned fall back to
  the local CSVs *by the platform's spelling of the name* — the question is
  element-independent, a `Quelle` says how a channel behaves rather than what
  this element means by it. A name the CSVs do not know stays unresolved, which
  keeps the sensor **off** the grid: the per-sensor route costs bandwidth, the
  grid would cost the truth.
- **`name` is persisted with the role, and it is not optional.** The map is
  keyed by the *lowercased* sensor name, because that is all a resolved topic
  gives, and the real spelling is not recoverable from it. A completion write
  is addressed to the platform *by sensor name* —
  `string_sensors: { Ausführungsdatum: … }` — so returning the key would write
  to `ausführungsdatum`, a different sensor or a newly created one nothing
  reads. It is also the spelling a German error message about a missing sensor
  should show the operator.
- **The CSVs keep every element-independent question.** Role lookups that have
  no element cannot use this and must not try: ingestion's Rohrwechsel depth
  check (`getSensorRole`, on every live reading, recording or not), topic
  resolution, the calibration and topic-assignment screens, the sensor-mapping
  UI, the volume-tracking sensor set, and `stream` (which is not in
  `SensorMeta` at all — that is `{source, role, priority}` only). The manual
  `POST`/`DELETE /api/elements/:name/complete` routes have no session either,
  so they stay on `findCompletionSensorName()`.
- **What this is not.** It closes a visible degradation, not a silent one:
  before it, `resolveSensors` answered `Der Sensor „Bohrtiefe" fehlt in dieser
  Aufzeichnung` and the measurements still uploaded. Worth keeping that way.

## Schichtauftrag export carries sensor ids — shared convention across two projects

The JSON a site imports when the API is unreachable is produced by
implenia-web's `api.shift-assignment-export.$id.tsx`. Per element it carries,
besides the Vorgabe values, the element's **own sensor definitions with their
platform ids**:

```
measuring_devices[].sensors             = { sensors_float|int|string|geo: [{ id, name, unit, meta }] }
measuring_devices[].vorgaben_sensors    = { …the same, for the `vorgaben` child }
measuring_devices[].vorgaben_sensor_ids = [ sensor id, … ]
```

**Why the ids and not just the names.** Starting a recording builds the
session's `sensor_map`, and readings upload to
`/api/v1/sensor-<type>/<sensor id>/batch`. A reading stored without an id is
kept locally and silently never uploadable. Resolving them was the only part of
`beginRecording` that touched the network, which made the most important action
on a construction site depend on the thing least likely to work there — a site
with an imported Schichtauftrag could list its elements and then fail to record
one with `409 fetch failed`. The export is what makes a site that has **never**
been online able to record data that still uploads afterwards.

The shape is deliberately the one the machine backend returns for
`/measuring-device/self/child/name:<element>?include_meta=true`, so the kiosk
feeds an imported file through the identical filter it uses online
(`filterHerstellenSensors`). One consumer, two sources.

What follows from this, and must not be broken:

- **The ids must be the real platform ids.** Not a placeholder to be resolved
  later, not a name-derived stand-in. Anything else means a session recorded
  offline needs a rewrite of `session_readings.sensor_id` before it can upload,
  and a rewrite that never runs is a shift of measurements lost without a
  symptom.
- **`vorgaben_sensors` carries names and units, not just ids.** The element
  screen labels every Soll value from it, and that request is one more thing an
  offline site cannot make — the Vorgabe *values* have been cached locally
  since `element_vorgaben` went in, and this is the half that says what they
  are called. The kiosk also derives the Vorgabe id set from it, so the two
  cannot disagree. All six sensor keys must survive the round trip, including
  the `int_float` and `binary` ones the kiosk never records: the response goes
  straight to the screen, which reads them.
- **The Vorgabe id set is what makes a legacy pillar safe.** On pillars
  predating the `vorgaben` child device, Soll and Ist sensors sit side by side
  on the pillar with no `meta` to tell them apart, and the kiosk subtracts that
  set (`isRecordableSensor`'s legacy fallback). An export that omitted it would
  have the kiosk record and upload the Soll values as if they were
  measurements. It is empty for a migrated pillar, whose `sensors` are already
  production-only. `vorgaben_sensor_ids` stays in the file for kiosks that
  predate `vorgaben_sensors`.
- **"Known to be empty" and "never answered" are different**, on every path
  that touches the Vorgabe id set. A 404 on the `vorgaben` child is the real
  answer for a pillar that has none, is cached as such, and subtracts nothing.
  A network failure is not an answer: the kiosk caches *nothing* for an element
  in that state, does not hand the unsubtracted list to the caller either, and
  refuses the start with a 503 naming the Vorgabe sensors — but only where the
  set decides something. `needsVorgabenIds` is that question: a sensor whose
  `source` is known, from the platform's `meta` or from the local CSVs, is
  decided without the set, so a migrated element records normally and only a
  legacy pillar is held back. Getting this wrong in the lenient direction is
  silent and corrupting — the Soll values upload as measurements — which is why
  `vorgabenIdsOf` returns `null` rather than an empty set and every reader goes
  through it.
- **The field is additive and its absence is legal.** A file exported before
  this existed is still a valid Schichtauftrag — it just leaves the offline
  start to whatever the kiosk has already seen online. Kiosks self-update
  on their own schedule and implenia-web deploys separately, so both shapes are live in the
  field at once.
- **The local sensor CSVs are not an alternative source.** They carry name,
  type, unit, source and role — everything but the ids — which makes them look
  like a fallback. They are not: they are synced by hand, version separately
  from both the platform and the kiosk, and a sensor added in implenia-web but
  not yet synced here would be absent from the sensor map, recorded with a null
  id and never uploaded. Their role is to *enrich* what the platform listed,
  filling in missing `source`/`role`/`priority`/`unit` and nothing more. They
  never decide whether a sensor exists.

### Per project

- **implenia-mqtt-kiosk** — `herstellen-sensors.ts` owns the fetches, the
  filter and every cache path (`cacheImportedSensors`,
  `cachedHerstellenSensors`, `cachedVorgabenSensors`, and the two
  `resolve*Sensors` functions the routes and the start share so they cannot
  drift apart); `element_sensors` in `db.ts` is the store, written by every
  successful fetch and by the import, and always *merged* rather than
  overwritten because its two halves arrive from different requests. `recording.ts` prefers the platform and falls back to the
  cache, bounded by `SENSOR_RESOLVE_TIMEOUT_MS` so a half-open TCP connection
  cannot become an indefinite spinner. With neither, the start is refused with
  **503** — not 409, nothing about the kiosk's state is in the way — and a
  German message naming the import button on the element list.
  `offline-recording-start.test.ts` pins the whole path.
- **implenia-web** — the export route is the only writer. No sensor *values*
  are selected for `sensors`; the Vorgabe values keep coming off the pillar's
  `vorgaben` child as before, and `vorgaben_sensors` is built from that same
  query, so it costs no extra round trip.

Keep both projects in sync when this contract changes.

## Worker-observed geology (`Geologieprofil`) — shared convention across two projects

The geology a worker actually encountered is uploaded as **one JSON value** in
a **`Geologieprofil`** string sensor (CSV role `geology_profile`,
`Quelle=kiosk`), dated at the sentinel `2000-01-01T00:00:00Z`:

```json
{"end": 12.4,
 "layers": [{"t":0.0,"nr":12,"name":"Steine"},
            {"t":2.0,"nr":60,"name":"Hindernis Beton","q":"vorgabe"},
            {"t":2.4,"nr":12,"name":"Steine"}]}
```

`end` = the bottom of the profile in metres. Per layer: `t` = **start** depth,
`nr` = DIN 4023 number, `name` = the label shown to the operator at sign-off,
`q` = provenance (`vorgabe` for a back-filled boundary, absent when the
operator observed it).

Inserts upsert on `(sensor_id, date)`, so the profile is **one overwritable
slot**: a re-commit replaces rather than appends, clearing is possible, and
nothing accumulates. Same sentinel and the same reasoning as
`Ausführungsdatum`.

### Why it is not a time series

It used to be a **`GeoDIN`** integer series (role `geology_nr`) plus a
**`Geologie`** text series (role `geology_text`), and implenia-web turned the
numbers back into layers by **change detection** — each reading whose code
differed from the previous one starting a layer, at the depth of the *same*
reading, matched on millisecond equality.

A `GeoDIN` reading carried no depth, so **the timestamp was the entire depth
mechanism.** A reading dated at `Date.now()`, or one sample out of step,
produced no layer at all: it uploaded cleanly, appeared in raw charts, and the
protocol showed zero observed layers. Five mechanisms existed only to protect
that borrowed integer, and one had already been cut — a compression change
guarded `GeoDIN` from the grid while thinning the depth series it pointed at.

**That join was never designed.** The third-party software that wrote every
`GeoDIN` row on the platform grew out of a CSV upload, where one row carries
one timestamp and every column on it, so the alignment came for free and
nobody had to maintain it. It only became load-bearing when a writer had to
date a geology reading on its own.

Gone with it: `alignBoundaries` and `observedLayers` (`depth-timestamp.ts`,
which is now just `drilledDepth`), `pinAnchorReadings` /
`ALIGNMENT_ANCHOR_ROLES` / `ANCHORED_ROLE` (`csv-upload.ts`), `observedOnly`
and `VORGABE_SUFFIX` (`geology.ts`), the `geology_nr` / `geology_text` entries
in `EXACT_TIMESTAMP_ROLES`, `RECORDABLE_ROLES` entirely, and the whole
"`GeoDIN` may never be gridded" rule. **The depth series now grids like any
other channel**, because nothing points into it.

**`GeoDIN` and `Geologie` stay declared in the CSVs.** Nothing writes them —
`GeoDIN`'s `Quelle=server` keeps it out of the session's `sensor_map` on its
own now — but that list is also the set of names a Verfahren *owns* on a
pillar, which is the first safety filter of implenia-web's
`deleteHerstellenData`. Dropping a name from it means clearing a legacy
pillar's production data silently leaves those values behind, while readers
addressing the sensor by hardcoded name go on finding them.

### What must not be broken

- **A layer states its own depth, and that depth is a *start*.** The merge
  extends the shallowest layer up to 0 only when it is not an obstruction
  (`geology-profile.ts`), so a profile legitimately begins below 0 with the
  stretch above making no claim. End depths per layer cannot express that —
  they make the first layer's start implicitly 0. Note this is the opposite
  convention to the Prisma `GeologyLayer.end_depth` of a reference drilling in
  implenia-web.
- **`end` is written, not derived.** `profileEndTiefe` takes the deepest of the
  plan's bottom, the deepest reading, and the last layer plus a minimum
  thickness, so it can land deeper than any recorded reading when the hole
  stopped short of the plan. Anything recomputing it downstream gets a
  different number.
- **Depth is never taken from the browser.** The live entry route
  (`POST /api/recording/geology`) carries only a ground-type number; the server
  reads the depth off its own latest depth reading. The route **refuses
  outright once drilling has ended** (`drilling_ended_at` set): the newest
  reading is then a retraction reading, outside the window the profile is built
  from, so the entry would be written, answered with a depth, shown as
  recorded — and absent from the profile. The buttons and the voice commands
  are gated on the *browser's* view of the mode, which a second tab does not
  share, so the server cannot rely on them.
- **Live entries live in `session_geology`, as depths.** `(session_id, depth)`
  is the primary key, which is the replace rule: a second entry at the same
  depth corrects the first. The depth stands still for the whole of a
  Rohrverlängerung — `getSessionDepthSamples` is filtered to `phase = 'bohren'`
  — so that is minutes of taps landing on one value, and two ground types at
  one depth is not a profile.
- **Nothing back-filled ever enters `session_geology`.** That is what keeps a
  re-commit's provenance for free. The series shape had to reconstruct it from
  a ` (Vorgabe)` suffix on display text, because reading its committed output
  back wholesale marked the kiosk's own back-fill as observation.
- **`session_geology` is not the only source of observation, and the committed
  profile is read back for the other one.** The sign-off screen is where an
  operator retypes a planned boundary or adds one the taps missed, and those
  arrive as `quelle: 'ist'` layers that never reach the scratchpad. A re-ask
  rebuilds the context from scratch, so `committedObserved` (geology.ts) takes
  the layers of the last committed value that carry no `q` — one comparison,
  because provenance is a field. Without it every correction made at the first
  sign-off is silently reverted to the Schichtauftrag at the second.
- **A tap is not a profile.** `session_geology` is never uploaded — only the
  committed `Geologieprofil` value leaves the kiosk — so `hasGeologyReadings`
  counts committed profiles alone. Counting a tap had the stop trust
  `geology_confirmed_at` over a sign-off whose commit threw and skip its own
  back-fill, which is the signed-off-and-silently-empty element that pairing
  exists to prevent.
- **The depth series is still filtered to real drilling** — `phase = 'bohren'`
  (which drops the Rohrverlängerung phantom depths, see `rohrwechsel.ts`) and
  `upload_status != 'clipped'` — because it still bounds the profile. A layer
  deeper than anything drilled *or planned* is dropped: that is validation now
  rather than data loss, but keeping it would push `end` past the hole and
  report ground the drill never reached.
- **The depth sensor is resolved by role, never by name** — and the role comes
  from the session, not from the sensor CSVs (`sensorNameByRole`, see "Sensor
  roles are pinned to the session"). It is `Bohrtiefe` for Injektionsbohren and
  Ankerbohren but `Tiefe` for DSV.
- **Nothing about geology may stop a recording from ending.** The commit runs
  in its own `try`/`catch` inside the stop route; a failure costs the profile
  and nothing else. Inside the handler's own catch it returned 409 without
  ending the session, leaving the operator on a sign-off screen whose stop
  button kept failing.
- **A malformed profile costs the whole profile, not one layer.** That is the
  price of atomicity, and it is a better failure than the silent partial loss
  it replaces — but it is a different one, so the value is validated before the
  write and `session_geology` plus the Schichtauftrag stay the local source of
  truth, so a bad write can be re-committed from the recording.

### Obstructions are not a separate concept

DIN 4023 numbers 59–64 (`Hindernis Stahl/Beton/Holz/Sonstiges`, `Hohlräume`,
`Findling`) live in the same number space as soils and rocks. An obstruction is
an ordinary thin layer, and entering and leaving it are two ordinary layers.

### Every committed profile is complete

A profile is flat and gapless — each layer runs to the next, the last to
`end` — so **partial geology is not representable**: a single layer asserts the
ground continues to the bottom of the hole. There is no way to record "sand
from 2 m, and no claim below that".

Every commit that followed real drilling therefore writes a **complete
profile**, with the stretches the operator never confirmed back-filled from the
Schichtauftrag (`Geologie n` / `Tiefe Geologie n`, parsed by
`vorgabe-geology.ts`). That is the only option that neither discards what the
operator saw nor invents a boundary they rejected. Back-filled layers carry
**`q: "vorgabe"`**.

**Provenance is a field, and that matters beyond the protocol.** It used to be
a ` (Vorgabe)` suffix in the `Geologie` display text, because nothing else
survived the trip. Anything aggregating "which ground types were actually
encountered" — implenia-web's `baustellenanalyse` does exactly this, per
construction site — must exclude back-filled layers, because a back-filled
layer is a copy of the Schichtauftrag and the Schichtauftrag derives from the
same survey the reference drillings come from. Counting it reports planned
geology as independently observed, in the one dimension that page filters on.
String-matching a display suffix for that, in a place nobody would think to
look, is the version of this that quietly goes wrong.

**The back-fill is server-side, on every commit path.** `geology-profile.ts`
builds the profile; `POST /api/recording/geology/commit` and
`POST /api/recording/stop` both commit it whether or not the request carried
one. The touchscreen's sign-off screen is therefore a *review step, not a
gate*: a stop by voice, from a second browser tab, or straight from the
recording bar produces the same profile as a reviewed one. The screen edits
what the server built rather than deriving its own, so there is one
implementation and one answer — which is also why the voice stop deliberately
does **not** route through the sign-off (a hands-free operator would have no
spoken way off that screen).

Two rules inside the merge are easy to get wrong:

- **Adjacent layers of one ground type merge, shallower boundary surviving.**
  That is what moves a planned boundary to where it was actually seen, and what
  stops a confirmation that changed nothing from splitting a layer in two.
- **An obstruction is never extended to the top of the hole.** Extending soil
  upward where no Vorgabe fills it is a mild assumption that is usually right;
  extending `Hindernis Beton` upward asserts the drill met concrete from the
  surface, which nobody said. Such a profile legitimately starts below zero.

The `name` of a layer is composed from the DIN tables in the **din4023
package, which the server depends on** (its root entry carries the tables and
no React) — not from a name the client sends. A caller may still override it
per layer for an operator's own description. `nr` stays authoritative either
way: readers resolve the ground type from the number and must never parse it
back out of `name`. The name is carried because the kiosk and implenia-web
version the DIN tables independently, so it records what the operator was
actually shown at sign-off.

### The sign-off happens when drilling ends, not when the recording does

The review is shown at the **step out of `bohren`** — the phase stepper moving
to Austausch — and only as a backstop at Beenden, for a session that never left
drilling. The operator's memory is the reason: a recording runs on through
Austausch, Einbauen and Auffüllen, so the stop may be an hour later or the next
day. Nothing is lost by asking earlier, because the profile is already final at
that step — nothing after it adds a drilling depth.

Three things make it correct rather than merely kinder, and none may be broken:

- **`drilling_ended_at` bounds every geology read.** The operating mode never
  reaches a reading — `session_readings.phase` is only `bohren` or
  `rohrwechsel` — so a depth recorded while the rig retracts is stored as
  drilling data. Without the bound it inflates `drilledDepth`, which is
  `max − min` and whose `min` falls toward zero once the pipes are back out, so
  the "did this session drill?" gate gets more permissive than it means to be.
  `drillingWindowEnd` in geology.ts owns it. A session that *opens* past
  `bohren` — a resumed element reopening on Auffüllen — never makes that step,
  so `beginRecording` stamps it at the session's own start: the window is
  empty, the session is credited with no drilling, and the stop commits nothing
  rather than a Vorgabe profile bounded by the retraction.
- **The mode is switched before the screen opens.** The rig may start
  retracting the moment the operator taps, and a server that still thinks
  `bohren` reads the Klemmbacke as a pipe change and records the retraction as
  drilling data. The review may wait; the clipping behaviour may not.
- **`geology_confirmed_at` keeps it to once, and a step back into `bohren`
  clears both marks.** A profile already signed off is not rebuilt at the stop:
  rebuilding re-derives the back-fill, so a planned boundary the operator
  deleted would quietly come back. An operator who resumes drilling is asked
  again, about the deeper hole.
- **The mark means "the operator was asked", never "a profile is on record."**
  It is set even when the commit threw, because the alternative is sending the
  operator back to a screen whose only button just failed. Nothing may read it
  as proof of a write: the stop pairs it with `hasGeologyReadings` before it
  skips its own back-fill, since a mark set over a failed commit — a kiosk whose
  disk was full for a minute — would otherwise cost that element its geology
  entirely, signed off and silently empty.

**Known deviation: a rejected boundary is not remembered across a re-ask.**
Nothing records that the operator *deleted* a planned boundary —
`committedObserved` recovers what was written, never what was refused. So on a
resumed element the step back into `bohren` clears the sign-off, the next step
out rebuilds the context, and `mergeProfile` re-adds every Vorgabe boundary: one
the operator explicitly deleted at the first sign-off reappears (dashed) at the
second and is committed unless they delete it again. Within a single sign-off
the deletion holds, which is the common case; fixing it across one properly
means persisting rejections, not special-casing the rebuild.

**The profile is one slot per element, so every commit must carry the whole
element.** The value is dated at the sentinel, so a resumed element's second
commit *replaces* the first's on the platform rather than adding to it — where
the `GeoDIN` series kept both sessions' rows. `committedObserved` therefore
reads back every session of the *element*, not of the session: without it, an
element drilled 0–8 m on one shift and deepened to 12 m on the next committed
a profile whose top 8 m was back-filled from the Schichtauftrag, over the
layers the first operator actually observed, marked `q: "vorgabe"` with nothing
saying so.

Three rules inside that read, each load-bearing:

- **Keyed on the sensor id, not the name.** That is the identity the platform
  upserts on, so the rows it finds are exactly the set sharing one slot there.
  Two sessions that pinned different ids wrote to different slots, neither
  overwrites the other, and the read correctly recovers nothing.
- **Only the newest value per session, but every session.** Within a session a
  later commit is a correction of the one before it, *deletions included*, so
  folding an earlier write back in would resurrect a boundary the operator had
  just removed. Across sessions they accumulate, which is the point.
- **Folded oldest assertion first**: an earlier session's commit, then this
  session's taps, then this session's own commit. A tap made now is a better
  answer than a boundary committed on a previous shift at the same depth, and
  this session's sign-off is a better answer than the tap it corrected. The
  order is the entire content of the rule.

Still bounded by `grenze`: a recovered layer deeper than this session drilled
*or* the plan reaches is dropped like any other, so re-working an element to a
shallower depth with no Schichtauftrag on file loses the deeper observations.
Rare, and the alternative is reporting ground below the hole.

**One button, two consequences — never selected by the operating mode.** Which
button the sign-off screen shows comes from `?beenden=1` in the route, set by
the recording bar's stop. It was derived from `operatingMode`, and that is
wrong twice over: a Beenden on a session already past `bohren` (its phase-step
sign-off skipped because the context fetch failed) got a button that committed
and returned while the recording kept running, and `operatingMode` is null until
the first `recording-state` message, so a reload on this screen briefly offered
*the other* consequence under the same button — one tap ended a recording
mid-Austausch. A URL survives a reload and a PM2 restart; WebSocket state does
not. Anything that decides what a button *does* belongs in the former.

The sign-off screen has **one** forward button at the phase step
(`Weiter zum Austausch`) and no second exit: the way back from a mis-tapped
phase step is the phase stepper, which stays in the header on that screen for
exactly that. A second exit there would quietly make the review skippable.

### Per project

- **implenia-mqtt-kiosk** — `geology-profile.ts` owns the merge and
  `profileEndTiefe`; `geology.ts` owns the write, the JSON shape and the
  idempotent re-commit; `vorgabe-geology.ts` parses the planned profile;
  `session_geology` in `db.ts` holds the live entries.
  `POST /api/recording/geology/commit` is the normal write, at the step out of
  `bohren`; `POST /api/recording/stop` takes the same optional `geology` body
  and commits **before** ending the session, because ending it is what releases
  the auto-upload. A re-commit removes the previous commit's `pending` reading
  only, so nothing already on the platform is touched. Neither route is ever
  refused over its geology: a malformed profile costs the geology and nothing
  else.
- **implenia-web** — `app/helpers/geology-profile.ts` parses the value;
  `injektionsbohren-protocol.server.ts` and `injektionsbohren-export.server.ts`
  prefer it and fall back to `herstellungLayersFromRows`, reporting which they
  used in `herstellungSource`. **That legacy path is permanent**: every
  `GeoDIN` row on the platform was written by the third-party software the
  kiosk replaces, those rows will never be re-recorded, and once the kiosk
  ships nothing will produce the shape again to test against. Its alignment is
  structural, so it cannot drift. The data is not trustworthy — that UX did not
  encourage realistic profiles on site — so the depth chart defaults to
  `herstellung` only for `"profil"` and labels the other `Herstelldaten
  (Altdaten)`. Keep the two branches separate rather than normalising legacy
  rows on read: the branch is the only thing that can tell the two eras apart.
  `reference-drilling.server.ts` unions observed layers (never back-filled
  ones) into each site's `geologyNrs` for `baustellenanalyse`.
- **Known deviation:** the kiosk UI parses the Vorgabe geology a second time
  (`ui/src/utils/vorgaben.ts` → `buildSchichten`) for the Soll profile the
  element and drilling screens draw, and for the approaching-boundary
  suggestion. That path is display-only and renders synchronously from
  already-cached props. The server's `vorgabe-geology.ts` is the only parser on
  the correctness-critical path — if the two ever disagree, a drawn picture is
  slightly wrong and nothing is miscommitted.

Keep both projects in sync when this contract changes.

## `Status` numbering — shared convention across two projects

The kiosk writes the operator's phase into the **`Status`** integer sensor
(CSV role `mode`, `Quelle=user`) on every mode change and at the start of a
recording. implenia-web's Injektionsbohren Herstellprotokoll segments every KPI
by it, and **that protocol is the authority on what the numbers mean** — it is
signed, archived, and read by people who never see either codebase.

```
0 = Bohren      1 = Auffüllen      2 = Austausch      3 = Einbauen
```

**0 and 1 are fixed and 2 and 3 are free.** The two-mode kiosk wrote `bohren` /
`verpressen` as 0 / 1, so every pillar recorded before the four phases existed
means exactly that, and web has always matched on it. The protocol reports those
two phases — what was drilled, and what was filled. Austausch and Einbauen are
neither, appear nowhere on it, and therefore take the numbers nothing matches
on; their order between themselves carries no meaning.

**The numbering is not the phase order**, which is the trap. The stepper runs
Bohren → Austausch → Einbauen → Auffüllen, so numbering them in sequence is the
obvious thing to do and was done once: it gave 1 to Austausch, and web's second
column went on reporting under the heading "Verpressen" with the same shape and
plausible numbers — the slurry exchange's Beginn, Ende, Dauer, depths and
averages, for a column everybody read as the filling phase. Nothing failed.

What follows, and must not be broken:

- **`recordStatusReading` (`ingestion.ts`) is the only writer**, and
  `AUFFUELLEN_STATUS` plus the computation profile's phase filters
  (`app/models/injektionsbohren-protocol.server.ts`,
  `app/helpers/computed-values/profiles/injektionsbohren.ts`) are the only
  readers. Four constants, two repositories, one meaning.
- **The sensor is resolved by name, never by the `mode` role** — the one
  deliberate exception to "Sensor roles are pinned to the session" above, and
  it has to stay one. On two of the three Verfahren that role names a channel
  somebody else already writes: DSV's is `Bohren/Düsen`, which arrives as
  machine telemetry, and Ankerbohren's is `Reserve 5`, a `Text` reserve
  channel the rig publishes and implenia-web's
  `getHerstellungsdatenProtocolData` reads as the process stages — distinct
  values counted as *Anzahl Vorgänge*, suspension consumption grouped by its
  state transitions. Resolving by role would make the kiosk a second writer
  there, inventing Vorgänge four times a session. Ankerbohren therefore
  reports no phase to the platform, at no cost: that protocol reads the rig's
  value, and the kiosk's phases are internal state, so `operating_mode`,
  `drilling_ended_at` and the geology sign-off behave the same for every
  Verfahren.
- **A session's opening value is written at `startRecording`**, because a mode
  is otherwise only recorded when it *changes* — see `resetForSeek`, which has
  to re-state it after clearing a session.
- **That opening value is not always `bohren`.** A resumed element reopens on
  the phase its last session was in, and `POST /api/recording/start` carries
  that phase so the session opens in it — otherwise a screen saying Auffüllen
  records `Status = 0` and the protocol reports the filling as drilling.
  `beginRecording` writes it onto the session row before `startRecording`,
  because `operating_mode` is `NOT NULL DEFAULT 'bohren'`: a fresh row already
  has a stored mode, which is what `startRecording` reads first, and which is
  why `ingestion.pendingMode` behind it never reaches a new session.
  `opening-phase.test.ts` pins the whole path.
- **It is never gridded.** Four readings in a shift, so the CSV route would
  write a fabricated outage into every row it has no value for; web
  forward-fills this sensor and reads a NULL as "mode unknown from here on".
  See "What the CSV upload may not be given".
- **Renaming the derived values is not on the table.** web's computed
  `beginn_verpressen`, `dauer_verpressen`, `q_verpressen` and friends are
  materialized onto pillars, so they keep the old word while the screens say
  Auffüllen.

Keep both projects in sync when this contract changes.

## Reduction happens on the way out, and only there

A recording leaves the kiosk twice — the xlsx on a USB stick, the batch upload
to the platform — and both used to carry one row per *reading*. On the only rig
that has been captured that is 275 935 readings on 274 475 distinct
milliseconds (every MQTT message is stamped with its own `Date.now()`), so the
sheet was 92.8 % empty cells, 12.4 MB, and 28 s and 2.0 GB of heap to build on a
machine that has 4 GB. `grid-reduce.ts` is the one implementation that reduces
both, configured per kiosk on the Datenübertragung screen
(`reduction-config.ts`, defaults: 1 s for both, `uploadMode: 'csv'`).

**`session_readings` is never reduced.** Everything here applies on the way out,
so a granularity chosen wrong costs resolution on the platform and is undone by
re-uploading or re-exporting the same session. Nothing in this area may start
deleting or rewriting recorded rows.

**The Datenstrom chart is a third way out, and obeys the same rule.**
`GET /api/config/datenstrom/history` reads `mqtt_buffer` rather than
`session_readings`, so it is outside everything above — but it reduces, and a
chart is exactly where somebody will later think averaging is free. It goes
through `reduceToGrid` with `bucketMs: 1000` and `maxHoldMs: 0`, so it inherits
the last-value rule and its two witnesses (`Klemmdruck` bimodal at ~1650/~4200
with a mean in a band the clamp cannot produce; `Tiefe` stepping by a whole
Bohrrohr) rather than restating them. The zero hold is the one deliberate
difference: an upload fills a gap because the platform reads an absent cell as
an outage, and a chart must draw a gap as a gap — a stalled rig may not come out
looking like a running one. Nothing about it touches what is recorded or
uploaded; a granularity chosen wrong there costs a picture.

What follows from the shape of the data, and must not be broken:

- **Last value in the interval, never a mean.** The readings are mostly
  duplicates — 58 % to 90 % per channel are exact repeats of the previous value,
  because the rig re-publishes rather than re-measures — so the interval almost
  always holds one distinct value. Where it does not, a mean *invents a number
  the machine never reported*: `Klemmdruck` is bimodal at ~1650 open / ~4200
  closed and its 1 s mean falls in the impossible band between them in 35
  intervals of that capture; `Tiefe` steps by a Bohrrohr during a
  Rohrverlängerung and its 1 s mean sits up to 1.0 m from every sample in the
  interval; the volume channels are monotonic counters. Any aggregation that is
  not "a value that was actually recorded" is wrong here, not merely imprecise.
- **A row is dated at a real reading's instant**, the newest in the interval —
  never at the interval boundary. Downstream never has to trust a timestamp no
  sensor produced.
- **Forward-fill is bounded, and a `null` is not carried.** `holdMsFor` gives
  four intervals and never less than 4 s, which is what lets the ~3 s pump
  channels fill a 1 s grid while a dead sensor still reads as dead. A recorded
  `null` is the kiosk's outage marker: it is emitted in its own interval and
  stops the fill, so a pre-outage value can never reappear after it.
- **An interval nobody recorded in produces no row.** A stalled rig must not
  come out looking like a running one.

### What the CSV upload may not be given

`uploadMode: 'csv'` posts to
`POST /api/v1/measuring-device/<device_id>/readings/batch/csv` in chunks of
`CHUNK_ROWS` rows, device id resolved by `element-device.ts`. It cuts the
captured session from 13.9 MB in 64 requests to 0.99 MB in 9.

**An empty cell in that endpoint is a written NULL** (`sensors.go`, the float
branch adds the nil), and a NULL is this kiosk's outage marker. Four
consequences, none of them optional:

- **A CSV upload with no grid is refused.** Ungridded, each row carries one
  value and thirteen empty cells, so the captured session would upload 275 935
  measurements and 3 566 722 fabricated outages. `validateReduction` rejects the
  combination and `runUpload` re-checks it, because a settings row written before
  that check must not produce one either.
- **Only the machine's own channels may be gridded** — `GRIDDABLE_SOURCES`,
  `{mqtt, kiosk}`, read from the `source` the session pinned. This is the rule
  that decides what an *absent* cell means, which a CSV cannot say. An `mqtt`
  channel publishes every ~290 ms (every ~3 s for the pumps), so a row with no
  value of its own and nothing inside `maxHoldMs` behind it means the channel
  really went quiet, and a NULL is what the per-sensor route would have written
  too. `kiosk` is in for the same reason, not by charity: the volume
  integrations are derived from *every* pump reading, and DSV declares thirteen
  of them. `user` is where the same cell is a lie, because those values are
  events — see "The Status outage flood" below.
- **Each chunk carries only the columns it has values for.** A sensor that
  records only during Verpressen is simply absent from the Bohren chunks instead
  of contributing an empty cell to every one of their rows. Note what this does
  *not* do: it works per chunk, not per row, so a sensor with one value
  anywhere in a chunk gets a column — and an empty cell — in all 1000 of its
  rows.
- **String sensors never go this way at all** — an empty cell there writes an
  empty *string*, and for `Ausführungsdatum` an empty string un-completes an
  element.

#### The Status outage flood

The first version of this gridded by type and role alone, and that cost a real
Herstellprotokoll. Worth keeping, because every step of it looked like a
success:

Injektionsbohren's `Status` (`Quelle=user`, role `mode`) is the operator's phase
flag. It is written *on change* — four readings in a 2 h recording — and that is
all implenia-web needs, because its computation profile declares
`forwardFillSensors: ["Status"]`. The grid gave it a value in 13 rows of 354;
the column was in the chunk's header because it had *a* value there, so the
other 341 rows carried an empty cell and uploaded as 341 fabricated outages. On
the pillar that was 5 real values and 186 NULLs, against 4 real values and no
NULLs for the same session uploaded the per-sensor way.

Then, in web (`app/helpers/computed-values/engine.ts`):

1. `forwardFill` does `if (name in row.values) last.set(name, row.values[name])`
   — a present-but-**null** row *overwrites* the carried value. From the first
   fabricated NULL onward, every row's `Status` was null.
2. `detectPhases` filters `row.values["Status"] === 0`, so `phaseData.bohren`
   held exactly **one** row: the single real `Status = 0`.
3. `beginn_bohren` and `ende_bohren` are that row's instant, so they were
   equal; `dauer_bohren` needs two rows and went null; every phase average was
   taken over one row.
4. `loadPhaseDepthChart` is called with that zero-width window, so no `GeoDIN`
   row fell inside it, `herstellungLayersFromRows` returned `[]`, and
   `fillInitialGap` drew the Vorgabe prefix alone.

The protocol therefore printed **Vorgabe geology and no observed layers at
all**, with the pillar's drilling duration and pressures blank — from an upload
that reported success, for a session whose `GeoDIN` readings were all present
and all correctly anchored. The geology machinery above was never the problem.

What this leaves: a `Quelle` answers "is this channel periodic" only by proxy. A
phase-limited `kiosk` channel (DSV's `Volumen Vorschnitt`) is dense inside its
phase and absent outside it, so the chunk straddling the transition still writes
a few fabricated NULLs — bounded and cosmetic, since nothing in web forward-fills
a volume. The complete fix is to drop a column from the one chunk it is not
dense in and send those readings per-sensor, which moves reading ids between a
chunk and the leftovers; worth doing deliberately rather than as a rider.

A **retry of one failed chunk** has the same bounded symptom from a different
cause, and the same fix. `resetFailedReadings` makes only that chunk's readings
pending, so the retry's grid starts with an empty carry: a ~3 s channel whose
last reading sits in the previous, already-uploaded chunk is not carried into
the first rows of the retried one, which still earn it a column. One to four
rows per slow channel per retried chunk, written as outages for a channel that
was alive. Fixing it properly means gridding the whole session and sending only
the rows that still hold pending ids — again, ids moving between chunks.

**The depth series grids like any other channel, and that is new.** It used to
be the one channel a geology profile depended on by *timestamp*: a `GeoDIN`
boundary carried no depth of its own, so `geology.ts` dated it at the exact
`received_at` of a depth reading and implenia-web recovered the layer's depth
by pairing the two on millisecond equality. Grid the depth series and the
reading a boundary pointed at stopped existing on the platform — it looked for
a depth at 580 ms, the platform had one at 870 ms, and the layer was gone. The
first version of this compression change guarded `GeoDIN` from the grid and cut
the other end of the same link.

That whole dependency is gone: a committed profile is one `Geologieprofil`
value in which every layer states its own depth (see "Worker-observed
geology"). So the rules it needed are gone too — `pinAnchorReadings`,
`ALIGNMENT_ANCHOR_ROLES`, `ANCHORED_ROLE`, and the `geology_nr` /
`geology_text` entries in `EXACT_TIMESTAMP_ROLES`, which is now just
`is_completed`. **Nothing may reintroduce a reader that recovers a depth, or
anything else, by joining two series on a timestamp** — that is the shape of
bug this cost two releases to find, and the grid is exactly what breaks it.

The profile value itself never goes near the grid for two independent reasons:
it is a **string** sensor, which `isGriddableSensor` refuses outright because an
empty cell there writes an empty string rather than a NULL, and it is dated at
a sentinel rather than being session data at all.

### Addressing by name is only safe because it is checked

The CSV endpoint matches columns to sensors **by name**, which is the opposite
of how the rest of this kiosk works — the Schichtauftrag carries real platform
ids precisely because a name can drift (see "Schichtauftrag export carries
sensor ids"). Two checks are what make it acceptable, and removing either turns
a drifted name into measurements that upload cleanly and land nowhere:

- **A sensor with no `name` in the session's `sensor_map` is never gridded.** The
  map is keyed by the lowercased name and the real spelling is not recoverable
  from it, so it takes the id-addressed route rather than being written to
  `bohrtiefe`. Sessions recorded before names were persisted therefore upload
  exactly as they always did.
- **A `200` is not a success.** The endpoint reports headers it could not match
  in `unknown_sensors` rather than failing, so `csvChunkProblem` fails the chunk
  when any of *our* columns appear there — or when `rows_processed` falls short
  of what was sent.

**The fallback is decided on the first chunk only.** A structural refusal there
(404/405/415 from a backend deployed before the endpoint existed — kiosks
self-update on their own schedule while the backend deploys separately, so both versions are
live in the field at once; unmatched names; an element that does not resolve)
switches the whole session to the per-sensor route, which is clean because
nothing has been written yet. A 5xx, a timeout or a network error is **not**
structural: those mean "not now", and falling back on them would re-send the
whole session over the mobile link this exists to spare. A later chunk failing
costs that chunk, which goes to `failed` and is retried — the platform upserts
on `(sensor_id, date)`, so the re-send is a no-op.

Two of those are worth their own line, because the obvious reading of each is
wrong:

- **A 422 is decided by its body, never by its status.** The endpoint answers a
  refusal with the *same* JSON result as a success — `success` is
  `failed_count == 0 && rows_processed > 0`, and a false one is served as a 422
  carrying that result. So an unmatched header and a Postgres insert error that
  cost it one chunk of values arrive under one status. Treating the status as
  structural lets a single statement timeout on the platform abandon the grid
  and put the whole session back on the link as JSON; treating it as transient
  strands a body the backend will keep refusing. `csvChunkProblem` reads the
  fields instead: an unmatched name of ours or `rows_processed == 0` is
  structural, `failed_count` is not, and a 422 the kiosk cannot parse falls
  back — an expensive upload that lands beats measurements that never leave the
  kiosk.
- **An element that does not resolve is structural**, and this is the one
  failure where the *other* route is strictly more capable. The CSV endpoint is
  addressed per element device (`element-device.ts`), so an element the platform
  answered about and does not know leaves it nothing to post to; the per-sensor
  route is addressed by sensor id and needs no device at all, which is why such
  a session uploaded fine before `uploadMode: 'csv'` became the default. A
  resolve that *failed to answer* is not this — that is a transport failure, and
  "not now" as usual. `ElementNotResolvableError` is what keeps the two apart.

`grid-reduce.test.ts`, `csv-upload.test.ts`, `reduction-config.test.ts` and
`csv-upload-session.test.ts` pin all of this.

## The WLAN switch is staged, and that ordering is the safety property

On site the kiosk joins the Implenia MQTT box's access point, which serves the
data **and** carries the internet uplink — one network, no cable. The screen
that changes it (`Einstellungen → WLAN`, `server/src/network.ts`) is therefore
the one screen that can take the machine off the air, and a kiosk nobody can
reach is a truck roll: AnyDesk needs a network too.

`connect()` stages the change: delete any leftover pending profile, create the
new one **with `autoconnect no`**, activate it, TCP-connect the MQTT box, and
only then commit — rename, `autoconnect yes`, priority above every other
profile, drop the stale profile for the same SSID. On any failure the pending
profile is deleted and the previous one brought back up.

**`autoconnect` is set only in the last step, and nothing may move it earlier.**
That is what makes a crash, a power cut or a PM2 restart mid-switch come back on
the previous network by itself, with no rollback timer to survive the restart
too. `network.test.ts` asserts the ordering directly rather than the outcome,
because the outcome looks identical until the day it does not.

What else must not be broken:

- **Existing profiles are never modified.** The one currently up may be the only
  known-good network the machine has, and a PSK cannot be read back out of
  NetworkManager to be restored. The new profile is always a fresh one under a
  name of our own (`implenia-pending`) until it is committed.
- **The internet is not a pass condition.** The box carries the uplink, so its
  mobile link can be down while the box serves MQTT perfectly. The acceptance
  test is the configured broker answering; `internet` is reported and the switch
  commits either way. The kiosk buffers offline by design — refusing a correct network
  over a sulking LTE modem is the tail wagging the dog.
- **A cable on the default route does not mean the broker is unreachable.** The
  box's own subnet is a connected route over the Wi-Fi and beats the cable's
  default route. What `routedElsewhere` means is that the acceptance test can
  reach a broker on the *cable's* network and tell you nothing about the Wi-Fi —
  so the status card states the route as a fact and the consequence lives beside
  the check it qualifies, not stitched onto the fact as a warning.
- **A failure names the MQTT broker and its port, never "die Implenia-Box".**
  The probe goes to whatever address the kiosk is configured for; that is the
  box on a site and anything at all on a bench, and naming the box told a kiosk
  pointed at a replay server that a device it has never met was not answering.
  The port is there because `1884` against an expected `1883` is invisible
  without it.
- **A failure message says where the machine actually ended up** — restored,
  on nothing, or *untouched*. All three are distinct: `rollback()` can itself
  fail, and a profile that could not even be created means nothing was switched
  at all, so claiming a rollback there told a technician their kiosk had no
  network while it sat on the one it started with.
- **The commit is checked, and the stale profile outlives a failed one.** An
  unchecked `connection modify` reaches the exact state the staging exists to
  prevent, from the inside: the live connection keeps the pending name and
  `autoconnect no` while the real profile for that SSID has just been deleted,
  so the next reboot comes back on nothing — and the next attempt deletes the
  live profile as if it were the previous one and rolls back to a uuid that no
  longer exists. A failed commit is rolled back like any other failure.
- **The profile is built for the security the AP advertises.** `wpa-psk`
  against a WPA3-only network never associates and looks exactly like a wrong
  password, so the operator retypes a correct one until they give up;
  `keyManagementFor` reads NetworkManager's own SECURITY field, and an 802.1X
  network is refused outright rather than offered a password box it can never
  satisfy.
- **The scan needs a polkit action of its own, and a refused scan is silent.**
  `org.freedesktop.NetworkManager.wifi.scan` defaults to `auth_admin` for a
  subject with no login session, which is exactly what the PM2-started server
  is — being in `netdev` changes nothing. `nmcli device wifi list --rescan yes`
  swallows the refusal: exit 0, empty stderr, NetworkManager's cache printed as
  if it were fresh. So the screen lists whatever the machine last happened to
  see — the office, or on a kiosk that has been connected to one network since
  boot, that network alone — while the box sits 30 cm away and absent, with
  nothing anywhere saying why. The provisioning rule grants the action and
  `scan()` asks for the rescan in its own call purely so the exit code can be
  logged. The rule file is compared in full on every provisioning run, because
  the guard that asked "is there a rule for this user" would skip the fix
  forever on every machine that already had the old rule.
- **Reading the status never drives the radio.** `device wifi list` defaults to
  `--rescan auto`, which scans whenever the cache is older than 30 s — so the
  settings hub waited on a radio scan before painting any of its five tiles.
  The scan list is also not authoritative about what the machine is on: a
  failed one reported a connected kiosk as "Nicht verbunden". The active
  connection answers that.
- **Every message fits the screen's message box** — 260 characters, pinned by a
  test, with a 32-character SSID (the longest the standard allows) in it. The
  box sits under the *network list*, in the other column from the button it
  reports on, because the status card above that button grows: a kiosk on a
  network cable shows an extra line about it, which is the state of every
  machine being set up on a bench, and the first version put the message under
  the button where the two together pushed it off the screen.
- **The box's size is measured, never counted.** It holds five lines at rest
  and grows to seven, and every one of those numbers came from reading
  `scrollHeight` on the rendered page at 1024x768. Three earlier versions were
  derived on paper — five lines, then six, then a height that forgot the card's
  own 48px of padding — and each cut a real message off mid-sentence while the
  arithmetic said it fit. A long SSID also wraps worse than its character count
  suggests, which no budget in characters can express.
- **A failure message never contradicts itself across the rollback.**
  "Verbunden mit „X" … das Gerät ist in keinem WLAN" is two true sentences in
  different tenses, and without naming the undo between them it reads as
  nonsense. Every message says the switch was taken back before it says where
  the machine ended up.
- **Both columns are bounded** (`minHeight: 0` and their own scroll), and the
  screen takes its height with `flex: 1` rather than `height: 100%`, because it
  renders in two places with different room: the config page, where it fills
  `main`, and the setup wizard, where it gets what is left after the step's
  continue button. An unbounded column does not scroll, it draws over whatever
  comes after it — which in the wizard is that button.
- **No free-text SSID field.** Only networks the machine can see are offered,
  which answers "does this network exist" for free.
- **A switch is refused while a recording runs**, 409 and German, same guard as
  `POST /api/update`. The AP is the data source.
- **A machine that cannot do this is a state, not an error.** No
  NetworkManager, no wireless interface → `capability.available === false` with
  a German reason the screen shows. Such a kiosk works fine on a cable.

Wi-Fi belongs to a machine, not to an application, so this configures the box
the *server* runs on and the screen names it. Today that is the touchscreen in
front of the technician. If the server is ever split onto its own box, each box
needs its own agent — no design avoids that — and `NetworkController` is the
seam so that costs an implementation rather than a redesign.

## Testing

This software auto-updates on machines where a broken deploy costs real time and money. Tests are a safety net, not a checkbox.

**Unit tests** (vitest, `server/src/*.test.ts`): Every pure-logic module gets unit tests — parsers, state machines, calculations, data transformations. If it has no side effects and takes input → output, it gets a test. Run with `cd server && npm test`.

**Integration tests**: Test the server-side pipeline with real SQLite (in-memory), real ingestion, real recording. Verify data flows end-to-end: source emits reading → ingestion routes → SQLite stores → recording captures → export produces correct format. Use the Elvis simulator to generate realistic frames.

**What to test**: Anything that could silently corrupt data or break offline operation. Sensor mapping resolution, recording start/stop lifecycle, upload retry logic, config persistence, file import parsing. Prefer testing behavior ("a recorded session exports with correct column names") over implementation ("function X is called with Y").

**What not to test**: React component rendering, CSS layout, trivial getters, framework glue code. Don't mock the database — use in-memory SQLite so tests verify real SQL.

**Tests never touch a real database.** `DB_PATH` is forced to `:memory:` in `server/vitest.config.ts`, which is the only correct place for it: `db.ts` opens its connection at *import* time, so setting `process.env.DB_PATH` inside a test file — even in `beforeAll` — is too late if any module already pulled `db.ts` in. Do not set it per-test and do not remove it from the vitest config. A suite that deletes rows must additionally assert `databasePath() === ':memory:'` before it runs. This rule exists because a reset test once wiped a developer's real `kiosk.db`, sessions and readings included.

**Smoke tests** (Playwright, `npm run test:smoke`): Not a full E2E suite — three tests that boot the app at 1024x768 and check the shell renders, nothing overflows, and the recording bar stays a single row. These catch catastrophic failures (broken build, missing assets, layout completely off-screen) that unit/integration tests can't. Keep the count low and the assertions broad. If a smoke test breaks on every CSS change, it's too specific — pixel thresholds for one particular arrangement belong in prose here, not frozen in a test that will cry wolf the next time somebody moves a button.

They exist for the failures no unit test can see: the viewport is a hard constraint, and a recording bar that silently wraps to a second row costs the drilling profile 76px. Three things about them are load-bearing:

- **The viewport goes in the project's `use`, after the `devices[…]` spread.** `devices['Desktop Chrome']` carries its own 1280x720 viewport and will silently override a top-level `use.viewport` — which makes every assertion run at a resolution the kiosk never uses.
- **Routing is hash-based.** `page.goto('/bohren/P-01')` is served the SPA shell and then parsed as the *home* route, so it measures the element list instead. Use `/#/bohren/P-01`.
- **The browser logs every 4xx/5xx response as a console error.** An unconfigured kiosk answering 503 from `/api/…` is correct degradation, so console errors are filtered to real script errors while *non-API* request failures stay strict — a 404 on a JS chunk is exactly what this should catch.

`e2e/seed.mjs` prepares a throwaway database through the server's own `db` module (importing it is what creates the schema, and it avoids a second copy of the DDL). It refuses to touch a path ending in `kiosk.db`, the same rule the vitest config enforces.

**Pre-update health check** (server-side): Before the auto-updater commits to a new version, the new server must boot and respond to `/health` with a passing status (DB accessible, config loadable, static assets present). If the health check fails, the updater keeps the previous version. No browser involved — this runs on the kiosk itself.

## Logging

All server-side logging uses **pino** via the `logger.ts` module. Never use `console.log`/`console.error` in server code — the only exception is `config.ts` for startup validation failures (which fire before the logger and exit immediately).

**Usage**: Import `createLogger` and create a module-scoped child logger:
```ts
import { createLogger } from './logger.js';
const log = createLogger('mymodule');
log.info('Something happened: %s', detail);
log.error('Failed: %s', err.message);
```

**Format**: JSON in production (captured by PM2 to `~/.pm2/logs/`), pretty-printed in development via `pino-pretty`. Each log entry includes a `module` field for filtering.

**Never set `NODE_ENV=development` on a kiosk.** `pino-pretty` is a
devDependency and a kiosk installs with `npm install --omit=dev`, so the dev
logger's transport cannot load: the server exits at startup and PM2 restarts it
into a crash loop. It is the obvious way to unlock a dev-only affordance in the
UI, and it takes the machine down instead — which is why the custom API URL in
Einstellungen → Verbindung is not gated on it.

**Remote access**: `GET /api/logs` returns the last N log entries from an in-memory ring buffer (1000 entries max). Query params: `limit` (number), `level` (pino level name, e.g. `error`), `module` (e.g. `updater`). This endpoint is for service personnel diagnosing issues without physical access to the kiosk.

**Log levels**: Use `info` for operational milestones (connected, session started, update applied), `error` for failures that need attention, `warn` for degraded states, `debug` for development diagnostics. Don't log at `info` level in tight loops (per-reading, per-frame) — those go to `debug` at most.

**Log sensor upload**: When `LOG_SENSOR_UPLOAD=true` and the platform has a string sensor named `logs` for the device, log entries at or above `LOG_SENSOR_LEVEL` (default `warn`) are automatically recorded as session readings and uploaded with the session data. Format: `{"l":"error","m":"updater","msg":"..."}`. Disabled by default to avoid unnecessary mobile data usage — enable per-kiosk for pilot deployments. This convention is shared with ESP32 devices for a unified log format across the device ecosystem. The `logs` sensor is auto-created at startup via `PUT /api/v1/measuring-device/sensor-string`.

## Stack

- **Server**: Fastify, pino, mqtt.js, better-sqlite3, TypeScript
- **UI**: React, Vite, vite-plugin-pwa
- **Process manager**: PM2
- **Updates**: GitHub Releases
