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
- **Font sizes: 2rem+ for values, 1rem+ for labels** — Readable at arm's length
- **High contrast** — Light text on dark backgrounds, bold color-coded status (green/red)
- **No fine controls** — No small icons, sliders, or toggles. Everything oversized and obvious
- **No modals or multi-step flows** — Information is always visible, never hidden behind clicks
- **No scrolling** — All content must fit within the viewport. Scrollbars mean the layout is wrong. Workers glance at a screen, they don't scroll. Design layouts to fill available space (e.g. use flex with `min-height: 0`, `modus="vollbild"` for visualizations) rather than overflowing
- **Landscape-first** — Industry PCs are typically widescreen. Use CSS Grid for responsive tile layouts
- **Minimal text** — Use numbers, colors, and icons over paragraphs. Workers glance, they don't read
- **Language: German** — All UI-facing text must be in German. Code, comments, and documentation stay in English

## Development

```bash
npm run dev      # Server (tsx watch) + UI (Vite) concurrently
npm run build    # Build both server and UI
npm start        # Production: serves UI from server on PORT
```

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

**GitHub Packages auth**: The `@coded-aesthetics/din4023` package is hosted on GitHub Packages (private). CI uses `GITHUB_TOKEN` with `packages: read` permission. The `.npmrc` scopes `@coded-aesthetics` to `npm.pkg.github.com`.

## Architecture

```
DataSource (mqtt.ts | serial)  →  ingestion.ts  →  SQLite (mqtt_buffer + session_readings)
                                                 ↘  WebSocket → Browser UI (React)
                                  recording.ts   →  per-sensor batch upload → Implenia API
```

Data intake is abstracted behind a `DataSource` interface (`server/src/data-source.ts`). Each source (MQTT, serial, etc.) emits `SensorReading` events. The `DataIngestion` layer (`server/src/ingestion.ts`) routes readings to the SQLite buffer, WebSocket broadcast, and session recording — source-agnostic. To add a new data source, implement `DataSource` and wire it into `ingestion.ts`.

**Sensor schema**: The sensor definitions live as CSV files in `../implenia-web/app/assets/`. Each machine type (DSV, Ankerbohren, etc.) has a `*-sensors.csv` (vorgaben/specifications) and a `*-sensors-herstellen.csv` (production/live readings). The herstellen CSV defines sensor name, type, unit, source (`mqtt`/`kiosk`/`server`/`user`), role, priority, and MQTT alias. These files are the shared contract between `implenia-web` and this kiosk — any sensor name or format change must be reflected in both projects.

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

## Testing

This software auto-updates on machines where a broken deploy costs real time and money. Tests are a safety net, not a checkbox.

**Unit tests** (vitest, `server/src/*.test.ts`): Every pure-logic module gets unit tests — parsers, state machines, calculations, data transformations. If it has no side effects and takes input → output, it gets a test. Run with `cd server && npm test`.

**Integration tests**: Test the server-side pipeline with real SQLite (in-memory), real ingestion, real recording. Verify data flows end-to-end: source emits reading → ingestion routes → SQLite stores → recording captures → export produces correct format. Use the Elvis simulator to generate realistic frames.

**What to test**: Anything that could silently corrupt data or break offline operation. Sensor mapping resolution, recording start/stop lifecycle, upload retry logic, config persistence, file import parsing. Prefer testing behavior ("a recorded session exports with correct column names") over implementation ("function X is called with Y").

**What not to test**: React component rendering, CSS layout, trivial getters, framework glue code. Don't mock the database — use in-memory SQLite so tests verify real SQL.

**Smoke tests** (Playwright, minimal): Not a full E2E suite — just 2-3 tests that boot the app at 1024x768 and verify the shell renders, key elements are visible, and there are no JS console errors. These catch catastrophic failures (broken build, missing assets, layout completely off-screen) that unit/integration tests can't. Keep the count low and the assertions broad. If a smoke test breaks on every CSS change, it's too specific.

**Pre-update health check** (server-side): Before the auto-updater commits to a new version, the new server must boot and respond to `/health` with a passing status (DB accessible, config loadable, static assets present). If the health check fails, the updater keeps the previous version. No browser involved — this runs on the kiosk itself.

## Stack

- **Server**: Fastify, mqtt.js, better-sqlite3, TypeScript
- **UI**: React, Vite, vite-plugin-pwa
- **Process manager**: PM2
- **Updates**: GitHub Releases
