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
  produces nothing.
- **The depth sensor is resolved by role, never by name.** It is `Bohrtiefe` for
  Injektionsbohren and Ankerbohren but `Tiefe` for DSV
  (`findSensorNameByRole('depth')`). Note that web's reader hardcodes
  `Bohrtiefe`: for Injektionsbohren — the only Verfahren with a consumer today —
  that is the role-`depth` sensor, so the two agree. A future DSV consumer
  reading `Bohrtiefe` while the kiosk aligned against `Tiefe` would see nothing,
  and the two sensors only share a timestamp when they arrive in one Elvis
  frame.
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

### The profile committed at stop is complete

A profile is flat and gapless — each layer runs to the next, the last to the
bottom — so **partial geology is not representable**: a single code asserts the
ground continues to the bottom of the hole. There is no way to record "sand
from 2 m, and no claim below that".

Every stop that followed real drilling therefore commits a **complete profile**,
with the stretches the operator never confirmed back-filled from the
Schichtauftrag (`Geologie n` / `Tiefe Geologie n`, parsed by
`vorgabe-geology.ts`). That is the only option that neither discards what the
operator saw nor invents a boundary they rejected. Back-filled boundaries are
marked in the **`Geologie` text with a ` (Vorgabe)` suffix** —
`VORGABE_SUFFIX` in `geology.ts`. Provenance goes there because nothing else
survives the trip: the backend stores numbers and strings, `GeoDIN` has no room
for it, and `Geologie` has no other writer.

**The back-fill is server-side, on every stop path.** `geology-profile.ts`
builds the profile, and `POST /api/recording/stop` commits it whether or not the
request carried one. The touchscreen's sign-off screen is therefore a *review
step, not a gate*: a stop by voice, from a second browser tab, or straight from
the recording bar produces the same profile as a reviewed one. The screen edits
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

### Per project

- **implenia-mqtt-kiosk** — `depth-timestamp.ts` owns the inversion (pure,
  unit-tested); `geology-profile.ts` owns the merge; `geology.ts` owns the
  write, the provenance and the idempotent re-commit; `vorgabe-geology.ts`
  parses the planned profile.
  `POST /api/recording/stop` takes an optional `geology` body and commits it
  **before** ending the session, because ending it is what releases the
  auto-upload. A re-commit removes the previous commit's `pending` readings
  only, so nothing already on the platform is touched. The stop is never
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
