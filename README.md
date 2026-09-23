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
- **Software update** — manual `.tar.gz` upload for offline environments

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

**Clears:** Verfahren, transport, MQTT settings, devices, channel mappings, topic overrides, recorded sessions and readings, export records, the buffer, the imported shift assignment. The UI additionally clears the voice comment queue, which lives in `localStorage` and is therefore out of the server's reach — and, for the same reason, blocks the reset itself while comments are still unsent: the server's guard cannot see them, so a kiosk that was offline all shift would otherwise report "nothing unsaved" and discard a shift of dictation.

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

The operating mode reaches the state machine itself, not just the clipping decision at the end: during Verpressen the phase is still tracked — so clipping resumes correctly the moment the worker switches back — but no pipe is counted, no depth is frozen and no offset is rebuilt. Each of those would otherwise be *uploaded*, since nothing is clipped while grouting.

**Nothing is discarded.** Clipped readings are stored with `phase = 'rohrwechsel'` and `upload_status = 'clipped'` — a status the upload query and the export both skip, so implenia-web receives only drilling data, matching how clipping has always been done machine-side. Values are never rewritten; the phase records what a reading is *worth*, not what it says. Clipped rows do not block the reset guard, which would otherwise refuse forever on any rig that changes pipes; the reset screen reports them instead, because the reset deletes them.

**And clipping is reversible.** A threshold set slightly wrong clips readings that were drilling data after all, and those are otherwise unreachable — in no upload, in no exported file, and gone on the next reset. The recording bar offers to release them once the session has ended (tap to confirm), which moves them back to `pending`; the phase stays on the row, so what was released is still visible afterwards.

```
GET  /api/recording/sessions/:id/readings?limit=500   → phase and upload status per reading, clipped ones included
POST /api/recording/sessions/:id/unclip               → { released } — clipped readings back into the upload queue
```

### How the rig reports depth

Both kinds of machine are in the fleet, so `depthMode` is set per kiosk:

- **`absolut`** — the manufacturer publishes the depth of the hole, usually over CAN. It holds still while the string is clamped because the bit has not moved, so nothing is corrected and the reading is recorded as it arrives.
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

## Field Reference Data

A two-hour raw MQTT capture from a live Injektionsbohren rig (Bohrung G08, Marktbreit, 18.05.2026 — 275 935 messages) is the ground truth behind the Rohrverlängerung and calibration behaviour above: what the rig published, and — in two screenshots of the old LabView UI recorded during the same session — what the operator saw while it did.

**The capture itself is not in the repo.** At 15 MB it does not belong in a tree cloned on every CI run. It is kept beside the repo as `assets/bohrung_g8_marktbreit_mqtt.txt`, which is gitignored; ask for a copy if you need the full session. Everything *derived* from it is committed: `assets/reference/` holds the screenshots, the paired video/MQTT CSV, and a README documenting the topic inventory, the measured clamp thresholds, the session timeline, and — importantly — where the capture contradicts assumptions the kiosk was built on. Read it before changing anything that interprets rig data.

`server/src/mqtt-dump.ts` reads any capture in this format. `server/test-fixtures/` holds two small slices of this one, and `server/src/replay-field-data.test.ts` replays them through the real ingestion path and SQLite — so the tests run without the full capture. Every number that test asserts was measured from the capture rather than chosen, so it fails when the pipeline's interpretation of real data changes.

```bash
# topic inventory of a capture
awk '{c[$3]++} END{for(t in c) print c[t], t}' assets/<capture>.txt | sort -rn
```

## Session Data Export

A completed recording can be exported to Excel files for offline import into the implenia-web DSV widget — the offline counterpart to the batch upload (record → export to USB → import in the web app).

```
GET /api/recording/:id/export-options       → streams available for this session
GET /api/recording/:id/export?stream=hdi     → .xlsx download (attachment)
```

**Streams are not hardcoded.** Which sensors belong to which stream is driven by the `Stream` column of the shared `*-sensors-herstellen.csv` (synced from implenia-web, the source of truth). `getAvailableStreams()` returns the streams a machine's verfahren defines; `export-options` narrows that to streams with recorded data. Each stream exports as its **own file** — implenia-web's importer only reads the first worksheet and detects the stream from its header.

Two stream formats are produced, mirroring implenia-web's own export (`stream-csv.server.ts`) so files round-trip through its importer (bulk-insert path):

- **HDI** (machine telemetry, time-series): first column is a single ISO 8601 instant named **`Zeitpunkt`** (e.g. `2024-05-31T06:15:03.000Z`) — the DST-safe convention shared with implenia-web and implenia-machine-backend (see "CSV timestamp format" in `CLAUDE.md`). One column per HDI sensor; one row per distinct reading timestamp; empty cells for gaps.
- **IVL** (inclination, indexed): first column is a sequential 0-based sample **`Index`**. The kiosk emits plain integers; implenia-web maps each index to its own sentinel timestamp on import, so the kiosk never touches the sentinel scheme.

Column headers match `dsv-sensors-herstellen.csv` sensor names exactly. In the UI, one export button per available stream appears in the recording bar next to **Daten hochladen** once a session ends.

`result`/Ergebnisdaten is not exported — those KPIs are computed server-side in implenia-web.

## Building for Production

```bash
npm run build
```

Builds `server/dist/` (TypeScript → JS) and `ui/dist/` (Vite bundle). The server serves the built UI as static files.

## Production Deployment

### Linux (systemd + PM2)

```bash
./scripts/install-service.sh
```

### Kiosk Browser (Linux)

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
  elvis-parser.ts     — Elvis hex frame parser
  ingestion.ts        — Routes readings to storage/WS/recording, applies depth correction
  rohrwechsel.ts      — Pure Rohrverlängerung state machine (Klemmbacke phase + clipping)
  rohrwechsel-config.ts — Klemmbacke topic, Rohrlänge and thresholds (meta-backed)
  calibration.ts      — Per-sensor linear correction (scale + offset)
  db.ts               — SQLite schema, migrations, queries
  websocket.ts        — WS broadcast
  implenia-api.ts     — Implenia API auth + fetch wrapper
  recording.ts        — Session recording + batch upload
  session-export.ts   — Stream-driven .xlsx export (HDI/IVL) for implenia-web import
  connectivity.ts     — Online/offline watchdog
  updater.ts          — Self-update from GitHub Releases
  device-manager.ts   — Device lifecycle management
  routes/
    config.ts         — /api/config (API key, URL, validation)
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
    RecordingBar.tsx   — Session recording controls, Bohren/Verpressen switch, Rohrwechsel indicator
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
