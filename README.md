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
| `MQTT_BROKER_URL` | Yes | — | MQTT broker URL (e.g. `mqtt://192.168.1.50:1883`) |
| `MQTT_TOPICS` | Yes | — | Comma-separated MQTT topics |
| `IMPLENIA_API_URL` | No | — | Implenia REST API base URL (also configurable in UI) |
| `IMPLENIA_API_KEY` | No | — | Bearer token for the API (also configurable in UI) |
| `GITHUB_OWNER` | Yes | — | GitHub org/user for update checks |
| `GITHUB_REPO` | Yes | — | GitHub repo name for update checks |
| `GITHUB_TOKEN` | No | — | Token for private repo access |
| `UPDATE_CHECK_INTERVAL_MS` | No | `3500000` | Update check interval (ms) |
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `production` | `development` / `production` / `test` |
| `CONNECTIVITY_PROBE_HOST` | No | `8.8.8.8` | DNS host for connectivity checks |
| `CONNECTIVITY_POLL_INTERVAL_MS` | No | `30000` | Connectivity poll interval (ms) |
| `USB_UPDATE_PATHS` | No | `/media` | Comma-separated dirs to scan for USB update bundles |
| `LOG_SENSOR_UPLOAD` | No | `false` | Upload log entries as string sensor readings |
| `LOG_SENSOR_LEVEL` | No | `warn` | Minimum level for sensor-uploaded logs |

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
