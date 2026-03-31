# Implenia Kiosk

Local-first, self-updating kiosk application for construction sites. Collects sensor data via MQTT, displays it in a touch-optimised browser UI, buffers data offline in SQLite, and uploads to the Implenia REST API when connectivity is available.

## Architecture

```
Machine (MQTT) → Local Server (SQLite buffer) → Browser Kiosk (React PWA)
                                               → Implenia API (when online)
                                               → GitHub Releases (self-update)
```

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- MQTT broker accessible on the local network
- (Production) PM2 for process management

## Development Setup

```bash
# 1. Clone and install
git clone <repo-url> && cd implenia-mqtt
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your MQTT broker, API credentials, etc.

# 3. Start dev servers (server + UI with HMR)
npm run dev
```

The UI dev server runs on `http://localhost:5173` and proxies API/WS requests to the server on port 3000.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MQTT_BROKER_URL` | Yes | — | MQTT broker URL (e.g. `mqtt://192.168.1.50:1883`) |
| `MQTT_TOPICS` | Yes | — | Comma-separated MQTT topics to subscribe |
| `IMPLENIA_API_URL` | Yes | — | Implenia REST API base URL |
| `IMPLENIA_API_KEY` | Yes | — | Bearer token for the API |
| `GITHUB_OWNER` | Yes | — | GitHub org/user for update checks |
| `GITHUB_REPO` | Yes | — | GitHub repo name for update checks |
| `GITHUB_TOKEN` | No | — | Token for private repo access |
| `UPDATE_CHECK_INTERVAL_MS` | No | `3600000` | Update check interval (ms) |
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `production` | `development` / `production` / `test` |
| `CONNECTIVITY_PROBE_HOST` | No | `8.8.8.8` | DNS host for connectivity checks |
| `CONNECTIVITY_POLL_INTERVAL_MS` | No | `30000` | Connectivity poll interval (ms) |

## Building for Production

```bash
npm run build
```

This builds both `server/dist/` (TypeScript → JS) and `ui/dist/` (Vite bundle). The server serves the built UI as static files.

## Production Deployment

### Linux (systemd + PM2)

```bash
# Run the installer
./scripts/install-service.sh

# This will:
# 1. Install PM2 globally (if needed)
# 2. Install production dependencies
# 3. Start the server under PM2
# 4. Configure PM2 to start on boot via systemd
```

### Kiosk Browser (Linux)

```bash
# Copy the autostart desktop file
sudo cp scripts/kiosk.desktop /etc/xdg/autostart/
```

Or for the current user only:
```bash
cp scripts/kiosk.desktop ~/.config/autostart/
```

### Windows

```bat
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start server\dist\index.js --name kiosk-server
pm2 save
```

For kiosk browser, add to registry `Run` key or create a Scheduled Task:
```
chrome.exe --kiosk --app=http://localhost:3000 --disable-infobars --noerrdialogs
```

## How Updates Work

1. The server checks GitHub Releases every hour (configurable).
2. If a newer version tag is found, it downloads the `.tar.gz` asset.
3. The SHA256 checksum is verified against `checksum.sha256`.
4. The archive is extracted to a staging directory (`app-next/`).
5. The server signals PM2 for a graceful reload (SIGUSR2).
6. The UI service worker detects the new build and shows an "Update available" banner.

### Creating a Release

Push a semver tag:

```bash
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions will build, package, and publish the release automatically.

## Project Structure

```
server/src/
  index.ts          — Entry point, wires everything together
  config.ts         — Zod-validated environment config
  mqtt.ts           — MQTT client, topic subscriptions
  db.ts             — SQLite schema, migrations, query helpers
  websocket.ts      — WS broadcasts (readings, connectivity, updates)
  upload.ts         — Retry queue → Implenia API
  updater.ts        — Self-update from GitHub Releases
  connectivity.ts   — Online/offline watchdog (DNS probe)
  routes/
    data.ts         — /api/readings, /api/stats
    status.ts       — /status health endpoint

ui/src/
  App.tsx           — Root component
  hooks/
    useWebSocket.ts — WS connection + reconnect
    useOnlineStatus.ts — Browser online/offline
  components/
    SensorDisplay.tsx  — Live reading tiles (touch-optimised)
    StatusBar.tsx      — Connectivity + queue indicator
    UpdateBanner.tsx   — Update prompt
    UploadQueue.tsx    — Pending/uploaded/failed counts
  service-worker.ts   — Workbox precache + runtime caching
```
# implenia-mqtt-kiosk
