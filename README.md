# Implenia Kiosk

Local-first, self-updating kiosk application for construction sites. Collects sensor data via serial (Elvis ESP32) or MQTT, displays live readings in a touch-optimised browser UI, buffers data offline in SQLite, and uploads to the Implenia REST API when connectivity is available.

## Architecture

```
DataSource (MQTT | Serial | Simulator)
      → Ingestion (routes readings)
          → SQLite buffer (mqtt_buffer + session_readings)
          → WebSocket → Browser UI (React PWA)
      → Recording → batch upload → Implenia API
```

Data intake is abstracted behind a `DataSource` interface. Each source emits `SensorReading` events. The `DataIngestion` layer routes readings to SQLite, WebSocket broadcast, and session recording — source-agnostic.

**One transport is active at a time**, chosen by `meta.transport` (`mqtt` or `serial`) and swapped at runtime via `ingestion.setSource()`:

- **MQTT** (`mqttSource`) — one broker, one subscription, topics resolved to sensors
- **Serial** (`deviceSource`) — wraps `deviceManager`, turning each device frame into readings using the channel mappings (`device_id`, `value_index`) → sensor name, emitted as `device/<id>/<sensor>`

Both converge on the same `SensorReading` shape before anything is buffered, recorded or uploaded. `deviceManager` is owned by the serial source, so an MQTT kiosk does not also poll USB ports. Raw `device-frame` messages are still broadcast separately, because the channel picker needs values by index.

```
GET /api/config/transport   → { transport, label, configured, available }
PUT /api/config/transport   → { transport } — swaps the live source, no restart
```

The transport is **write-once**, like the Verfahren. A rig's wiring does not change mid-project, and a wrong choice announces itself within minutes — no data arrives at all — at a point where resetting costs nothing because nothing has been recorded yet. Changing it requires a reset.

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- (Production) PM2 for process management

## Development Setup

```bash
# 1. Clone and install
git clone <repo-url> && cd implenia-mqtt
npm install

# 2. Configure environment
cp server/.env.example .env
# Edit .env — see Environment Variables below

# 3. Start dev servers (server + UI with HMR)
npm run dev
```

The UI dev server runs on `http://localhost:5173` and proxies API/WS requests to the server on port 3000.

**Dev mode** enables a simulator device type in the config UI for testing without physical hardware.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MQTT_BROKER_URL` | No | — | MQTT broker URL. Pre-seed only — a value stored by the setup wizard wins. Without either, the MQTT source stays disconnected |
| `MQTT_TOPICS` | No | — | Comma-separated subscription filters. Pre-seed only — see `MQTT_BROKER_URL` |
| `IMPLENIA_API_URL` | No | — | Implenia REST API base URL (also configurable in UI) |
| `IMPLENIA_API_KEY` | No | — | Bearer token for the API (also configurable in UI) |
| `GITHUB_OWNER` | No | — | GitHub org/user for update checks. Baked into the release image; without it GitHub polling is skipped and USB updates still work |
| `GITHUB_REPO` | No | — | GitHub repo name for update checks. See `GITHUB_OWNER` |
| `GITHUB_TOKEN` | No | — | Token for private repo access |
| `UPDATE_CHECK_INTERVAL_MS` | No | `3500000` | Update check interval (ms) |
| `DB_PATH` | No | `<cwd>/kiosk.db` | SQLite database path. `:memory:` for an ephemeral DB. `server/vitest.config.ts` forces this for every test — db.ts opens its connection at import, so setting it inside a test file is too late and a destructive test would hit the real kiosk.db |
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `production` | `development` / `production` / `test` |
| `CONNECTIVITY_PROBE_HOST` | No | `8.8.8.8` | DNS host for connectivity checks |
| `CONNECTIVITY_POLL_INTERVAL_MS` | No | `30000` | Connectivity poll interval (ms) |
| `USB_UPDATE_PATHS` | No | `/media` | Comma-separated dirs to scan for USB update bundles |
| `LOG_SENSOR_UPLOAD` | No | `false` | Upload log entries as string sensor readings |
| `LOG_SENSOR_LEVEL` | No | `warn` | Minimum level for sensor-uploaded logs |

**No variable is required to boot.** A machine with no `.env` at all starts, serves the UI and answers `GET /api/verfahren` — that is what lets the setup wizard run on a fresh industry PC. Missing values degrade the affected feature (MQTT stays disconnected, GitHub update checks are skipped) and are logged as warnings. A *malformed* value (e.g. an unparseable URL) is still a hard startup failure.

## Logging

All server-side logging uses **pino** via the `logger.ts` module.

```ts
import { createLogger } from './logger.js';
const log = createLogger('mymodule');
log.info('Something happened: %s', detail);
```

- **Development**: pretty-printed via `pino-pretty`
- **Production**: JSON, captured by PM2 to `~/.pm2/logs/`
- **Remote access**: `GET /api/logs?limit=50&level=error&module=updater` returns entries from an in-memory ring buffer (1000 max)
- **Sensor upload**: when `LOG_SENSOR_UPLOAD=true`, log entries at `LOG_SENSOR_LEVEL` or above are recorded as session readings and uploaded with session data

Never use `console.log` in server code — the only exception is `config.ts` for startup validation failures.

## Configuration UI

The settings page (`#/config`) provides:

- **API key** — base64-encoded JSON token from the Implenia portal. Validated on save via `GET /api/v1/measuring-device/self`
- **Server address** — Production / Development preset selector, plus free-text for local development
- **Devices** — add/edit/remove Elvis (serial) and simulator devices
- **Sensor mapping** — assign serial channel indices to named sensors per Verfahren (machine type)
- **Datenübertragung** — how much of a recording leaves the kiosk and by which route (see "Data Reduction" below)
- **Software update** — manual `.tar.gz` upload for offline environments
- **Fernwartung** — this machine's AnyDesk ID, and whether AnyDesk is connected

## On-Screen Keyboard

There is no physical keyboard on a kiosk, so the app brings its own
(`TouchKeyboard`, `utils/touchKeyboard.ts`). Every value anybody enters goes
through it: the broker URL and API token in the wizard, calibration factors, a
geology description, a comment.

It attaches by listening for `focusin` on the document rather than by wrapping
each input, so a field added later gets a keyboard without anybody wiring one
up, and the layout follows what the markup already declares:

| Field | Layout |
|---|---|
| `inputMode="decimal"` / `"numeric"` | Numeric pad with `,` and `-` — a calibration offset is routinely negative |
| `type="number"` | Numeric pad, **digits only** (see below) |
| everything else, including `type="password"` and `textarea` | German QWERTZ, umlauts in the letter rows, `123` layer for `: / @ _` and digits |

Four things about it are load-bearing:

- **It is a flex child of the shell, not an overlay.** Rendered between `main`
  (which is `flex: 1`) and the recording bar, it takes its height out of the
  content instead of covering it, so the live depth and the stop button stay
  visible while somebody types. A **full-viewport overlay that holds an input**
  cannot shrink that way and must end at `var(--keyboard-inset, 0)`, which the
  keyboard publishes on `:root` while open — `GeologiePicker` does, since its
  search field is the one place a worker types mid-drilling. The inset is the
  distance from the bottom of the viewport to the top of the keyboard, *not*
  the keyboard's height: the keyboard sits above the recording bar, so
  reserving its height alone leaves the overlay overlapping it by the bar's
  76px
- **Keys act on `pointerdown` and cancel it.** `preventDefault` keeps focus and
  the caret in the field, and since nothing listens for `click`, there is no
  compatibility click afterwards to land on whichever key replaced this one
  when the layout switched
- **Writes go through the prototype's `value` setter plus a bubbling `input`
  event.** Assigning `el.value` on a controlled React input is swallowed on the
  next render
- **`type="number"` can hold no decimal separator at all**, and a period is not
  a workaround. HTML value sanitization empties the value whenever it is not a
  valid floating-point number, and the intermediate state of typing a decimal
  always is one: after `1.` the browser answers `el.value` as `""`, so the next
  digit starts a new number and `1`, `.`, `2` comes out as `2`. Nothing on this
  side can produce that intermediate, so the pad for those fields carries
  digits only. Nothing is lost — the only `type="number"` field here is the
  Elvis baud rate, an integer, while the fields that really hold decimals
  declare `inputMode="decimal"` on a text input and normalise `,` to `.`
  themselves (`CalibrationPage.parseNumber`, `RohrwechselSettings`)

Enabled by `any-pointer: coarse`, i.e. on the kiosk and not on a development
machine. `localStorage.touchKeyboard = 'on' | 'off'` overrides it.

## Remote Access

```
GET /api/remote-access   → { id: "1234567890" | null, status: "online" | "offline" | null }
```

AnyDesk, set up by `scripts/provision-kiosk.sh` with unattended access, so a
service tech can reach a kiosk without a worker accepting anything. The
settings screen shows the ID for reading out over the phone.

The ID is read from `/opt/kiosk/anydesk-id.txt`, written once during
provisioning — **not** from `anydesk --get-id`, which answers an empty line and
exit status 1 for anyone but root, and this server runs as the kiosk user.
Everything degrades to `null`: no AnyDesk, no network, or a provisioning run
that never reached AnyDesk's servers are all normal states, and the screen says
so rather than showing an error. Only a hit is cached, so a kiosk provisioned
after the server started shows its ID without a restart.

See [docs/kiosk-provisioning.md](docs/kiosk-provisioning.md) for the setup.

## Sensor Schema

Sensor definitions live as CSV files in `server/assets/sensors/` (copied from `../implenia-web/app/assets/`). Each Verfahren (DSV, Ankerbohren, etc.) has a `*-sensors-herstellen.csv` defining sensor name, type, unit, source, role, priority, and MQTT alias.

```bash
# Sync after changes in implenia-web
./scripts/sync-sensors.sh

# Verify without copying (suitable for CI)
./scripts/sync-sensors.sh --check
```

The server exposes these via `GET /api/verfahren/:type/sensors` (optional `?source=mqtt` filter).

Each Verfahren's process, sensor semantics and kiosk-side requirements are documented in [`docs/verfahren/`](docs/verfahren/README.md) — start there when working on a new machine type.

The Verfahren a machine is set up for is stored in the database (`meta.active_verfahren`) and drives every `Priorität` / `Rolle` / unit lookup:

```
GET  /api/verfahren             → all selectable Verfahren
GET  /api/verfahren/active      → { verfahren, label }; null until set up
PUT  /api/verfahren/active      → { verfahren } — write-once, 409 if already set
```

**Write-once by design.** Recorded sessions, serial channel mappings and stream-export columns are all interpreted through the active Verfahren, so switching it under existing data would silently reinterpret that data. Changing it requires a full reset. Until it is set, sensor metadata enrichment is skipped — the live view still works, just without CSV-derived priorities, roles and units.

### Vorgaben cache

Vorgaben (the Soll values and the geology profile) arrive bundled in the shift assignment: `GET /shift-assignment/unfinished-elements?include_vorgaben=true`. That list only carries **unfinished** elements, so as soon as an element's `Ausführungsdatum` is set it drops out — and its vorgaben go with it. A pillar spanning several days would be resumed blind: no geology profile, no Soll on any gauge.

Every shift-assignment fetch therefore writes each element's vorgaben to `element_vorgaben` (one row per element, the payload stored as opaque JSON). The element screen reads the live payload first and falls back to the cache only when the element is absent from it, so an edit in the portal is never masked by a stale copy.

```
GET /api/elements/:elementName/vorgaben   → { vorgaben } from the cache, 404 if never seen
```

Local by design: resuming a pillar is exactly the moment a site is likely to be offline, so a fallback that needed the API would fail where it is needed most.

### Sensor definition cache — starting a recording offline

Starting a recording needs the platform's sensor **ids**, not just names: readings upload to `/api/v1/sensor-<type>/<id>/batch`, and one stored without an id is kept locally and never uploadable. Resolving them used to be the only part of `beginRecording` that touched the network, which made the single most important action on a site depend on the thing least likely to work there. A site with an imported Schichtauftrag could list its elements and then fail to record one with `409 fetch failed`.

The definitions are therefore cached per element in `element_sensors`, from two sources:

- **Every successful fetch** from `/measuring-device/self/child/name:<element>`. After the first start, an element works offline.
- **The imported Schichtauftrag.** implenia-web's export carries each element's `sensors` (id, name, unit, meta), its `vorgaben_sensors` and `vorgaben_sensor_ids` for exactly this reason — it is the only way a site that has *never* been online can record data that is uploadable afterwards. At ~21 KB per DSV element the file is well past Fastify's 1 MiB default body limit, so the import route raises its own to 16 MiB (~750 elements).

```
POST /api/shift-assignment/import   → { ok, sensorsCached }
POST /api/recording/start           → 503 + German instructions when there are none
GET  /api/elements/:name/sensors    → the same resolution; 503 when there are none
```

Both element-sensor routes are served the same way:

```
GET /api/elements/:name/sensors           → the element's own (herstellen) sensors
GET /api/elements/:name/vorgaben/sensors  → the `vorgaben` child's, for the Soll units
```

`/api/elements/:name/sensors` is what the element screens read to know which sensors exist, what they are called and which of them is a hero tile. It goes through the *same* `resolveHerstellenSensors` as a recording start — deliberately one function, so the two cannot drift apart — and has no `getApiConfig()` guard: a kiosk that was never given API credentials and runs entirely off an imported Schichtauftrag is exactly the case that needs it to answer. Before, it returned 502 offline and `useHerstellenSensors` swallowed that into an empty list, so the screens silently rendered no sensors at all.

`/api/elements/:name/vorgaben/sensors` is the other half of the Vorgaben cache: the *values* have been served locally since that cache went in, and this is what says what they are called and in which unit. `useVorgabenSensors` swallows a failure the same way, so offline every Soll value on the element screen quietly lost its unit. Three details:

- **All six sensor keys are preserved.** The response is passed through to the screen, which reads `sensors_int_float` and `sensors_binary` too — two types the kiosk never records and which are therefore absent from `SensorDefs`. A cache that round-tripped through that type would drop them.
- **A 404 answers `{}`, not 503.** A pillar predating the `vorgaben` child device genuinely has none, and telling the operator to re-import would send them after a file that cannot help.
- **The cache row is merged, never overwritten.** The two halves arrive from different requests — the element's own sensors from the herstellen fetch or the import, the Vorgabe sensors from either that fetch or the screen's own request — so a plain write from one would drop the other, leaving the element unable to start a recording or unable to label its Soll values.

One consequence worth knowing: `fetchHerstellenSensors` will not cache an element at all while the Vorgabe answer is merely *assumed* empty (a network failure, as opposed to a 404), because an entry that subtracts nothing would later have the kiosk record a legacy pillar's Soll values as measurements. The exception is an element whose Vorgabe half is already on record, where the merge keeps it and the entry stays safe.

Four things about it are load-bearing:

- **The ids are always real.** Nothing invents or defers one. A session started offline uploads normally once the link returns, with no resolution step and no rewriting of `session_readings`.
- **Stored unfiltered.** The cache holds the element's sensors *plus* which of them are Vorgabe sensors; which ones get recorded is decided by `filterHerstellenSensors` at the moment of use. Caching the filtered result would freeze the sensor CSVs and `isRecordableSensor` as they stood on the day of the fetch, so a CSV sync or a fix to that filter would never reach anything already cached.
- **The CSVs enrich, they never decide.** `getSensorMetaLookup()` fills in the `source`/`role`/`priority`/`unit` the platform does not store, and only where they are missing. It must never determine whether a sensor *exists*: the CSVs are synced by hand from implenia-web and version separately from both the platform and this kiosk, so a sensor added there and not yet synced here has to reach the sensor map anyway. One that does not is recorded with a null sensor id and silently never uploaded. This is why the local CSVs are not a fallback source of definitions, tempting as it looks — they already carry name, type, unit, source and role.
- **A vorgaben set that is only assumed empty is not cached.** The vorgaben request failing on the network is not the same answer as a 404, which legitimately means a pillar predating the `vorgaben` child device. Caching `[]` for the former would later have the kiosk record and upload a legacy pillar's Soll values as if they were measurements.

When there is genuinely nothing — no platform, and an element never recorded here — the start is refused with **503** (not 409: nothing about the kiosk's state is in the way) and a German message naming the one thing that fixes it, using the exact label of the button on the element list. The old behaviour put the words `fetch failed` on a worker's screen.

All three callers bound their wait on the platform at 8s (`SENSOR_RESOLVE_TIMEOUT_MS`). `fetchImplenia` is otherwise unbounded, and a TCP connection to a host that is reachable but not answering — the normal shape of a bad mobile link — hangs for as long as the kernel allows, which on this path is an indefinite spinner with the Start button disabled. Uploads deliberately stay unbounded: they run in the background and giving up early only means retrying later.

### Sensor roles are pinned to the session

A sensor's role (`depth`, `is_completed`, `geology_nr`, …) belongs to the **element**, not to the kiosk: implenia-web's wizard stamps it into `sensor.meta` at element creation and the backend serves it with `include_meta=true`. The kiosk's copies of the same CSVs are whatever its last release shipped. Two independent snapshots of one source — so resolving a role from the CSVs *at the moment of use* reads the wrong one for an element created before a role moved or a sensor was renamed, and for any session that outlives an auto-update (hourly, and a recording can run for a day).

`beginRecording` therefore records each sensor's `role` and its real `name` in the session's `sensor_map` next to the id, and `sensorNameByRole` resolves from there — same reasoning as the ids, which have always been pinned rather than re-fetched. `findSensorNameByRole` stays the fallback for sessions recorded before this. Geology (`resolveSensors`) and post-upload completion (`autoMarkComplete`) both use it.

Two details are load-bearing:

- **`name` is persisted, not derived.** The map is keyed by the *lowercased* name, because that is all a resolved topic gives. A completion write is addressed to the platform by sensor name — `string_sensors: { Ausführungsdatum: … }` — so returning the key would write to `ausführungsdatum`: a different sensor, or a new one nothing reads. It is also the spelling a German "sensor missing" message should show.
- **Element-independent role lookups stay on the CSVs,** because they have no session to ask: ingestion's Rohrwechsel depth check on every live reading, topic resolution, the calibration and topic-assignment screens, the sensor-mapping UI, the volume-tracking set, and `stream` (absent from `SensorMeta`, which is `{source, role, priority}`). The manual complete/uncomplete routes have no session either and keep `findCompletionSensorName()`.

This closes a *visible* degradation rather than a silent one — before it, the sign-off said `Der Sensor „Bohrtiefe" fehlt in dieser Aufzeichnung` and the measurements still uploaded.


### First-start setup

Until a Verfahren is set, `App` renders `SetupWizard` instead of the whole app — not as a modal over it, but in place of it. The gate is checked before any routing, so there is no way into the app around it. If the state cannot be determined (server unreachable), the UI says so and retries rather than assuming "not set up" and showing the wizard by mistake.

The wizard is **service-personnel UI** and is deliberately exempt from the "no modals or multi-step flows" rule in `CLAUDE.md`, which is written for the worker-facing screens. Glove-sized tap targets, contrast, German text and the 1024x768 budget still apply. Each step commits its own setting as it completes, so an interrupted setup resumes instead of starting over.


Steps: **Verfahren** → **Datenquelle** (MQTT or serial) → the branch for that choice → summary. The step counter reflects the branch, so it does not promise a step that will not appear. The MQTT branch uses the same `MqttSettings` component as the config page, so the two cannot drift; the serial branch lists devices with live connection state and sends the technician to the settings for channel mapping, which needs the machine running to be doable at all.

The config page mirrors the choice: with `transport = mqtt` it shows MQTT settings, with `serial` the device list and channel mapping. Switching there swaps the live data source immediately, no restart.

### Reset

```
GET  /api/config/reset   → { allowed, unsafe: { sessions, readings, clipped }, preserves }
POST /api/config/reset   → 409 while data is unsafe, otherwise wipes and clears caches
```

**Clears:** Verfahren, transport, MQTT settings, devices, channel mappings, topic overrides, recorded sessions and readings, export records, the buffer, the imported shift assignment, the cached element vorgaben and sensor definitions. The UI additionally clears the voice comment queue, which lives in `localStorage` and is therefore out of the server's reach — and, for the same reason, blocks the reset itself while comments are still unsent: the server's guard cannot see them, so a kiosk that was offline all shift would otherwise report "nothing unsaved" and discard a shift of dictation.

**Keeps:** the API key and server address — the site's credentials, not this machine's setup, and re-entering a token on a touchscreen is miserable.

**Refuses — does not warn — while recorded data exists only on this kiosk.** "Safe" means uploaded *or* exported to a file: if only uploading counted, a kiosk with no connectivity could never be reset, which is the dead end the guard exists to prevent. An export only counts when the file actually contained readings; a Verfahren with no streams defined produces a header-only file, and treating that as saved would discard data nobody ever got off the machine.

Clipped Rohrwechsel readings are the one exception, and they are reported rather than counted: they can never be uploaded or exported, so blocking on them would refuse forever — but the reset deletes them, so the screen says how many are about to go and points at the release action on the recording bar.

A session exports **one file per stream**, so it only counts as exported once every stream that has data has been written (`session_exports` tracks them individually, `recordStreamExport()` decides). Marking the session after the first file would hand the remaining streams' readings to the next reset — never uploaded, never saved anywhere.

Because the reset clears the in-memory caches (`clearVerfahrenCache`, `clearTransportCache`, `clearResolverCache`, `clearMappingCache`) and cycles the data source, it needs no restart — unlike `scripts/reset-setup.sh`. The source is cycled, not just re-selected: `setSource()` is a no-op when the transport is unchanged, which is the common case, and the MQTT client would otherwise hold the previous site's connection and subscription straight through the reset.

It also detaches any running recording first (`abortRecording()`). The ingestion layer holds the session id in memory, and with `foreign_keys = ON` a reading arriving after the session row is deleted throws inside the data source's synchronous handler — uncaught, taking the process with it.

### Resetting the setup

```bash
./scripts/reset-setup.sh                      # asks first
./scripts/reset-setup.sh --yes                # no prompt
./scripts/reset-setup.sh --with-data          # also deletes recordings
DB_PATH=/path/to/kiosk.db ./scripts/reset-setup.sh
```

Clears the active Verfahren, the transport choice, the MQTT settings and the topic overrides, so the wizard runs again. **Keeps** recorded sessions and readings, serial devices and channel mappings, and the API key. Restart the server afterwards — the Verfahren and transport are cached in memory.

It warns when keeping data would orphan it: sessions recorded under the Verfahren being cleared would later export against a *different* Verfahren's column contract.

`--with-data` also deletes recorded sessions and readings, the buffer, devices and channel mappings — the escape hatch for data that will never upload, since the in-app reset refuses while readings are neither uploaded nor exported. It always asks separately and `--yes` does not cover it; you type `DELETE DATA` to confirm, or pass `--force`.

This is a development and service helper, not the kiosk's reset feature. The in-app reset still has to refuse to run while un-uploaded readings exist and confirm by tap; this script does neither, which is why it is not reachable from the UI. Since the Verfahren is write-once, this is currently the only way to choose a different one.

### MQTT settings

Broker address and subscription filter live in `meta` (`mqtt_broker_url`, `mqtt_topics`), collected by the wizard. The env vars are a pre-seed for a prepared image; the stored value wins, matching how `IMPLENIA_API_URL` already behaves.

```
GET  /api/config/mqtt          → current settings, defaults, connection state
POST /api/config/mqtt/test     → { brokerUrl } — try it without saving
PUT  /api/config/mqtt          → { brokerUrl, topics } — save and reconnect
GET  /api/config/mqtt/topics   → topics actually observed (default: last 5 min)
```

`normalizeBrokerUrl()` accepts what a technician would type — `192.168.2.1`, `192.168.2.1:1884`, or a full URL — and fills in the scheme and default port. This matters because a malformed broker URL is still a hard startup failure, so it is validated before anything is written.

The wizard defaults to **`mqtt://192.168.2.1:1883`**, the Implenia MQTT box's default address, and to the **`#`** filter. The wide filter is deliberate: on a new machine the topic naming is unknown, and a narrow filter makes unmatched topics invisible rather than visible-but-unassigned.

Saving calls `ingestion.restartSource()`, which cycles the data source in place. The broker URL is read in `start()` rather than frozen at import, so changing it needs no process restart.

`GET /api/config/mqtt/topics` reads `mqtt_buffer`, which is written before any sensor mapping is attempted — so it shows topics the kiosk cannot match to a sensor. That is the foundation for the sensor assignment screen.

### Topic assignment

An MQTT reading reaches its sensor by resolving the topic to a sensor name, in this order (`server/src/topic-resolver.ts`):

1. **`topic_overrides`** — wired on site, highest priority
2. **`server/assets/topic-maps/<verfahren>.json`** — shipped with the release
3. **The topic ends with a known sensor name** — the no-configuration case

Step 3 matches against the Verfahren's actual sensor names, longest first, rather than splitting the topic on `/`. A sensor name may itself contain a slash: `Drehzahl [1/min]` has the last segment `min]`, which matches nothing — so that sensor used to resolve to no id at all, was filtered out of every upload, and still displayed live. The screen looked right and the data never left the kiosk. Also affects `Durchfluss [l/min]` and, in DSV, `Bohren/Düsen` and `W/Z-Wert`.

```
GET    /api/config/topic-overrides          → expected sensors, what feeds each, and how it was bound
PUT    /api/config/topic-overrides          → { topic, sensorName }
DELETE /api/config/topic-overrides/:topic
```

The **Sensorzuordnung** screen at `#/sensors` (reached from the config page under the MQTT transport) drives this. It mirrors the serial `ChannelPicker`'s two-step shape — pick a sensor, then pick its source — because it is the same task: the sensor list shows what is bound and what is not, and the source list shows every observed topic with its live value and age. It is built for the case where nothing auto-matches, since a box's topic names may not resemble the sensor names at all — the live values are how you tell opaque channels apart, by watching which one moves when the machine moves. Sensors that already resolve by name are shown as `passt automatisch` rather than unassigned, so nobody rebinds what already works.

Overrides win so a stale shipped map can never override a human decision. `PUT` rejects a sensor name that does not exist for the active Verfahren — a typo there would otherwise drop that sensor's data at upload time with no error anywhere. Binding a sensor releases its previous topic, so two topics can never feed one sensor and interleave.

Overrides are keyed by the **full topic** the technician saw, so an override does not leak to a different prefix; shipped-map keys may be either a full topic or a bare last segment, and prefix-free keys survive a site changing its topic prefix.

**Why an unresolved topic matters.** It is still buffered and broadcast live, but stored with a null `sensor_id` — and `getSessionUploadGroups` filters those out. So the data appears on screen, the upload reports success, and nothing is ever sent. This resolution chain, and the assignment screen on top of it, exist to make that visible.

This is deliberately *not* in the sensor CSV: implenia-web and implenia-machine-backend never see MQTT topics, and it is unrelated to the CSV's `Alias` column, which carries a sensor's legacy name on the platform.

## Rohrverlängerung (Klemmbacke)

A drilling rig can only drill one Bohrrohr length at a time — 2 m or 3 m, depending on the site. When that length is used up, drilling is interrupted: the lower **Klemmbacke** closes and holds the pipe string in the ground, the Drehantrieb runs Linkslauf and unscrews itself from the pipe, travels back up the mast, the excavator lays a new Bohrrohr in position, Rechtslauf screws it into the old pipe and into the drive, the Klemmbacke opens, and drilling continues.

Everything the rig publishes during that window is real but is not drilling: Drehzahl, Drehmoment and Vorschub come from the drive unscrewing itself, and left in they corrupt every average. So the window is clipped.

`server/src/rohrwechsel.ts` is the pure state machine for that. It decides, from the Klemmbacke pressure, whether the rig is drilling or changing a pipe:

- **Closed** (≥ `closeThreshold`) → `phase = 'rohrwechsel'`, and every reading until the clamp opens is clipped.
- **Open** (< `openThreshold`) → back to `bohren`, and the pipe count goes up.

**Nothing is clipped until the clamp has been seen open at least once.** The thresholds are a guess until a rig proves them, and the only rig anybody has captured publishes its Klemmdruck between 1609 and 5558 — against the 100 / 50 defaults, *every* reading counts as closed. Without that arming condition the first message would latch the phase and never release it, and a whole shift would be held back from both the upload and the exported file. Instead nothing is clipped, and after five minutes of a clamp that has never read "open" the recording bar says so in German, stating explicitly that the recording is intact.

**Clipping only applies while drilling.** A closed Klemmbacke means a pipe change during Bohren, but during Verpressen it is simply holding the pipe string steady — on the G08 reference capture it is closed for **81% of the grouting phase**, against 43% while drilling. Clipping on the clamp alone would discard most of the grouting data, which is exactly the data Injektionsbohren exists to record. So the recording carries an operating mode, and the worker switches it on the recording bar, mirroring the screen switch they already make on the rig's own UI:

```
PUT /api/recording/mode   → { mode: 'bohren' | 'verpressen' }
```

It is persisted on the session, so a restart mid-element does not silently resume clipping a grouting phase.

Two thresholds with a dead band between them, because the clamp is hydraulic and a single threshold would flap on sensor noise — clipping half the drilling data. **The unit is whatever the box publishes:** some send bar, the G08 box sends a raw four-digit number, so neither the UI nor the error messages claim one. The config card shows the live value, and the thresholds are set by watching the clamp open and close once.

**The clamp is only read where pipes are handled.** Bohren reaches depth by adding 2 m or 3 m pipes and Auffüllen takes them back out the same way, so in those two a closed clamp means a pipe change. Austausch and Einbauen handle no pipes: their clamp rests *closed*, holding the string while the slurry is exchanged, so it says nothing about the drive and the state machine does not look at it. A mode change resets the phase and the per-pipe baseline, so switching back to Bohren starts clean and the next close clips again.

Getting that wrong was expensive and entirely invisible. With all four modes treated as pipe-handling, the captured rig's Klemmdruck during Austausch (min 1609, max 5256, mean 4250, against a close threshold of 4000) held the state machine in `rohrwechsel` for the whole phase: **3 848 of its 3 886 depth readings were clipped**, so the platform received a one-second sliver of a 0.86 m movement. The depth does change in those phases — the drill rises about a metre before Einbauen, pushed up by the denser slurry replacing the water — and that is a measurement, not an artefact of a pipe being swapped.

**Nothing is discarded.** Clipped readings are stored with `phase = 'rohrwechsel'` and `upload_status = 'clipped'` — a status the upload query and the export both skip, so implenia-web receives only drilling data, matching how clipping has always been done machine-side. Values are never rewritten; the phase records what a reading is *worth*, not what it says. Clipped rows do not block the reset guard, which would otherwise refuse forever on any rig that changes pipes; the reset screen reports them instead, because the reset deletes them.

**Clipping is reversible, but only through the API.** A threshold set slightly wrong clips readings that were drilling data after all, and those are otherwise unreachable — in no upload, in no exported file. `POST /api/recording/sessions/:id/unclip` moves them back to `pending`, and the phase stays on the row, so what was released is still visible afterwards. It stays available after the session has uploaded: the upload is the moment a wrong threshold becomes visible, and clipped rows are never deleted on upload — a reset is the only thing that discards them, and the reset screen counts them first.

**There is deliberately no worker-facing release control.** The recording bar carried one (tap-to-confirm, driven by a `clippedCount` on the recording state) and it was dropped along with that field, which cost a `getSessionStats` call on every WebSocket broadcast. The decision for this version is to **assume the Klemmbacke thresholds are commissioned carefully** — the Rohrverlängerung screen exists for exactly that, showing the live clamp value beside the thresholds — and to treat releasing already-clipped readings as a service action. The reset screen names the Rohrverlängerung screen rather than a control that no longer exists.

If a mis-set threshold does turn out to cost data in the field, the fix is **not** to bring the release button back: releasing is all-or-nothing and hands back genuine pipe-change readings along with the drilling data. The clamp pressure arrives on its own topic (`Bohrgeraet/Klemmdruck`), is not in any herstellen CSV, and is therefore stored per session as a row with `sensor_id = NULL` — kept, never uploaded, with its timestamp. A recorded session can thus be **re-evaluated** against corrected thresholds by replaying that stored series through the Rohrwechsel state machine and rewriting each row's phase. That is the real answer, and it is why the clamp readings are worth keeping.

```
GET  /api/recording/sessions/:id/readings?limit=500   → phase and upload status per reading, clipped ones included
POST /api/recording/sessions/:id/unclip               → release clipped readings back into the upload queue
```

### How the rig reports depth

Both kinds of machine are in the fleet, so `depthMode` is set per kiosk:

- **`absolut`** — the manufacturer publishes the depth of the hole, usually over CAN. It holds still while the string is clamped because the bit has not moved, so nothing has to be reconstructed and the reading is recorded as it arrives — give or take a manual *Tiefenkorrektur*, which applies on every rig.
- **`inkrementell`** — a rig Implenia retrofitted publishes the **Schlittenweg**, how far the Drehantrieb has travelled down the mast. It runs *backwards* by a pipe length at every change and then restarts from the top while the bit is still at the bottom of the hole, so a running offset is carried:

  ```
  tiefe = schlittenweg + offset
  ```

  The unit conversion is **not** done here — a retrofitted rig's sensor measures the feed mechanism rather than the hole (on G08 the carriage travels ~2,6 m per metre drilled), and that is the depth sensor's entry in *Sensor Calibration* above. One place converts units, not two.

  On close the depth is frozen at the hole bottom; on open the offset is rebuilt from where the carriage actually ended up, because the geometry is better evidence than a nominal length. An offset step of zero or less is refused outright rather than inventing a jump — pulling the string back out cycles the clamp identically. The corrected depth goes into `value_numeric` and the raw reading is kept in `value_raw`, which is what makes a wrong offset reconstructable afterwards instead of lost.

The setting matters, and the difference is visible in the G08 reference capture. Replaying the same recorded Rohrwechsel both ways (`server/src/replay-field-data.test.ts`):

| depthMode | worst backwards step | end vs. start |
|---|---:|---|
| `absolut` (wrong for this rig) | **−5,63 m** | ends shallower than it began |
| `inkrementell` (correct) | 0,00 m | +7,3 m, continuous |

A wrong choice announces itself within one pipe: the per-pipe check below sees a Rohrwechsel with no drilling in between and says so.

**Per-pipe check.** Depth readings (found by CSV `Rolle` = `depth`, not by name) are observed for one purpose: between two Rohrwechsel, about one `Rohrlänge` should have been drilled. A deviation beyond the tolerance is reported in German on the recording bar and logged — and a change with *no* drilling in between names the likely cause, a pressure threshold sitting inside the clamp's normal range. That is how a mis-set threshold announces itself instead of silently clipping drilling data. The first change of a session is not checked: there is no baseline, and recording may have started with pipes already in the ground.

The phase and pipe count are persisted to `recording_sessions.drill_state` on every phase change, so a restart mid-element does not record the rest of the pipe change as drilling data. `resumeRecording()` picks it back up on boot — see below.

### Surviving a restart

PM2 restarts the kiosk mid-element — on a crash, on a power cut, and when an update is installed. The session row stays open across that, so **the recording has to be re-attached on boot or it silently stops**: `insertBuffer()` and the WebSocket broadcast both run *before* the recording check in `onReading`, which means the bar keeps reading "Aufzeichnung läuft" and the live tiles keep ticking while `insertSessionReading` is never called. The worker sees a healthy screen and uploads an element missing everything after the restart.

`resumeRecording()` runs at boot, before the data source starts emitting, and re-attaches the open session:

- The sensor map is rebuilt from `recording_sessions.sensor_map`, **not** re-fetched from the Implenia API — the API is exactly what is unavailable on a site that has lost connectivity, and a resume that depended on it would fail where it is needed most.
- `startRecording()` restores the Rohrwechsel phase and pipe count from `drill_state`, so clipping survives the restart too.
- A damaged sensor map does not abort the resume. Readings are kept without a sensor id — not uploadable, but exportable and fixable — because recording nothing at all for the rest of the element is the worse outcome.
- The volume tracker's baselines are rebuilt from the readings the session already holds (`baselinesFromSession`). The displayed slurry volume is a delta against the first cumulative total seen in the element, and that baseline is memory only — without this it re-baselines on whatever the rig's totalizer reads at boot, so the number a worker judges the pillar by falls back to zero halfway up. Nothing recorded is wrong (the raw cumulative is what gets stored), which is why it took looking for.

**Why re-attach rather than stop the session and let the worker pick the element up again.** Stopping is not the cheap option it looks like: `endRecording` releases the auto-upload, which writes `Ausführungsdatum` and takes the element out of the unfinished list with half a hole drilled; the stop also commits a geology profile, and a committed profile is complete and gapless, so one committed mid-element asserts a plan for ground nobody has reached. On top of that the gap would last until somebody noticed — the worker is at the rig, not at the kiosk — and readings in that window land in `mqtt_buffer` with no session, sensor id or phase, which is unrecoverable on site. It would not even be simpler: a fresh session cannot inherit the accumulated Schlittenweg offset or the pipe count, so the same state restore is needed either way.

**Last-known values reach a screen that has just loaded.** The WebSocket otherwise only pushes readings as they arrive, and the browser's map starts empty on every page load — so a reload, a reopened kiosk browser or a PM2 restart leaves every tile at 0 until the rig publishes again. On a rig standing still (a Rohrwechsel, a pause, a shift change) that is not a flicker: the depth and the slurry volume of a half-drilled pillar read zero for as long as the quiet lasts. Ingestion therefore keeps the last value emitted per topic, and the WebSocket connect handler sends it as a `snapshot` message that the UI merges by timestamp, so a live reading that arrived first is never overwritten. Two details matter: the values are the ones *emitted* — calibrated, carrying the Schlittenweg offset, and including the volume deltas that are computed for the display and never recorded — so replaying `mqtt_buffer` instead would put the carriage position on screen as if it were the depth; and after a restart the map is rebuilt from `session_readings`, the only store holding the corrected value.

**The browser follows the server.** On the first live state carrying an active session, the UI navigates to that element if the hash is still empty — the boot case — and marks the jump as done so a worker who walks back to the list is never dragged forward again. No phase handling is needed: `element/<name>` renders the drilling or the Austausch/Einbauen/Auffüllen screen from `operatingMode`, which is restored from the session and arrives in the same message. The recording bar names the element on every screen (where the elapsed time used to be, since the header names it on the element screen alone), and the element list hoists the recording element to the first tile with an "Aufzeichnung läuft" badge — six tiles fit with no scrollbar, so otherwise the pillar being drilled can sit off-screen.

Only the seconds the process is actually down are lost, and that gap is unavoidable. `POST /api/update` therefore **refuses while a recording is active** (409, naming the element), and the update banner says the install waits until the recording is finished rather than offering a button that punches a hole into the running element.

**Off until configured.** Handling is enabled only once a Klemmbacke topic is set; a rig without that signal behaves exactly as before — nothing clipped, everything uploaded. The topic is matched on its full name or its last segment, so `Bohrgeraet/Klemmdruck` (MQTT) and `device/1/Klemmdruck` (serial) share one setting. The screen prefills `Bohrgeraet/Klemmdruck`, which is what the G08 capture shows — a starting point, not a convention: topic names differ per box and have to be wired on site.

Switching the feature **off** is never refused. The screen submits every field alongside the off switch, and with no clamp topic none of those numbers do anything — so a field left in a bad state falls back to what is stored rather than blocking the one action that makes a misbehaving feature stop.

```
GET /api/config/rohrwechsel        → { clampTopic, enabled, depthMode, pipeLength, closeThreshold, openThreshold, tolerance }
PUT /api/config/rohrwechsel        → same fields; takes effect on the running session
GET /api/config/rohrwechsel/live   → ?topic=… → { topic, raw, ageMs } — the clamp value, or nulls on a miss
```

The **Rohrverlängerung** card on the config page shows the live Klemmbacke value next to the thresholds, so they can be set by watching the clamp open and close rather than by guessing.

That value comes from `/api/config/rohrwechsel/live`, which matches the topic with the same `isClampTopic()` the ingestion path uses. The topic travels as a query parameter because the screen previews one that is still being typed, before it is saved. The matching deliberately does not happen in the browser: the screen used to carry its own copy of the rule, and a drift between the two would show a technician a value the recorder is not actually reading.

## Sensor Calibration

A reading does not always arrive in the unit the sensor is supposed to be in — a channel scaled for a different machine, a different transducer, or a depth sensor that sits on the feed mechanism rather than in the hole. That belongs fixed on the machine, but a rig cannot always be taken out of service, so every float sensor carries a linear correction:

```
wert = rohwert × faktor + versatz
```

Factor and offset default to their neutral elements — **1 and 0** — so a sensor nobody has touched behaves exactly as it always did. Calibration is keyed by **sensor name, not topic**: it is a property of what is being measured, so it survives a technician rebinding which topic feeds the sensor.

```
GET    /api/config/calibration                   → every float sensor, its factor/offset, and its live raw + corrected value
PUT    /api/config/calibration                   → { sensorName, scale, offset }
POST   /api/config/calibration/:sensorName/tare  → { scale? } — offset := -(live rohwert × faktor)
DELETE /api/config/calibration/:sensorName       → back to neutral
```

The **Kalibrierung** screen at `#/kalibrierung` (from the config page) shows one row per sensor with the raw value and the corrected value side by side, updating live — a factor gets set by comparing the kiosk against the display on the rig, not by arithmetic.

**Nullen** covers the most common correction in one tap: a pressure or load channel that idles at a non-zero value gets the offset that cancels it (`versatz = -(rohwert × faktor)`, so the *scaled* value goes to zero, not the raw one). The server reads the live value itself at the moment of the tap rather than taking the one the screen last polled, and answers with the offset it stored. The machine has to be at rest when it is tapped: whatever the sensor reads at that moment becomes the new zero.

It refuses — in German, with what to do about it — when nothing is arriving for that sensor, **and when the last value is more than ten seconds old**. The observation buffer keeps the last reading for minutes, so a broker that dropped out four minutes ago still shows a number; zeroing against it would write that stale value into every measurement from then on. The screen marks such a value as *Rohwert (alt)* and greys the button out rather than letting the technician tap into the refusal.

`value_numeric` stores the corrected value, so upload and export need no knowledge of the correction; `value_raw` keeps the reading as it arrived, so a wrong factor can be undone instead of having destroyed the measurement. The Klemmbacke pressure is deliberately **not** calibrated — its thresholds are set by watching what the clamp actually publishes, and a calibration meant for a sensor of the same name must not move them underneath the technician.

The Rohrwechsel per-pipe check reports the correction to make: if a rig consistently reports the wrong distance per pipe, the warning names the factor to multiply the existing one by.

## Depth Correction

The depth measuring wheel slips. Over a hole the published depth creeps away from the real one — not in steps, as a missed pipe change would, but gradually, and not necessarily at a constant rate, so a factor cannot be relied on to fix it either. The worker on the rig can tell what the depth really is from the Bohrrohre they have mounted, so the depth on the drilling screen is **tappable** — labelled `Tippen zum Korrigieren`, because a label naming the action reads as a hint that something is wrong rather than as a button: it opens a correction screen, and the hole carries on from the corrected value.

This is not the calibration above and must not be confused with it. Calibration is per sensor name, persisted, and applies to every element from then on — the right place for a wrong unit or a wrong zero, and the wrong place for drift inside one hole, which it would carry into the next pillar. A Tiefenkorrektur belongs to the element being recorded and goes away with it.

**Forward-only.** Readings already recorded keep the depth they were stored with. That follows from what slip is: the error at any moment is proportional to how far the wheel has turned, so an early reading is nearly right while one from just before the correction is off by nearly the whole delta — re-stating the session at a constant delta would make the early readings *worse*. The depth series therefore steps where a correction was applied, and `value_raw` keeps every uncorrected reading, so the original series stays reconstructable.

**The request carries a delta, not a target depth.** The rig keeps drilling while the screen is open, so the depth on it moves; the worker dials in a difference, the preview tracks the live value, and the server applies that difference whenever the request lands.

**Four pieces of drill state move together** (`applyDepthCorrection` in `rohrwechsel.ts`), and leaving any of them behind breaks it quietly:

| field | what goes wrong without it |
|---|---|
| `offset` | nothing is corrected at all |
| `holeDepth` | `accumulateDepth`'s `max` swallows a downward correction — and the next Rohrwechsel rebuilds the offset from exactly this field, so the correction silently undoes itself a pipe later |
| `lastDepth` | the screen and the next correction read a stale depth |
| `depthAtLastChange` | the next per-pipe check counts the correction as drilling progress and warns about a pipe that was fine |

Shifting all four leaves every comparison between them invariant, which is why the per-pipe check needs no knowledge of this. It works in both depth modes and **whether or not a Klemmbacke is configured** — a slipping wheel is not the retrofit's problem alone. `drill_state` is persisted by the correction itself rather than only at the next phase change, which may be a pipe away or may never come.

**Every correction writes a `Kommentar` reading** — `Tiefe korrigiert: 23,70 m → 21,40 m (-2,30 m; Korrektur auf diesem Element insgesamt -2,30 m)` — into the session, so the step in the depth series arrives on the platform with the reason attached. A session reading rather than a live API call, so it uploads with the element from a site with no connectivity. The running total is the slip diagnosis: a wheel that needed three metres on one hole wants a technician, not another correction.

```
POST /api/recording/depth-correction   → { delta }  (metres, signed)
                                       → { von, nach, delta, gesamt }
```

Refused with a German message a worker can act on: **400** for a delta that is not a number, larger than 50 m (a runaway guard — it says to split it in two), or one that would put the depth above the ground; **409** when no recording is running, or when no depth reading has arrived yet to correct.

### The control

Three step sizes, `± 1,00 m`, `± 0,10 m` and `± 0,01 m`, as six oversized buttons either side of the live value, with one `Übernehmen`. The centimetre is finer than anybody can judge from the pipes; it is there because it is the precision the depth is stored at, and the one step that lands on an exact value read off the rig. Three things about the control were decided rather than defaulted:

- **Steps, not a drag control.** The obvious touch control is a rubber band — pull away from the centre, the value runs faster the further you pull, let go and it snaps back. It integrates over *time*, so you steer a moving number by holding a finger still: overshoot is the normal outcome, there is no way to undo precisely, and it wants a pointer-capture and animation loop on a Celeron J1900 for something two buttons do exactly. Discrete steps keep what it was for — holding a button repeats and accelerates, the same tension expressed in time rather than distance — and a release always lands on a clean multiple of 10 cm.
- **The metre step does not repeat.** A held metre button reached eighteen metres in two seconds, which is not a correction anybody means. Slip is decimetres to a couple of metres over a hole, so three taps cover the coarse case and the smaller steps are for trimming, capped at one step per 120 ms — fast enough that two metres is a comfortable hold on `0,10`, slow enough that the number stays readable while it runs.
- **Not in Rohr units.** Pipe lengths are the worker's unit for a *missed pipe change*, which is a step error. Slip does not arrive in units of Bohrrohr, and offering it that way would invite a correction of the wrong size.

Full-screen, like the DIN catalogue and for the same reason: CLAUDE.md rules modals out, every exit is a 64px+ target, and nothing happens until `Übernehmen` is tapped. An accidental tap on the depth costs one tap on *Abbrechen* — or nothing at all, because with no touch for twenty seconds the screen gives the drilling profile back by itself. A recording that ends takes it with it, so a stop by voice or from a second tab cannot leave a worker on a screen whose only button can fail.

## Field Reference Data

A two-hour raw MQTT capture from a live Injektionsbohren rig (Bohrung G08, Marktbreit, 18.05.2026 — 275 935 messages) is the ground truth behind the Rohrverlängerung and calibration behaviour above: what the rig published, and — in two screenshots of the old LabView UI recorded during the same session — what the operator saw while it did.

**The capture itself is not in the repo.** At 15 MB it does not belong in a tree cloned on every CI run. It is kept beside the repo as `assets/bohrung_g8_marktbreit_mqtt.txt`, which is gitignored; ask for a copy if you need the full session. Everything *derived* from it is committed: `assets/reference/` holds the screenshots, the paired video/MQTT CSV, and a README documenting the topic inventory, the measured clamp thresholds, the session timeline, and — importantly — where the capture contradicts assumptions the kiosk was built on. Read it before changing anything that interprets rig data.

`server/src/mqtt-dump.ts` reads any capture in this format. `server/test-fixtures/` holds two small slices of this one, and `server/src/replay-field-data.test.ts` replays them through the real ingestion path and SQLite — so the tests run without the full capture. Every number that test asserts was measured from the capture rather than chosen, so it fails when the pipeline's interpretation of real data changes.

```bash
# topic inventory of a capture
awk '{c[$3]++} END{for(t in c) print c[t], t}' assets/<capture>.txt | sort -rn
```

## Element Completion

An element is marked as produced by writing its `Ausführungsdatum` string sensor (CSV role `is_completed`). The kiosk does this itself after every session upload that actually put readings on the platform, so a worker never has to confirm anything — an empty session, or one whose every reading was clipped as a Rohrwechsel, finishes nothing — and clears it (empty string) when an operator resumes an already-uploaded element from "Begonnene Elemente".

```
POST   /api/elements/:elementName/complete   → { ok, date } — manual completion
DELETE /api/elements/:elementName/complete   → { ok } — un-complete for rework
```

Two details are a contract with implenia-machine-backend and implenia-web, not kiosk-internal choices:

- **The reading is dated `2000-01-01T00:00:00Z`**, not "now". Sensor values upsert on `(sensor_id, date)`, so this sentinel makes completion one overwritable slot per element. Dated at "now", clearing would be impossible: readers ask whether *any* non-empty value exists, and yesterday's row would keep the element complete forever.
- **The value is a full ISO instant and doubles as a data-version stamp.** Every successful upload rewrites it, and implenia-web re-materializes an element's derived values (protocol totals, drilling stats, BIM status) whenever the stamp differs from the one it last computed from. A date-only value would be too coarse — an element uploaded twice in one shift would stamp the same value twice and the appended readings would never reach those numbers.

Clearing uses an empty string, never `null`: the batch endpoint types `string_sensors` as `map[string]string` and answers a null with a 422. `server/src/element-completion.ts` owns all of this; the full contract is in `CLAUDE.md`.

**Writes go by device id, never by element name.** `server/src/element-device.ts` resolves the name once via `GET /api/v1/measuring-device/self/child/name:<element>/resolve`, caches the id in memory, and retries a rejected write once if re-resolving yields a different id (an element device rebuilt in the platform). In memory and not in SQLite on purpose: every write by element happens online anyway, so a persisted id would only add a second source of truth that can go stale. The session sensor map is persisted for the opposite reason — the upload must survive restarts.

The platform does now accept a `name:<element>` reference as the `device_id` of `readings/batch`, but the kiosk keeps resolving: that support landed in the backend after this kiosk shipped, and kiosks self-update hourly while the backend deploys separately, so both versions run in the field at once. Before it landed, the batch endpoint handed the path segment to `ValidateDeviceAccess`, which looks it up as a primary key — so `name:F-23` answered `401 device access error: device not found: name:F-23`, which reads like an auth problem and isn't. Worth knowing when reading older logs.

## Phases

A pillar runs through four phases, always in the same order, with Austausch and Einbauen occasionally omitted:

```
Bohren  →  Austausch  →  Einbauen  →  Auffüllen
```

The header carries a stepper showing where the pillar is and offering the one step forward:

```
Bohren       [ Bohren ][ Austausch › ]
Austausch    [ ‹ Bohren ][ Austausch ][ Einbauen › ]
Einbauen     [ ‹ Austausch ][ Einbauen ][ Auffüllen › ]
Auffüllen    [ ‹ Einbauen ][ Auffüllen ]
```

The past phase stays tappable but subdued — an operator who stepped forward too early needs a way back, and the phase's name says where that goes in a way a bare `‹` would not. Three slots at most, at a fixed 424px so the element name beside it never shifts as phases advance; four worded segments would have come to ~617px of a 624px header centre, which works for `P-01` and breaks for a longer name.

**Skipping a phase means stepping through it**, and the cost of that is bounded rather than zero. All three post-drilling phases track depth identically (`isRetracting`), and `operating_mode` is a single overwritten column rather than a time series, so a moment spent in Austausch leaves no trace. They do differ in clipping — only Auffüllen handles pipes (`hasPipeHandling`) — so a pipe change spanning the two taps that pass through Austausch could leak a phantom reading or two. That is the better trade by a wide margin: clipping all three instead cost the entire Austausch depth series. `operating-mode.test.ts`, on both the server and the UI side, pins which phases handle pipes, and the two copies of the predicate have to agree — the UI's decides whether the recording bar shows the paused icon, and a bar claiming a pause while the server records normally is a lie to the operator.

Phase changes live only here. The post-drilling screen used to carry its own three-button sidebar for the same transitions, which put the control in one place and the indicator in another; the chart has that width now.

The phase is both navigation and a recording setting: it picks which screen renders, and it tells ingestion whether a closed Klemmbacke is a pipe change (clip those readings) or a pipe string being held (keep them).

The stepper carries one slot that is **not** a phase — see Ausrichten below.

## Ausrichten

An element whose **Vertikalneigung** is not 0 has to be aimed before drilling: the machine turned until its rotation matches the **Horizontalneigung** of the Schichtauftrag, and the mast set to the Vertikalneigung. The screen at `#/ausrichten/<element>` is those two dials and nothing else — the one thing the operator is doing at that moment.

**It is not a phase.** `operating_mode` is untouched, nothing is recorded differently, and nothing is gated on it: an element can be drilled without the screen ever being opened. It takes the slot *before* Bohren in the header stepper, which is both the way in and the way out:

```
no recording     [ ‹ Ausrichten ]
Bohren           [ ‹ Ausrichten ][ Bohren ][ Austausch › ]
on the screen    [ Ausrichten ][ Bohren › ]
```

The first row is the one that shapes the design. Aligning happens *before* the session starts, so there is no phase to show and the stepper is simply the way in — which is also why the alignment screen could not be a mode: it would have put a screen with nothing to record into the column that decides Klemmbacke clipping and every phase-segmented KPI.

The slot appears only where `Vertikalneigung ≠ 0` — a plumb hole has no direction to aim — **and only on a Verfahren that actually declares the two live angle sensors**. Both halves are needed because they live in different CSVs and do not move together: `ankerbohren-sensors.csv` carries the Vorgaben while `ankerbohren-sensors-herstellen.csv` has no `inclination_x`/`inclination_y` row, so keying the slot off the Vorgabe alone offered `‹ Ausrichten` on every tilted Ankerbohren element, behind which the screen could only ever say the feature is unavailable — an invitation to a dead end.

**Except on the screen itself**, where the slot is offered whatever the Vorgabe says. Without that exception an alignment URL opened for a plumb element (a typed address, a stale bookmark, a reload while the Vorgabe is still loading) is a screen with no exit at all.

### The two dials

**Horizontalneigung** is a full circle, 0° at the top, clockwise. The ticks stay neutral and a pointer marks the Ist, because a filled arc from the minimum is meaningless on a compass. The Soll sits on the rim as a green triangle on its tolerance arc — "aligned" is a width on screen rather than a number to compare against — with the Ist pointer one ring further out, so the two marks are neighbours. Between them runs the **Abweichungskeil**: an arc from Ist to Soll, always the short way round, with an arrowhead at the Soll end. That is what makes the dial an instruction rather than an instrument. The short way matters: a Soll of 2° at an Ist of 358° is 4° to the right, not 356° to the left.

**Vertikalneigung** is a quarter circle, 0° straight down, 90° horizontal, and its needle **is the mast** — it hangs from a pivot on a hatched ground line and leans the way the drill has to lean, with the Soll as a second, dashed mast beside it. A 270° arc like the Bohren gauges would have been consistent and meant nothing: three quarters of the scale on angles no mast can reach. The readout sits in the bottom-right, the one corner a quarter dial always leaves free.

Both carry the deviation **in words** underneath — `5,3° nach rechts`, `2,9° stärker neigen`, `Ausgerichtet` — because colour cannot say which way to turn, and that is the whole instruction. Both dials fill whatever box they are given rather than taking a pixel size: the content area is 612px with the recording bar and more without it.

Degraded states are named, never blank: `Kein Signal` where nothing has arrived, `Letzter Wert vor 23 s` where it stopped (10s window, as on the Kalibrierung screen) with the pointer kept at its last position in grey, and `Keine Vorgabe` where the Schichtauftrag carries no angle. A sensor with no topic gets a hint row with a button straight to the Sensorzuordnung; a sensor list that failed to load gets one with `Erneut laden`, and retries by itself every 10s — nobody on a site reloads a browser.

Three distinctions in there are load-bearing, because each collapse states a worker then has to act on:

- **No Vorgabe draws no target.** With no `Horizontalneigung` the rim carries no green mark at all and the pointer is drawn tone-free. A Soll folded to a stand-in `0°` would have put a green target on a direction nobody specified — on the dial the operator turns the machine to — while the chip above it read `Keine Vorgabe`.
- **The Soll is never clamped into the scale.** A Vorgabe outside `0…90°` gets a chevron at the end of the scale pointing past it, not a mark pinned onto the last degree the dial can draw. Pinning it put the dashed Soll mast exactly under the real one for a Vorgabe of `-8°` at a live `0°`: the picture said aligned while the words said `8,0° steiler stellen`. Clamping the *Ist* is fine — the number below it tells the truth.
- **"Still loading" is not "this Verfahren has no angle sensors."** The sensor list reports its load state rather than answering `null` for "not fetched yet", "non-2xx" and "network error" alike, which made the screen announce *"Für dieses Verfahren sind keine Winkelsensoren definiert"* on the first paint of every visit — and permanently after one transient 500, telling a worker a feature does not exist when it does.

### Which sensors it reads

By **role**, not by name: `inclination_x` is read as the rotation and `inclination_y` as the inclination — Injektionsbohren's `Richtung X` / `Richtung Y`, DSV's `Alpha` / `Beta`. Both are ordinary `mqtt` sensors of the Verfahren, so they already appear in the Sensorzuordnung and the Kalibrierung screens: nothing had to be added to either, and no CSV changed.

**Which axis is which is an assumption.** The CSVs say only `Richtung X` / `Richtung Y`, both `°`, both `secondary`, with nothing recording which axis is which. The screen therefore *names the sensor it is reading* under each title, so a swapped pair shows up in one glance instead of as a wrongly turned machine. Confirm it against a rig before this reaches a site.

The reference direction is the other open question: if the rig's 0° is not the Vorgabe's 0°, every reading is off by a constant — which is exactly what the **Kalibrierung** screen's per-sensor offset exists for. Nulling the compass against the surveyed direction is a one-tap correction there, and it needs no release.

### A topic wired on site now reaches the screen

Readings reach the browser keyed by their raw MQTT topic, and a screen found a sensor by matching the topic's **last segment** against the sensor name. A topic bound in the Sensorzuordnung — `plc/ch07` → `Richtung X`, which is the whole point of that screen — therefore resolved correctly for the recording and the upload and showed up **nowhere on screen**.

The `reading` and `snapshot` messages now carry the resolved sensor key alongside the topic (`resolveSensorKey`'s own answer, lowercased), set wherever ingestion fills `lastReadings`: the live path, the snapshot a reconnecting browser gets, and a resumed session's seeded values. `findSensorReading` in `ui/src/utils/sensors.ts` prefers it, then the last segment, then the whole topic. The same silent shape as a sensor name that fails to resolve — correct data, invisible.

**Both sides are normalised to lowercase**, which is what actually closes the hole for the Bohren and Verpressen screens. The server's answer is a recording sensor-map key and therefore lowercase, while every one of those screens looks up a CSV name in its original case — so keying the answer as it arrives left `plc/ch05` → `Drehzahl` resolving correctly for the upload and reading `0` on the centre gauge: a case-only miss on a name that otherwise matched exactly. `buildSensorValues` lowercases every key it stores and every read goes through `sensorValue()`, which lowercases the name it is given. A topic wired in a different case than the CSV resolves too.

### Tolerances and the scale

`±1,0°` horizontal, `±0,5°` vertical, a `0–90°` scale and a 5° "almost there" threshold, all in `ui/src/utils/ausrichtung.ts` and all **placeholders** until the expert says what the rigs can hold and how far they tilt (60° is the other candidate for the maximum).

They are judged in **degrees, never relative**. `statusColor()` in `sensor-viz.ts` works in percent, which is meaningless for an angle: a Soll of 0° would make every reading infinitely wrong, and 2° off a Soll of 180° would come out as 1% — green on a machine pointing two degrees into the neighbouring pillar.

Angles are shown with **one** decimal rather than the house two: 0,1° is the resolution these sensors have, and the second decimal is noise on a number that has to be read at a glance.

### Driving it without a rig

No dump carries these angles — a rotation is set before drilling starts and the field captures begin once it is under way — so the replay server publishes them on demand:

```bash
npm run replay      # broker on mqtt://localhost:1884, UI on http://localhost:3001
```

The **MASCHINE AUSRICHTEN** panel has a slider per angle, a noise slider (a perfectly constant value hides a dial that flickers at a threshold), both topic names and a start/stop button. The defaults — `Bohrgeraet/Richtung X` and `Bohrgeraet/Richtung Y` — resolve by name with nothing bound, provided the kiosk's subscription filter covers them (`#`, the wizard's default). `server/src/angle-simulator.ts` holds the state machine and its validation; the publishing loop runs at 500ms, like an Elvis frame.

## Geology Capture

The conductor records the geology they actually drilled through, and signs the profile off before it goes up. Uploaded as a `GeoDIN` integer series plus a `Geologie` text series — both already defined in the herstellen CSVs, both already read by implenia-web, so this needed no new sensor, no schema change and no backend work.

```
POST /api/recording/geology                 → { nr, name? } — record a layer at the current depth
POST /api/recording/geology/commit          → { geology?: [...] } — commit the reviewed profile, keep recording
GET  /api/recording/:id/geology-context     → planned profile, observed layers, whether it drilled, whether it is signed off
POST /api/recording/stop                    → { geology?: [{ tiefe, nr, name?, quelle }] }
PUT  /api/recording/mode                    → stepping out of `bohren` ends the drilling window
```

### During drilling

Two oversized buttons in the **recording bar**, and the choices appear where the profile column is — not on a screen of their own. **Schicht** offers only the soils this element's Schichtauftrag actually names (typically three to five, distinct types ordered shallowest-first); **Hindernis** offers the six obstruction kinds. The depth hero, gauges and recording bar all stay put, so nothing about the screen changes for the second it takes to pick.

Offering the plan's soils rather than the full vocabulary is the point: the operator is nearly always confirming a layer that was predicted, and 58 DIN types would be 58 ways to mis-tap. Unplanned ground is one more tap away behind **Andere…**, which opens the full catalogue (below). Tapping the bar button again closes the list, so it needs no cancel tile.

Two tiles can carry a marker, and they are different claims. **Aktuell** is the ground the drill is in — what the operator last recorded, or, until they have recorded anything, what the plan says is here; it is also the one that is highlighted. **Vorgabe** is what the Schichtauftrag plans at this depth. They sit on one tile in the ordinary case and read as two lines; when they come apart, that *is* the information — the operator is in ground the plan did not predict.

Marking the plan alone was wrong in exactly that case, and invisibly so: an operator who had recorded Mittelkies at 4,2 m came back after a restart to a picker highlighting Schluff, because that is what the Schichtauftrag expects there. Mittelkies was not even in the list. A recorded ground the plan never named is therefore appended to the tiles, so the active one always has somewhere to be marked (`spaltenKandidaten`). An obstruction is not: the drill being inside one is what the bar's **Hindernis Ende** says, and a Bodenart tile for it would record the code that is already current — no layer change at all.

The column holds five tiles plus Andere. That is measured, not derived from the 64px tap minimum: a tile carrying both markers needs 76px of text, and six tiles push every one of them back to the floor, where the second marker line is clipped mid-glyph and Andere slides behind the recording bar. (It stood at seven, which never fit — Andere was already half-hidden at that count.) A Vorgabe naming more distinct soils keeps the shallowest five and leaves the rest to Andere; an appended active ground takes one of those five places.

### The full catalogue, behind "Andere…"

One tab per DIN 4023 table — **Boden** 15, **Sonstige** 14, **Fels** 18, **Gemischt** 11 — four columns, 58 entries. Obstructions are excluded because they have their own picker, where the same tap would record the code that is already current and therefore no layer change at all.

It was a flat grid of 33 tiles in eight columns, which is 115px per tile and about 60px for the name: the labels read `Vulk…`, `Blätt…`, `(z. B. Basa…`, naming neither the type nor the example. A tab per table is what makes the whole name fit — no tab runs past five rows — and the bracketed examples go on their own line, one size down, because `Vulkanite (z. B. Basalt)` drawn as one string either wraps to four lines or gets cut mid-word.

Eight columns were also what kept 25 real ground types off the screen. The 14 non-petrographic ones were the costly omission — `Auffüllung`, `Mutterboden`, `Geschiebemergel`, `Löß`, `Hangschutt`, `Klei` are the most common *top* layers on a German site — and the gap was asymmetric: `vorgabeArten` already offers nr 34–47 in the quick column when a Schichtauftrag names one, but the full picker could not reproduce it, so **Andere…** was a one-way door away from a planned ground type.

A **search field** sits beside the tabs. `geologie-suche.ts` carries two normal forms per entry, because one does not work: stripping the diacritic from `Löß` gives `loss`, spelling it out gives `loess`, and neither needle occurs in the other — so `Löß`, `Loess` and `Loss` all find the same tile. An exact Kurzform ranks first, so `T` means `Ton` rather than the eleven names with a `t` in them, and a numeric query matches the `GeoDIN` code a protocol shows.

> **The field is dead on the kiosk.** `chromium --kiosk` has no on-screen keyboard and the app has none of its own (issue #49). It is additive, and only survivable because **the tabs reach every entry without typing** — that property has to hold until a keyboard lands.

An obstruction needs no thickness: tapping `Hindernis → Beton` starts a concrete layer at the current depth. While the drill is *inside* one, that button becomes **Hindernis Ende** and ending the obstruction is a **single tap with no pick at all** — the obstruction interrupted a layer the plan predicted, and `grundBei` says which, so the ground to resume is knowable. Where there is no plan to resume (nothing above the first planned layer, or no Vorgabe at all) it opens the soil picker instead. Either way the result is two ordinary layer changes, which is exactly what the uploaded series carries.

"Inside an obstruction" is seeded from the server's last recorded code, not just from browser state, so a PM2 restart mid-obstruction does not strand the operator without the one-tap way out.

### What the profile shows while drilling

The column draws what has actually been recorded — observed layers **solid**, the Schichtauftrag **dashed** below them — so an obstruction is visible from the moment it is entered and grows with the hole, rather than the only feedback being a message that fades after six seconds.

It is deliberately **not** the profile that would be committed. A committed profile is flat and gapless, so the last ground recorded has to run to the next planned boundary — meaning a Findling entered at 3.1 m commits as a 3.9 m block. Drawing that live would show metres of boulder the drill has not reached. So on screen the layer the drill is *in* stops at the current depth and the plan resumes below it; tapping `Hindernis Ende` then records a real boundary where the display already had one. The sign-off screen before upload is where the committed shape is shown.

The observed layers come from the server (`geology-context`), re-read after each entry rather than tallied in the browser — the server decides which depth reading an entry landed on, so only it knows where the layer starts, and a restart loses nothing.

**The hole can be deeper than the plan.** The Vorgabe geology comes from a probe drilling, and that probe does not always reach as far: one element's planned profile ends at 36 m while the hole goes to 44. Everything the chart draws is clipped to its `endTiefe`, the depth indicator included — so for the last eight metres the column stopped saying where the drill was, which is the one thing it is on the screen for. The drawn profile's bottom is therefore pulled down to the drill (`bisZurBohrung`), and because a profile is gapless that extends the last planned layer with it: the deepest ground the probe found is carried down to the drill, which is the best claim anyone has about ground down there, where a profile that simply stops says nothing at all. It moves in whole metres — `modus="vollbild"` re-lays out every layer when `endTiefe` changes, and following the depth reading exactly would re-scale the chart several times a second on a Celeron. Display only: the committed profile already ends at the deepest reading (`mergeProfile`), so nothing about the upload changes.

They live in the bar rather than beside the profile for a space reason worth recording. The kiosk's chrome is a fixed budget at 1024x768, and in the left column the two buttons took 136px off a profile with 596px to work with. The bar is already 76px tall for its own controls, so 64px buttons cost **nothing** there — and geology entry is a recording action anyway, like Beenden.

Measured on the drilling screen: header 85px (64px logo plus the 68px phase stepper), recording bar 76px, leaving `main` 607px — of which the geology profile gets ~519px, against ~372px when the buttons sat in the column.

**The reminder is the control.** Operators routinely forget to record a layer change at all, and the usual answer — a hint or a prompt when the Vorgabe says a boundary is due — becomes an annoyance that gets ignored. Instead, when the live depth comes within 30 cm of a planned boundary (either side), the Schicht button itself pre-loads the expected answer and relabels to `U Schluff?`, and that boundary is marked in the profile beside it. One tap confirms the planned change. Ignoring it dismisses nothing, clears no state, and moves nothing on the screen. Once that ground type has been recorded, the suggestion stops.

Voice covers the same thing hands-free, which is the strongest case for it in this app — hands are on the rig and the vocabulary is closed. Say `schluff`, `schicht schluff` or `hindernis beton`. The 15 soils and 6 obstructions are reachable by voice; the rock types are names a small offline model mishears often enough that a wrong layer would get recorded, so those stay touch-only.

Both the buttons and the voice commands are gated on `operatingMode === 'bohren'`, but that is the *browser's* view of the mode and a second tab does not share it — so the server refuses a live entry outright once drilling has ended, and says so. It has to: the newest depth reading is a retraction reading by then, outside the window every geology read is bounded by, so the entry would be written, answered with a depth, shown as recorded — and then appear in no profile at all. The way back is the phase stepper, into `Bohren`.

### The sign-off at the step out of Bohren

**The review happens when drilling ends, not when the recording does.** Stepping the phase stepper from `Bohren` to `Austausch` opens the sign-off, on a session that actually drilled (depth moved ≥ 0.5 m) and a machine whose Verfahren defines the sensors.

That is a deliberate move away from Beenden, and the reason is the operator's memory. A recording runs on through Austausch, Einbauen and Auffüllen — the stop may be an hour later, or the next day, by which time the hole is no longer fresh in anyone's mind. Nothing is lost by asking earlier, because **the profile is already final at that step**: nothing after it adds a drilling depth.

The data agrees, not just the UX. The operating mode never reaches a reading — `session_readings.phase` is only `bohren` or `rohrwechsel` — so a depth recorded while the rig retracts is stored as drilling data. The step out of `bohren` stamps `drilling_ended_at`, and every geology read is bounded by it, which fixes three quiet problems at once:

- `alignBoundaries` takes its tolerance from the largest step between consecutive readings, and retraction can only widen it. That tolerance is the **only** guard against `zuFlach` — the fabricated 10 cm layers a resumed element would otherwise produce
- a boundary whose descent reading was already taken by a shallower one could find the same depth again on the way up, hours later, and be dated there. web reads the series in date order, so that layer would land out of sequence
- `gebohrteTiefe` is `max − min`, and once the pipes are back out `min` falls toward zero, making the "did this session drill?" gate more permissive than it means to be

**The mode is switched before the screen opens.** The rig may start retracting the moment the operator taps, and a server that still thinks `bohren` reads the Klemmbacke as a pipe change and records the retraction as drilling data. The review may wait; the clipping behaviour may not.

**One button: `Weiter zum Austausch`.** It commits and goes on. There is no second exit standing open, because the review is not optional — the way back from a mis-tapped phase step is the phase stepper itself, which stays in the header on this screen for exactly that. A step back into `Bohren` clears both `drilling_ended_at` and the sign-off, so an operator who resumes drilling is asked again about the deeper hole.

`Zurück zur Aufzeichnung` does appear there, but only **once a commit has actually failed**. It has to: the phase stepper is itself a request (`PUT /api/recording/mode`, which does nothing on a non-200), so with the local server unreachable the commit fails, the stepper fails, and the only remaining way off the screen is the unlabelled logo — the dead end this software does not get to have. Appearing on the first failure means there is nothing to skip past before trying, and always a way out afterwards.

**Which button it is comes from `?beenden=1` in the route, not from the operating mode.** The mode answers "which phase is the rig in", not "what did the operator ask for", and the two come apart in both directions. A Beenden on a session already past `Bohren` — its phase-step sign-off skipped because the context fetch failed, or left without committing — was answered by a button that committed and returned while the recording kept running, so the operator had to tap Beenden twice and the second button named a phase they were already in. Worse, `operatingMode` is null until the first `recording-state` message arrives, so a reload on this screen briefly showed the **stop** variant: one tap in that window ended a recording mid-Austausch, with Einbauen and Auffüllen never recorded and the upload released early. A URL survives a reload and a PM2 restart; WebSocket state does not.

**Beenden is the backstop**, for a session that never left `Bohren` — drilled and stopped, or aborted. There the screen's button is `Beenden`: it commits, stops, and the auto-upload proceeds as always, with `Zurück zur Aufzeichnung` for a mis-tap. Grouting-only sessions, machines without geology, and a session that never went down stop exactly as they always have — and if the check itself fails for any reason, the stop proceeds. Geology never stands between an operator and finishing an element.

`geology_confirmed_at` on the session is what keeps it to **once**: a profile already signed off is not rebuilt at the stop. Rebuilding would re-derive the back-fill from the Schichtauftrag, so a planned boundary the operator deleted on the sign-off screen would quietly come back.

That protection does not reach across a **re-ask**, though, and nothing yet does: a deletion is not recorded anywhere, so when a step back into `Bohren` clears the sign-off, the next step out rebuilds the profile and a planned boundary the operator deleted the first time comes back dashed. They have to delete it again. Within one sign-off the deletion holds, which is the common case; carrying it across one means persisting rejected boundaries.

It is a **review step, not a gate.** The server back-fills the profile on *every* stop that did not already sign one off, so a recording stopped by voice, from a second browser tab, or straight from the recording bar commits exactly what a reviewed one would. The screen exists to let the operator correct it, not to make it exist. That is also why the voice `aufzeichnung beenden` stops directly rather than opening the screen — a hands-free operator would have no spoken way off it.

**A re-commit keeps its provenance.** The commit is repeatable and now routinely repeated, which made a latent bug reachable: reading the committed `GeoDIN` series back marks every boundary as observed, including the ones the kiosk back-filled itself, so the profile keeps its shape and loses the ` (Vorgabe)` suffix that says which parts nobody saw. The suffix in the `Geologie` text is the only place that provenance survives a commit, so `observedOnly` joins the two series on `received_at` and drops the back-filled rows — **after** web's change detection, never before. Before it, an observation repeated either side of a back-filled boundary of another type becomes two consecutive identical codes, the second reads as "no change", and a real layer disappears.

The screen shows the profile the server is about to commit: the layers confirmed during production, with the stretches nobody confirmed filled in from the Schichtauftrag and drawn **dashed**, marked `Vorgabe`. Anything touched stops being marked `Vorgabe`.

**The chart is the index.** The operator taps a layer in the profile and edits it in the panel beside it:

- **Bodenart ändern** → the profile column becomes the quick picker, exactly as it does while drilling: this element's planned soils, the layer's current type marked `Aktuell`, the plan's answer at that depth marked `Vorgabe`, and `Andere…` for the rest. The panel keeps saying which layer and at what depth, which is why this replaced a full-screen picker — covering the screen threw away the one piece of context the operator needs, where in the hole the layer they just tapped sits
- **−1 m / −10 cm / +10 cm / +1 m** → move its upper boundary (the first layer starts at the top of the hole, so it has none). Coarse and fine, because without a drag a boundary that turned out five metres deeper would otherwise be fifty taps
- **Schicht entfernen** → remove it. Tap-to-confirm: the button turns solid red and reads `Wirklich entfernen?`, and a tap on anything else — including selecting another layer — disarms it. The last remaining layer cannot be removed

Before anything is selected the panel says so, and it says so again after a delete: this is an empty state, not a dismissible hint, because it is the only thing on screen that says the chart can be tapped at all.

**+ Schicht** and **+ Hindernis** arm an insert and the *next tap on the profile* sets its depth — which is the point, since a layer born where the operator pointed needs the steppers only for the last few centimetres. The column then becomes the ground-type picker straight away, so the whole insert is **arm, point, pick** — three taps with nothing optional in the middle. The layer is created by the pick, not by the depth tap, so abandoning the picker leaves no untyped layer behind.

**While an insert is armed the chart is not editable.** For that moment it is a depth input, and a press on it means one thing. Without this a press that slid a little — a gloved finger on a touchscreen — took hold of whatever it started on: it never placed the layer, because a press that travelled is not a tap, so the insert stayed armed and the panel went on saying `Tiefe antippen`; meanwhile the drag it *did* become moved an obstruction and marked a Vorgabe boundary as confirmed, with nothing on screen saying so. Taps keep working without `editierbar` — the package attaches the tap listener either way and documents the combination as the safer one on a touchscreen — so a deliberate tap places the layer and a slip now does nothing at all, leaving the insert visibly armed for a second try. Dragging is untouched whenever no insert is armed. The button relabels to `Abbrechen` while armed, so the control that armed it is also the way out. The tapped depth is kept inside the layer it landed in (`einfuegeTiefeBei`): a depth that already carries a boundary would re-type that layer instead of splitting it, and an obstruction needs room for both its edges. A tap into a layer too thin to take the insert says so rather than doing nothing.

**Which layer the tap was in comes from the chart, never re-derived.** `BohrprofilLog` reports `index` from the raw depth under the finger but `tiefe` snapped onto the 10 cm grid, and within half a step of a boundary the two name neighbouring layers. `einfuegeTiefeBei` used to re-derive the index from the snapped depth, so a tap just above a boundary was read as landing below it: the insert clamped into the layer underneath and the new layer appeared at a depth nobody pointed at. Which layer a new one splits is the whole content of the gesture — any future caller taking a depth from that chart has the same trap.

There was a row of controls per layer here before, in two columns. It does not survive a real profile: four controls is 192px of buttons, so a row cannot shrink below about 408px and two columns need 824px of a column that has 646px at 1024x768 — the second column was cut off, with no scrollbar to admit it, on the one screen whose job is correcting the profile. One panel pays for those controls once, and the chart holds twenty layers in the same column it holds four (`modus="vollbild"` floors every layer at 32px), so it is the one representation that structurally cannot lose one.

**Tap and drag share every target.** A tap selects, a drag moves what it grabbed — boundaries by their handles, obstructions by their side rails. They have to share, because there is nowhere else to put the tap: a boundary handle is centred on its boundary and 64px tall for gloves, so it claims 32px either side, and any layer under ~64px tall is drag target from edge to edge. In `vollbild` that is guaranteed for exactly the thin layers most in need of correction.

What makes sharing safe is that **a press takes hold of nothing until it has travelled the tap threshold** (`istZug` in the din4023 package). Inside it nothing moves, so a tap never shows an edit it is about to take back, and a boundary cannot be nudged by a press that was meant as a tap — the silent change that matters most on the screen that decides the committed profile. Once a drag has taken hold the release is a drag, whatever the finger did on the way back.

The panel is still the way to make a small, exact change: 10 cm steps where a drag would be a guess, and 1 m steps for a boundary that turned out metres from where it was planned.

Selection is held by layer **id**, not index, because every edit reshuffles indices: an insert shifts everything below it, a delete closes a gap, and two adjacent layers of one ground type merge into the shallower one. An index kept across an edit would leave the panel editing a different layer than the one that is ringed.

Boundaries can also be dragged directly in the chart with 64 px touch handles, and obstructions drag freely through the profile.

A restart on this screen leaves the session open, `resumeRecording` re-attaches it, and the operator taps the button again — no dead end, nothing lost.

### Why the profile is always complete

A profile is flat and gapless — each layer runs to the next — so a single ground-type code asserts the ground continues to the bottom of the hole. There is no way to record "sand from 2 m, and no claim below that": **partial geology is not representable.** Back-filling the unconfirmed stretches from the Vorgabe is therefore the only option that neither discards what the operator saw nor invents a boundary they rejected, and the `(Vorgabe)` suffix in the `Geologie` text is how a reader tells the two apart.

One exception is worth knowing: **an obstruction is never extended upward.** Guessing that soil seen at 2 m also fills the metre above it is mild and usually right; guessing the same about `Hindernis Beton` would claim the drill met concrete at the surface. Such a profile legitimately starts below zero, and the chart draws empty space above it — which is both true and visible.

### The alignment trap

implenia-web derives layers by change detection over `GeoDIN`, taking each layer's depth from **the same reading** — matched by exact millisecond. A `GeoDIN` reading dated at "now", or at an interpolated instant, therefore produces **no layer at all**: it uploads cleanly, shows up as a raw series, and the protocol reports zero observed layers.

So every reading is dated at the exact `received_at` of a depth reading already in the database. Two consequences worth knowing:

- **Live entry sends no depth.** The route carries only a ground-type number and the server dates the reading at its own latest depth reading, then returns the depth it used so the screen can confirm `Schluff ab 3,40 m`. A browser-measured depth would have to be matched back to a reading, and being one sample out of step yields nothing.
- **A boundary below the bottom of the hole is dropped, not clamped.** Clamping would claim the drill saw ground it never reached, and several such boundaries would collapse onto one instant — costing real layers to report fictional ones. The stop response reports what was dropped.

`server/src/depth-timestamp.ts` owns the inversion as a pure, unit-tested module, and the confirmation screen reads the recorded series back through the same change detection implenia-web uses — so a misalignment shows up as a missing layer on the kiosk, in front of the operator, rather than weeks later in a protocol. The full contract is in `CLAUDE.md`.

## Session Data Export

A completed recording can be exported to Excel files for offline import into the implenia-web DSV widget — the offline counterpart to the batch upload (record → export to USB → import in the web app).

```
GET /api/recording/:id/export-options       → streams available for this session
GET /api/recording/:id/export?stream=hdi     → .xlsx download (attachment)
```

**Streams are not hardcoded.** Which sensors belong to which stream is driven by the `Stream` column of the shared `*-sensors-herstellen.csv` (synced from implenia-web, the source of truth). `getAvailableStreams()` returns the streams a machine's verfahren defines; `export-options` narrows that to streams with recorded data. Each stream exports as its **own file** — implenia-web's importer only reads the first worksheet and detects the stream from its header.

Two stream formats are produced, mirroring implenia-web's own export (`stream-csv.server.ts`) so files round-trip through its importer (bulk-insert path):

- **HDI** (machine telemetry, time-series): first column is a single ISO 8601 instant named **`Zeitpunkt`** (e.g. `2024-05-31T06:15:03.000Z`) — the DST-safe convention shared with implenia-web and implenia-machine-backend (see "CSV timestamp format" in `CLAUDE.md`). One column per HDI sensor; one row per grid interval (see "Data Reduction"); empty cells for gaps.
- **IVL** (inclination, indexed): first column is a sequential 0-based sample **`Index`**. The kiosk emits plain integers; implenia-web maps each index to its own sentinel timestamp on import, so the kiosk never touches the sentinel scheme.

Column headers match `dsv-sensors-herstellen.csv` sensor names exactly. In the UI, one export button per available stream appears in the recording bar next to **Daten hochladen** once a session ends.

`result`/Ergebnisdaten is not exported — those KPIs are computed server-side in implenia-web.

## Data Reduction

The rigs publish far faster than they measure, and both routes out of the kiosk paid for it. Over the 2 h 10 m G08 capture (`assets/bohrung_g8.txt`) the ten drilling channels arrive every ~290 ms and the four pump channels every ~3 s — **275 935 readings on 274 475 distinct milliseconds**, because every MQTT message is stamped with its own `Date.now()`. Laid out as one row per instant and one column per sensor, 92.8 % of the cells are empty.

Measured on that capture, with the current implementation:

| | rows | cells filled | size | build |
|---|---|---|---|---|
| **USB export, Voll** | 274 475 | 7.2 % | 12.4 MB | 28 s, 2.0 GB RSS |
| **USB export, 1 s** | 7 799 | 100 % | 0.58 MB | 0.8 s |
| **Upload, per sensor (JSON)** | — | — | 13.9 MB in 64 requests | — |
| **Upload, CSV @ 1 s** | 7 799 | — | **0.99 MB in 9 requests** | 0.2 s |

The ungridded export is the sharper problem: the stock kiosk has 4 GB of RAM and Node's default old-space ceiling sits near 2 GB, so a worker exporting a full shift to USB waits minutes or watches it fail. That is a blocked worker, which this software must never produce.

### Why a time grid, and why the last value

Between **58 % and 90 %** of readings per channel are *exact repeats* of the previous value: this is a high publish rate, not a high sampling rate, and a grid costs almost nothing. "Almost" is what the rules are for.

- **Last value in the interval, never a mean.** A mean invents numbers the rig never sent. `Klemmdruck` is bimodal at ~1650 open / ~4200 closed, and its 1 s mean lands in the physically impossible band between them in 35 intervals of that capture. `Tiefe` steps by a whole Bohrrohr during a Rohrverlängerung, and its 1 s mean sits up to **1.0 m** away from every sample in the interval. The volume channels are monotonic counters, where a mean is simply wrong. Taking the last value means every exported cell is a value the machine actually reported.
- **Each row is dated at a real reading's instant** — the newest one in the interval — not at the synthetic interval boundary.
- **Forward-fill is bounded** by `holdMsFor(bucketMs)` = four intervals, never under 4 s. The ~3 s pumps fill into every 1 s row (which is what takes the export from 81 % to 100 % filled); a dead sensor leaves the cell empty rather than frozen; a mode flag the operator set once is not stamped onto thousands of rows.
- **A recorded `null` is a gap**, reported in its own interval and never carried — so the value from before an outage cannot reappear after it.
- **An interval with no readings produces no row.** A quiet minute is absent from the file rather than filled with carried values.

`grid-reduce.ts` is pure and unit-tested; it is the single implementation behind both routes.

### Settings

`#/config/datenuebertragung`, reached from **Messwerte → Datenübertragung**. Per-kiosk and stored in `meta`, like the Rohrverlängerung and calibration settings — a release image is identical across sites, but how fast a given rig publishes is not.

```
GET  /api/config/datenuebertragung  → { exportBucketMs, uploadBucketMs, uploadMode,
                                        holdMs, rowsPerChunk, granularities, uploadModes }
POST /api/config/datenuebertragung  → same three fields; validated, German errors
```

| setting | default | choices |
|---|---|---|
| `exportBucketMs` | `1000` | Voll (0), 1 s, 2 s, 5 s, 10 s |
| `uploadBucketMs` | `1000` | the same, but not Voll on the CSV route |
| `uploadMode` | `csv` | `csv` (gesammelt) or `sensor` (einzeln je Sensor) |

**Nothing here deletes anything.** `session_readings` keeps every reading at full resolution whatever is configured; reduction happens on the way out, so a setting chosen wrong costs resolution on the platform and is undone by re-uploading or exporting the same session.

### The CSV upload

`uploadMode: 'csv'` posts the telemetry to `POST /api/v1/measuring-device/<device_id>/readings/batch/csv` — one `Zeitpunkt` per row instead of one per value — with the device id resolved from the element name by `element-device.ts`. Semicolon-separated, ISO 8601 with an explicit `Z`, column headers matching the platform's sensor names. The platform upserts on `(sensor_id, date)`, so a re-sent chunk is a no-op.

**Chunked by rows** (`CHUNK_ROWS = 1000`, ~140 KB each). The endpoint takes 50 MB and the whole session would fit in one request, but one request is also one failure: a dropped link would cost the entire upload and leave the progress bar with nothing to report in between. Per chunk, the recording bar advances and a failure costs only that chunk's readings, which go to `failed` and are retried. Progress counts **Pakete** rather than Sensoren on this route (`UploadProgress.unit`).

**Not every sensor can go this way.** A CSV is one table, so a column gets a cell on every row of its chunk — and an empty cell *inserts a NULL*, which is this kiosk's own marker for a sensor outage. Three kinds of sensor therefore keep the per-sensor path, in the same upload:

- **String sensors** (`Kommentar`, `Geologie`, `logs`, `Ausführungsdatum`) — an empty cell there writes an empty *string*, and for `Ausführungsdatum` an empty string is the documented way to *un-complete* an element.
- **`GeoDIN`** (role `geology_nr`) — implenia-web turns it into layers by change detection, and `alignBoundaries` deliberately gives every boundary its own depth reading. Two boundaries 290 ms apart share a 1 s interval, and one row is one layer, so gridding this series would silently drop layers.
- **`Ausführungsdatum`** (role `is_completed`) — a single overwritable slot at a sentinel date, not session data at all.

### Pinning the geology anchors

A `GeoDIN` entry carries **no depth of its own**. `geology.ts` writes it at the exact `received_at` of a depth reading, and implenia-web recovers the layer's depth by pairing the two series on millisecond equality, dropping any row whose `Bohrtiefe` is null. The timestamp is the entire mechanism.

Keeping `GeoDIN` off the grid guards one end of that link. Gridding the depth series cuts the other: the boundary looks for a depth at 580 ms, the platform has one at 870 ms, and the layer is gone — uploaded cleanly, invisible. (The first version of this change had exactly that bug.)

The depth series is gridded anyway — leaving it out costs the largest single channel its reduction, 14× down to 6.2× — and the readings the boundaries point at are **pinned back in**: `pinAnchorReadings` selects exactly those readings and `runUpload` sends them as one extra per-sensor batch beside the chunks. Nothing is interpolated; the value at that instant is a reading that already exists. On G08 with 18 boundaries that is 18 readings, ~1 KB, and all 18 stay joinable.

That batch claims no reading ids (the chunk that gridded them owns those), still counts in `sensorsFailed` (a profile the platform cannot reassemble is the same loss as one that never uploaded), and is built from the session rather than the pending groups so a retry still finds the anchors after the chunks have been marked uploaded.

`sensorsFailed` counts across all three parts, so an element is only completed when nothing was left behind.

**Only the machine's own channels are gridded.** `GRIDDABLE_SOURCES` is `{mqtt, kiosk}`, read from the `source` the session pinned when recording began (falling back to the local sensor CSVs by name for older sessions). The reason is that a CSV cannot say "no value here": a column gets a cell on every row of its chunk and an empty cell *inserts a NULL*, the kiosk's own outage marker. For an `mqtt` channel publishing every ~290 ms that is honest — the channel really did go quiet. For a `user` sensor it is not, because those values are events: Injektionsbohren's `Status` is written four times in a shift, and gridding it uploaded 186 fabricated outages, which cost the Herstellprotokoll its drilling duration, its phase averages and every observed geology layer. `CLAUDE.md` has the full chain. `kiosk` is gridded because those are the volume integrations, derived from every pump reading — DSV declares thirteen.

**Two guards make name-addressing safe.** The CSV endpoint addresses sensors by the names in the header, which the rest of this kiosk deliberately does not do — the Schichtauftrag carries real platform ids precisely because names drift (see `CLAUDE.md`). So:

1. A sensor with no `name` in the session's `sensor_map` is never gridded. The map is keyed by the *lowercased* name and the real spelling is not recoverable from it, so such a sensor takes the id-addressed route instead of being written to a sensor that may not exist. Sessions recorded before names were persisted therefore upload exactly as they always did.
2. A `200` is not yet a success. The endpoint reports headers it could not match in `unknown_sensors` instead of failing, so `csvChunkProblem` treats any of *our* columns appearing there — and any shortfall in `rows_processed`, `failed_count` or `success` — as a failure.

**Falling back.** If the *first* chunk fails structurally — 404/405/415 (a backend deployed before the endpoint existed; kiosks self-update hourly while the backend deploys separately, so the field runs both versions at once), unmatched column names, or an element the platform does not know — the whole session switches to the per-sensor route. Only the first chunk: nothing has been written at that point, so the switch is clean. A 5xx, a timeout or a network error is *not* structural; those mean "not now", and falling back on them would put the whole session back on the mobile link this change exists to spare.

A **422 is classified by its body, not by its status**, because the endpoint answers a refusal with the same JSON result as a success (`success` is `failed_count == 0 && rows_processed > 0`). An unmatched header and a statement timeout on the platform's own inserts therefore share one status: an unmatched name of ours or `rows_processed == 0` is structural, `failed_count` is a "not now", and a 422 the kiosk cannot parse falls back. An **element that does not resolve** is structural too, and is the one case where the per-sensor route is strictly more capable — the CSV endpoint is addressed per element device, while the per-sensor route is addressed by sensor id and needs no device at all. A resolve request that *failed to answer* is an ordinary transport failure, not this.

## Building for Production

```bash
npm run build
```

Builds `server/dist/` (TypeScript → JS) and `ui/dist/` (Vite bundle). The server serves the built UI as static files.

## Production Deployment

### Debian industry PC (the field setup)

Two commands, documented end to end — BIOS settings, Debian installer answers,
on-site checklist and troubleshooting — in
**[docs/kiosk-provisioning.md](docs/kiosk-provisioning.md)**.

```bash
# office, once per release: Debian installer + payload on one stick
./scripts/make-provision-stick.sh --device /dev/sdX --latest \
  --token ghp_… --anydesk-password '<fleet password>'

# on the machine, after a bare Debian install (stick mounted at /media/prov)
/media/prov/provision-kiosk.sh --hostname kiosk-g08
```

`provision-kiosk.sh` installs the release into `/opt/kiosk`, wires PM2 and a
Chromium-under-Openbox session with autologin, and is idempotent — re-running it
repairs a machine without touching `kiosk.db`, `.env` or recorded data. Three
things it handles that are easy to miss when installing by hand:

- The release bundle carries no `.npmrc`, and `@coded-aesthetics/din4023` is a
  private GitHub Packages dependency, so dependencies need a token (or the
  offline archive from `--export-deps`)
- `npm install` runs inside `server/` with `--no-workspaces`: the bundle's root
  `package.json` declares `workspaces: ["server","ui"]` but ships no
  `ui/package.json`
- **No release contains the Vosk speech model** (gitignored, and CI never runs
  `download-vosk-model.sh`), so voice commands are silently off on a kiosk
  installed from a release until the model is provisioned. It lands in
  `ui/dist/` and survives self-updates, which untar over the tree

### Linux, by hand (development machines, other distributions)

```bash
./scripts/install-service.sh
```

With a desktop environment that honours `/etc/xdg/autostart`, the kiosk browser
can go there instead of the provisioned `~/.xinitrc` session:

```bash
sudo cp scripts/kiosk.desktop /etc/xdg/autostart/
```

### Windows

```bat
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start server\dist\index.js --name kiosk-server
pm2 save
```

Kiosk browser (add to registry Run key or Scheduled Task):
```
chrome.exe --kiosk --app=http://localhost:3000 --disable-infobars --noerrdialogs
```

## How Updates Work

1. The server checks GitHub Releases hourly (configurable via `UPDATE_CHECK_INTERVAL_MS`)
2. If a newer semver tag is found, it is recorded as pending and the UI shows a banner. **The poll only detects — it never installs.** Applying is a deliberate tap on "Installieren & neustarten" (`POST /api/update`), so a restart never arrives unannounced in the middle of a shift
3. The route refuses while an element is being recorded, because applying restarts the process
4. On apply, the `.tar.gz` asset is downloaded and its SHA256 verified against `checksum.sha256`
5. The archive is extracted to a staging directory
6. A health check runs against the new version
7. PM2 graceful reload is triggered; an open recording session is re-attached on boot
8. The UI service worker detects the new build

**USB updates**: the server also scans `USB_UPDATE_PATHS` for `.tar.gz` bundles. Upload manually via the config UI.

### Creating a Release

```bash
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions builds, packages, and publishes the release automatically. Never manually bump `package.json` versions — CI stamps them from the git tag.

The bundle contains `server/dist/`, `server/assets/`, `ui/dist/`, both `package.json` files and `.env.example`. `server/assets/` is not optional: the server reads the sensor CSVs and topic maps from disk at runtime (`__dirname/../assets/...`), so leaving them out ships a kiosk that resolves no topics and rejects every sensor name on the assignment screen — silently, because a missing topic map is a normal state.

## Project Structure

```
server/src/
  index.ts            — Entry point
  config.ts           — Zod-validated environment config
  logger.ts           — Pino logging setup + ring buffer
  data-source.ts      — DataSource interface
  mqtt.ts             — MQTT data source
  serial-source.ts    — Serial/Elvis data source
  simulator-source.ts — Simulated data source (dev mode)
  angle-simulator.ts  — Hand-driven Horizontal-/Vertikalneigung for the replay server
  replay-server.ts    — Standalone broker + dump playback + angle simulator (dev)
  elvis-parser.ts     — Elvis hex frame parser
  ingestion.ts        — Routes readings to storage/WS/recording, applies depth correction
  rohrwechsel.ts      — Pure Rohrverlängerung state machine (Klemmbacke phase + clipping)
  rohrwechsel-config.ts — Klemmbacke topic, Rohrlänge and thresholds (meta-backed)
  calibration.ts      — Per-sensor linear correction (scale + offset)
  db.ts               — SQLite schema, migrations, queries
  websocket.ts        — WS broadcast
  implenia-api.ts     — Implenia API auth + fetch wrapper
  recording.ts        — Session recording + batch upload
  geology.ts          — GeoDIN/Geologie writes, provenance, idempotent re-commit
  geology-profile.ts  — Observations + Vorgabe → the profile the sign-off commits
  depth-timestamp.ts  — Boundary depth → exact depth-reading timestamp (pure)
  vorgabe-geology.ts  — Planned profile from "Geologie n" / "Tiefe Geologie n"
  element-completion.ts — Ausführungsdatum writes (sentinel date + data-version stamp)
  element-device.ts     — Element name → platform device id (resolve + cache)
  herstellen-sensors.ts — Element sensor defs: fetch, filter, offline cache
  session-export.ts   — Stream-driven .xlsx export (HDI/IVL) for implenia-web import
  grid-reduce.ts      — Readings → one row per interval, last value per sensor (pure)
  csv-upload.ts       — Session → chunked CSV for the measuring-device batch endpoint
  reduction-config.ts — Per-kiosk export/upload granularity and upload route
  connectivity.ts     — Online/offline watchdog
  updater.ts          — Self-update from GitHub Releases
  device-manager.ts   — Device lifecycle management
  routes/
    config.ts         — /api/config (API key, URL, validation)
    config-reduction.ts — /api/config/datenuebertragung (granularity + upload route)
    data.ts           — /api/readings, /api/stats
    devices.ts        — /api/config/devices + mappings
    verfahren.ts      — /api/verfahren (sensor definitions)
    recording.ts      — /api/recording (sessions)
    implenia.ts       — /api/shift-assignment proxy
    logs.ts           — /api/logs (remote log access)
    status.ts         — /health endpoint

ui/src/
  App.tsx             — Root component + routing
  hooks/
    useWebSocket.ts   — WS connection + reconnect
    useImplenia.ts    — Config + shift assignment state
  components/
    SensorDisplay.tsx  — Live reading tiles
    ElementDetail.tsx  — Per-element sensor detail view
    ConfigPage.tsx     — Settings page shell
    DeviceConfig.tsx   — Device management + sensor mapping
    ChannelPicker.tsx  — Serial channel → sensor assignment
    ShiftAssignment.tsx — Shift import + element tiles
    RecordingBar.tsx   — Session recording controls, geology entry, Rohrwechsel indicator
    PhaseStepper.tsx   — Bohren → Austausch → Einbauen → Auffüllen, in the header,
                         plus the Ausrichten slot before Bohren
    AusrichtenScreen.tsx — Aiming the rig: rotation and mast inclination vs. Vorgabe
    RotationDial.tsx   — Full-circle rotation dial with the Abweichungskeil
    NeigungDial.tsx    — Quarter-circle inclination dial whose needle is the mast
    GeologieBestaetigung.tsx — Geology sign-off at the step out of Bohren, and as a backstop at Beenden
    GeologiePicker.tsx — Full DIN 4023 catalogue behind "Andere": 4 tabs, 58
                         entries, search
    GeologieSpalte.tsx — Quick picker in the profile column: the plan's soils,
                         marked Aktuell (where the drill is) and Vorgabe
    RohrwechselSettings.tsx — Klemmbacke topic, Rohrlänge, thresholds
    CalibrationPage.tsx — Per-sensor factor and offset, with live values
    UpdateUpload.tsx   — Manual update upload
    StatusBar.tsx      — Connectivity indicator
    Header.tsx         — App header + navigation
```

## Testing

```bash
cd server && npm test    # Unit tests (vitest)
```

See `CLAUDE.md` for the full testing strategy.
