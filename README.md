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
| `DB_PATH` | No | `<cwd>/kiosk.db` | SQLite database path. `:memory:` for an ephemeral DB (used by integration tests) |
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
GET  /api/config/reset   → { allowed, unsafe: { sessions, readings }, preserves }
POST /api/config/reset   → 409 while data is unsafe, otherwise wipes and clears caches
```

**Clears:** Verfahren, transport, MQTT settings, devices, channel mappings, topic overrides, recorded sessions and readings, the buffer, the imported shift assignment. The UI additionally clears the voice comment queue, which lives in `localStorage` and is therefore out of the server's reach.

**Keeps:** the API key and server address — the site's credentials, not this machine's setup, and re-entering a token on a touchscreen is miserable.

**Refuses — does not warn — while recorded data exists only on this kiosk.** "Safe" means uploaded *or* exported to a file: if only uploading counted, a kiosk with no connectivity could never be reset, which is the dead end the guard exists to prevent. An export only counts when the file actually contained readings; a Verfahren with no streams defined produces a header-only file, and treating that as saved would discard data nobody ever got off the machine.

Because the reset clears the in-memory caches (`clearVerfahrenCache`, `clearTransportCache`, `clearResolverCache`) and re-selects the data source, it needs no restart — unlike `scripts/reset-setup.sh`.

### Resetting the setup

```bash
./scripts/reset-setup.sh          # asks first
./scripts/reset-setup.sh --yes    # no prompt
DB_PATH=/path/to/kiosk.db ./scripts/reset-setup.sh
```

Clears the active Verfahren, the transport choice, the MQTT settings and the topic overrides, so the wizard runs again. **Keeps** recorded sessions and readings, serial devices and channel mappings, and the API key. Restart the server afterwards — the Verfahren and transport are cached in memory.

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
3. **The topic's last segment equals the sensor name** — the no-configuration case

```
GET    /api/config/topic-overrides          → expected sensors, what feeds each, and how it was bound
PUT    /api/config/topic-overrides          → { topic, sensorName }
DELETE /api/config/topic-overrides/:topic
```

Overrides win so a stale shipped map can never override a human decision. `PUT` rejects a sensor name that does not exist for the active Verfahren — a typo there would otherwise drop that sensor's data at upload time with no error anywhere. Binding a sensor releases its previous topic, so two topics can never feed one sensor and interleave.

Overrides are keyed by the **full topic** the technician saw, so an override does not leak to a different prefix; shipped-map keys may be either a full topic or a bare last segment, and prefix-free keys survive a site changing its topic prefix.

**Why an unresolved topic matters.** It is still buffered and broadcast live, but stored with a null `sensor_id` — and `getSessionUploadGroups` filters those out. So the data appears on screen, the upload reports success, and nothing is ever sent. This resolution chain, and the assignment screen on top of it, exist to make that visible.

This is deliberately *not* in the sensor CSV: implenia-web and implenia-machine-backend never see MQTT topics, and it is unrelated to the CSV's `Alias` column, which carries a sensor's legacy name on the platform.

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
2. If a newer semver tag is found, it downloads the `.tar.gz` asset
3. SHA256 checksum is verified against `checksum.sha256`
4. The archive is extracted to a staging directory
5. A health check runs against the new version
6. PM2 graceful reload is triggered
7. The UI service worker detects the new build

**USB updates**: the server also scans `USB_UPDATE_PATHS` for `.tar.gz` bundles. Upload manually via the config UI.

### Creating a Release

```bash
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions builds, packages, and publishes the release automatically. Never manually bump `package.json` versions — CI stamps them from the git tag.

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
  ingestion.ts        — Routes readings to storage/WS/recording
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
    RecordingBar.tsx   — Session recording controls
    UpdateUpload.tsx   — Manual update upload
    StatusBar.tsx      — Connectivity indicator
    Header.tsx         — App header + navigation
```

## Testing

```bash
cd server && npm test    # Unit tests (vitest)
```

See `CLAUDE.md` for the full testing strategy.
