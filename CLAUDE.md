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

The self-updater on the kiosk polls GitHub Releases hourly, compares semver against the root `package.json` version, and applies updates automatically via PM2 restart.

## CI Quirks

**Rollup platform binaries**: `package-lock.json` is generated on macOS and only contains resolved entries for macOS-specific optional dependencies (e.g. `@rollup/rollup-darwin-arm64`). Running `npm ci` on Linux (GitHub Actions) fails because the linux binary (`@rollup/rollup-linux-x64-gnu`) isn't in the lockfile. The CI workflow uses `npm install` instead of `npm ci` to let npm resolve platform-appropriate binaries. Do not switch CI back to `npm ci` without first ensuring the lockfile contains cross-platform entries.

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
  (`uploadSession` → `autoMarkComplete`), on the manual
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
  self-update hourly while the backend deploys separately, so both versions are
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

## Sensor roles are pinned to the session

A sensor's **role** (`depth`, `is_completed`, `geology_nr`, `geology_text`, …)
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
- any session that outlives an auto-update — kiosks take one hourly and a
  recording can run for a day, so the role can resolve differently at sign-off
  than it did at start.

`beginRecording` therefore writes each sensor's `role` into the session's
`sensor_map` alongside its id, and `sensorNameByRole` (recording.ts) resolves
from there, falling back to `findSensorNameByRole` for sessions recorded before
roles were persisted. Same reasoning as the ids, which have always been pinned
there rather than re-fetched: a recording keeps behaving the way it did when it
started.

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
  hourly and implenia-web deploys separately, so both shapes are live in the
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

## Worker-observed geology (`GeoDIN`) — shared convention across two projects

The geology a worker actually encountered is uploaded as a **`GeoDIN`** integer
time series (CSV role `geology_nr`) alongside a **`Geologie`** text series (role
`geology_text`). implenia-web turns the numbers back into layers by **change
detection**: each reading whose code differs from the previous one starts a
layer, at the **depth of the same reading**. There is no layer table and no
depth field — the series *is* the profile.

The kiosk is the only writer. Both herstellen CSVs declare `GeoDIN` as
`Quelle=server` and implenia-web's `sensor-meta.ts` documents it as "derived
from geology_text by server", but **nothing derives it** — no implementation
exists in the backend or in web. The comment is aspirational, and
`RECORDABLE_ROLES` in `herstellen-sensors.ts` exists solely to stop that
`server` from excluding the sensor from the session's sensor map. The honest fix
is `Quelle=kiosk` in implenia-web's CSVs plus a re-sync; until then the
exception keeps both versions interoperable.

### The alignment rule — the one that fails silently

**Every `GeoDIN` reading must be dated at the exact `received_at` of an already
recorded depth reading.**

implenia-web aligns the two series by **millisecond equality**
(`rowMap.get(date.getTime())` in `herstellungLayersFromRows`,
`app/models/injektionsbohren-protocol.server.ts`) and skips any row where
either value is null. A reading dated at `Date.now()`, or at an interpolated
instant, therefore produces **no layer at all**: it uploads cleanly, appears in
raw charts, and the protocol shows zero observed layers. Same shape of silent,
total loss as a sensor name that fails to resolve.

What follows from this, and must not be broken:

- **Depth is never taken from the browser.** The live entry route
  (`POST /api/recording/geology`) carries only a ground-type number; the server
  dates the reading at its latest depth reading. A client-measured depth would
  have to be matched back to a reading, and a client one sample out of step
  produces nothing. The same route **refuses outright once drilling has ended**
  (`drilling_ended_at` set): the newest reading is then a retraction reading,
  outside the window every geology read is bounded by, so the entry would be
  written, answered with a depth, shown as recorded — and absent from every
  profile. The buttons and the voice commands are gated on the *browser's* view
  of the mode, which a second tab does not share, so the server cannot rely on
  them. Clamping onto the last drilling reading instead would silently assert
  the operator saw that ground at the bottom of the hole.
- **The depth sensor is resolved by role, never by name** — and the role comes
  from the session, not from the sensor CSVs (`sensorNameByRole`, see
  "Sensor roles are pinned to the session"). It is `Bohrtiefe` for
  Injektionsbohren and Ankerbohren but `Tiefe` for DSV. Note that web's reader
  hardcodes `Bohrtiefe`: for Injektionsbohren — the only Verfahren with a
  consumer today — that is the role-`depth` sensor, so the two agree. A future
  DSV consumer reading `Bohrtiefe` while the kiosk aligned against `Tiefe`
  would see nothing, and the two sensors only share a timestamp when they
  arrive in one Elvis frame.
- **Readings are matched by `sensor_id`, not by topic.**
  `session_readings.topic` holds the rig's raw MQTT topic, which differs per
  machine; the session's own `sensor_map` resolves a name to the id every
  reading carries.
- **The depth series is filtered to real drilling**: `phase = 'bohren'` (which
  drops the Rohrverlängerung phantom depths, see `rohrwechsel.ts`) and
  `upload_status != 'clipped'`. A boundary dated against either would sit at a
  depth the hole never had.
- **Timestamps must be strictly increasing across a profile.** Two `GeoDIN`
  readings at one instant are one row to web, and the upload's own
  per-timestamp deduplication keeps only the last — so a collision discards a
  layer. `alignBoundaries` in `depth-timestamp.ts` gives each boundary its own
  reading.
- **A boundary deeper than the hole ever got is dropped, not clamped.**
  Clamping would assert the drill observed ground it never reached, and several
  such boundaries would all clamp to the same instant, costing real layers to
  report fictional ones.
- **A boundary shallower than the session recorded is dropped too**, and for a
  worse reason. On a resumed element whose second session starts at 8 m, every
  planned boundary above that would take the next free reading and come out as
  a 10 cm layer at 8.0, 8.1, 8.2 — a plausible-looking profile, entirely
  fabricated, reported as a clean success. The tolerance is the largest gap
  between consecutive readings: the drill plausibly passed any depth inside a
  sampling gap and nothing outside one. Ground above where recording began is
  what web's `fillInitialGap` covers from the Vorgabe.
- **A live entry with no new depth reading since the last one replaces it.**
  The depth series is filtered to `phase = 'bohren'`, so the latest reading
  stands still for the whole of a Rohrverlängerung — minutes in which every tap
  lands on one instant. Two readings there are one row to web, and the upload's
  per-timestamp dedup keeps only the last, so an obstruction entered and left
  could vanish entirely. Replacing is also what the operator means: two ground
  types at one depth is not a profile.
- **Nothing about geology may stop a recording from ending.** The commit runs
  in its own `try`/`catch` inside the stop route; a failure costs the profile
  and nothing else. Inside the handler's own catch it returned 409 without
  ending the session, leaving the operator on a sign-off screen whose stop
  button kept failing.

### Obstructions are not a separate concept

DIN 4023 numbers 59–64 (`Hindernis Stahl/Beton/Holz/Sonstiges`, `Hohlräume`,
`Findling`) live in the same number space as soils and rocks. An obstruction is
an ordinary thin layer, and entering and leaving it are two ordinary code
changes. web's existing reader renders it correctly with no change at all, and
the profile survives the round trip through the series without loss.

### Every committed profile is complete

A profile is flat and gapless — each layer runs to the next, the last to the
bottom — so **partial geology is not representable**: a single code asserts the
ground continues to the bottom of the hole. There is no way to record "sand
from 2 m, and no claim below that".

Every commit that followed real drilling therefore writes a **complete
profile**, with the stretches the operator never confirmed back-filled from the
Schichtauftrag (`Geologie n` / `Tiefe Geologie n`, parsed by
`vorgabe-geology.ts`). That is the only option that neither discards what the
operator saw nor invents a boundary they rejected. Back-filled boundaries are
marked in the **`Geologie` text with a ` (Vorgabe)` suffix** —
`VORGABE_SUFFIX` in `geology.ts`. Provenance goes there because nothing else
survives the trip: the backend stores numbers and strings, `GeoDIN` has no room
for it, and `Geologie` has no other writer.

**The back-fill is server-side, on every commit path.** `geology-profile.ts`
builds the profile; `POST /api/recording/geology/commit` and
`POST /api/recording/stop` both commit it whether or not the request carried
one. The touchscreen's sign-off screen is therefore a *review step, not a gate*:
a stop by voice, from a second browser tab, or straight from the recording bar
produces the same profile as a reviewed one. The screen edits what the server
built rather than deriving its own, so there is one implementation and one
answer — which is also why the voice stop deliberately does **not** route
through the sign-off (a hands-free operator would have no spoken way off that
screen).

Two rules inside the merge are easy to get wrong:

- **Adjacent layers of one ground type merge, shallower boundary surviving.**
  That is what moves a planned boundary to where it was actually seen, and what
  stops a confirmation that changed nothing from splitting a layer in two.
- **An obstruction is never extended to the top of the hole.** Extending soil
  upward where no Vorgabe fills it is a mild assumption that is usually right;
  extending `Hindernis Beton` upward asserts the drill met concrete from the
  surface, which nobody said. Such a profile legitimately starts below zero —
  the series then says "at 2.0 m the code became 60" and nothing before, which
  is exactly what web's `fillInitialGap` exists to handle.

The `Geologie` text is composed from the DIN tables in the **din4023 package,
which the server depends on** (its root entry carries the tables and no React) —
not from a name the client sends. A caller may still override it per layer for
an operator's own description. This keeps a profile reading the same however the
recording was stopped, and stops a client labelling a layer as something it is
not. Nothing in implenia-web reads this series; `GeoDIN` is what layers come
from.

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
  drilling data. Without the bound, retraction widens `alignBoundaries`'
  tolerance (the only guard against the fabricated `zuFlach` layers), lets a
  boundary be dated on the way back up, and inflates `drilledDepth`, which is
  `max − min`. `drillingWindowEnd` in geology.ts owns it.
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
Nothing records that the operator *deleted* a planned boundary — `observedOnly`
can recover what was written, never what was refused. So on a resumed element
the step back into `bohren` clears the sign-off, the next step out rebuilds the
context, and `mergeProfile` re-adds every Vorgabe boundary: one the operator
explicitly deleted at the first sign-off reappears (dashed) at the second and is
committed unless they delete it again. Within a single sign-off the deletion
holds, which is the common case; fixing it across one properly means persisting
rejections, not special-casing the rebuild.

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

**A re-commit must keep its provenance.** The commit was always repeatable and
is now routinely repeated, which made a latent bug reachable: reading the
committed `GeoDIN` series back marks every boundary as observed, the kiosk's own
back-fill included, so the profile keeps its shape and silently loses the
` (Vorgabe)` suffix. `observedOnly` in geology.ts joins the two series on
`received_at` and drops the back-filled rows — **after** web's change detection,
never before. Before it, an observation repeated either side of a back-filled
boundary of another type becomes two consecutive identical codes, the second
reads as "no change", and a real layer disappears.

The sign-off screen has **one** forward button at the phase step
(`Weiter zum Austausch`) and no second exit: the way back from a mis-tapped
phase step is the phase stepper, which stays in the header on that screen for
exactly that. A second exit there would quietly make the review skippable.

### Per project

- **implenia-mqtt-kiosk** — `depth-timestamp.ts` owns the inversion (pure,
  unit-tested); `geology-profile.ts` owns the merge; `geology.ts` owns the
  write, the provenance and the idempotent re-commit; `vorgabe-geology.ts`
  parses the planned profile.
  `POST /api/recording/geology/commit` is the normal write, at the step out of
  `bohren`; `POST /api/recording/stop` takes the same optional `geology` body
  and commits **before** ending the session, because ending it is what releases
  the auto-upload. A re-commit removes the previous commit's `pending` readings
  only, so nothing already on the platform is touched. Neither route is ever
  refused over its geology: a malformed profile costs the geology and nothing
  else.
- **implenia-web** — `herstellungLayersFromRows`
  (`injektionsbohren-protocol.server.ts` and `injektionsbohren-export.server.ts`)
  is the reader. `fillInitialGap` fills the 0 → first-boundary stretch from the
  Vorgabe; the kiosk now writes a layer at the top of the hole explicitly, so
  that path is a fallback for older data rather than the normal case. Only
  Injektionsbohren has a consumer today — DSV declares the sensors with none.

**Known deviation:** the UI parses the Vorgabe geology a second time
(`ui/src/utils/vorgaben.ts` → `buildSchichten`) for the Soll profile the element
and drilling screens draw, and for the approaching-boundary suggestion. That
path is display-only and renders synchronously from already-cached props, which
is why it was not replaced by a fetch. The server's `vorgabe-geology.ts` is the
only parser on the correctness-critical path — if the two ever disagree, a drawn
picture is slightly wrong and nothing is miscommitted.

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
branch adds the nil), and a NULL is this kiosk's outage marker. Three
consequences, none of them optional:

- **A CSV upload with no grid is refused.** Ungridded, each row carries one
  value and thirteen empty cells, so the captured session would upload 275 935
  measurements and 3 566 722 fabricated outages. `validateReduction` rejects the
  combination and `runUpload` re-checks it, because a settings row written before
  that check must not produce one either.
- **Each chunk carries only the columns it has values for.** A sensor that
  records only during Verpressen is simply absent from the Bohren chunks instead
  of contributing an empty cell to every one of their rows.
- **String sensors never go this way at all** — an empty cell there writes an
  empty *string*, and for `Ausführungsdatum` an empty string un-completes an
  element.

**`GeoDIN` may never be gridded.** implenia-web turns it into layers by change
detection, and `alignBoundaries` deliberately gives every boundary its *own*
depth reading so the timestamps stay strictly increasing (see "Worker-observed
geology"). Two boundaries 290 ms apart share a 1 s interval, and one row is one
layer, so a grid drops layers from a profile that uploads cleanly and shows
nothing.

**Protecting only `GeoDIN` achieves nothing, which is the trap.** A `GeoDIN`
entry carries no depth of its own: `geology.ts` writes it at the exact
`received_at` of a **depth** reading, and web recovers the layer's depth by
pairing the two on millisecond equality, dropping any row whose `bohrtiefe` is
null. The timestamp is the entire mechanism. Grid the depth series and the
reading the boundary points at stops existing on the platform — it looks for a
depth at 580 ms, the platform has one at 870 ms, and the layer is gone. The
first version of this change guarded one end of that link and cut the other.

**The depth series is gridded anyway, and the anchors are pinned back in.**
Leaving it ungridded costs the largest single channel its reduction — 26 699 of
G08's 275 935 readings, 14x down to 6.2x — and it is not necessary. The value at
the boundary's instant is not something to interpolate: it is a reading that
exists, because the boundary was dated at it in the first place.
`pinAnchorReadings` (`csv-upload.ts`) selects exactly those readings and
`runUpload` sends them as one extra per-sensor batch beside the chunks. The
platform upserts on `(sensor_id, date)`, so they join the thinned series as
extra points. On G08 with 18 boundaries that is **18 readings, about 1 KB**, and
all 18 stay joinable.

Three things about that batch, none optional:

- **It claims no reading ids.** They belong to the CSV chunk that gridded them;
  marking them twice would have two halves of one upload fighting over the same
  rows.
- **It still counts in `sensorsFailed`.** A profile the platform cannot
  reassemble is the same loss as one that never uploaded, so a failure holds the
  element open and the recording bar's retry runs it again.
- **It is built from the session, not from the pending groups**, and runs
  whenever the grid is in play. On a retry the chunks that gridded those
  readings are already marked uploaded, so a pending-only lookup would find
  nothing to pin and leave the boundaries pointing at nothing.
- **It is deduplicated by instant, last value winning.** Two readings share a
  millisecond at a high ingest rate (replay 60x, fast MQTT), and the platform's
  multi-row upsert refuses a batch naming one `(sensor_id, date)` twice. This
  batch is *every* boundary's anchor, so one duplicate fails all of them, and
  fails identically on every retry. Same rule as the per-sensor loop's own
  dedup, for the same reason.

`ALIGNMENT_ANCHOR_ROLES` (`depth`) and `ANCHORED_ROLE` (`geology_nr`) name the
two ends. Both resolve by role from the session's own map, never by name: the
depth sensor is `Bohrtiefe` for Injektionsbohren and Ankerbohren but `Tiefe` for
DSV. **First match wins, as in `sensorNameByRole`** — a map carrying one role
twice is legal and the shipped CSVs do it (`gear`, `torque`), and the two
resolutions have to agree: `geology.ts` dates its boundaries against the sensor
`sensorNameByRole` picked, so pinning the other one would thin the series those
boundaries point at and lose every layer, silently.
`EXACT_TIMESTAMP_ROLES` (`geology_nr`, `geology_text`, `is_completed`) stays
what it was — every reading keeps its instant, per-sensor, in the same upload.

The honest long-term fix is for a geology entry to carry its own depth instead
of borrowing one by timestamp. That is a contract change across all three
projects, not something to slip into a compression change.

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
self-update hourly while the backend deploys separately, so both versions are
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

**Remote access**: `GET /api/logs` returns the last N log entries from an in-memory ring buffer (1000 entries max). Query params: `limit` (number), `level` (pino level name, e.g. `error`), `module` (e.g. `updater`). This endpoint is for service personnel diagnosing issues without physical access to the kiosk.

**Log levels**: Use `info` for operational milestones (connected, session started, update applied), `error` for failures that need attention, `warn` for degraded states, `debug` for development diagnostics. Don't log at `info` level in tight loops (per-reading, per-frame) — those go to `debug` at most.

**Log sensor upload**: When `LOG_SENSOR_UPLOAD=true` and the platform has a string sensor named `logs` for the device, log entries at or above `LOG_SENSOR_LEVEL` (default `warn`) are automatically recorded as session readings and uploaded with the session data. Format: `{"l":"error","m":"updater","msg":"..."}`. Disabled by default to avoid unnecessary mobile data usage — enable per-kiosk for pilot deployments. This convention is shared with ESP32 devices for a unified log format across the device ecosystem. The `logs` sensor is auto-created at startup via `PUT /api/v1/measuring-device/sensor-string`.

## Stack

- **Server**: Fastify, pino, mqtt.js, better-sqlite3, TypeScript
- **UI**: React, Vite, vite-plugin-pwa
- **Process manager**: PM2
- **Updates**: GitHub Releases
