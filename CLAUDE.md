# Implenia Kiosk

Local-first kiosk app for construction sites. Collects sensor data via MQTT, displays live readings in a touch-optimised browser UI, buffers offline, uploads to Implenia REST API when online, self-updates from GitHub Releases.

## Stakeholders

**Construction site workers** — The primary users. They interact with the touchscreen while wearing gloves, often in bright or harsh conditions. The software must get out of the way. No learning curve, no unnecessary interactions, no surprises.

**Service personnel** — Set up industry PCs on site. They need minimal maintenance effort. The app should self-update, auto-recover from crashes (PM2), and require as little manual configuration as possible.

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

## Architecture

```
MQTT broker → server/src/mqtt.ts → SQLite (buffer) → server/src/upload.ts → Implenia API
                                  ↘ WebSocket → Browser UI (React)
```

- **Server**: Fastify, mqtt.js, better-sqlite3, TypeScript
- **UI**: React, Vite, vite-plugin-pwa
- **Process manager**: PM2
- **Updates**: GitHub Releases
