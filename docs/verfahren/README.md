# Verfahren Knowledge Base

A *Verfahren* is a special-foundation construction method (DSV, Ankerbohren,
Grosspfahlbohren, Injektionsbohren, …). This kiosk is a **generic platform**:
the framework is identical for every Verfahren, and only the *use-case layer*
— which sensors exist, what the phases mean, how the protocol looks — varies.

This directory is the reference for that use-case layer. Start here, then read
the per-Verfahren page.

| Verfahren | Page | Kiosk status |
|---|---|---|
| Injektionsbohren | [injektionsbohren.md](injektionsbohren.md) | **Next field deployment** — MQTT, simplest workflow |
| DSV (Düsenstrahlverfahren) | — | Implemented; currently the hardcoded default |
| Ankerbohren | — | CSV only, no kiosk work yet |
| Grosspfahlbohren | — | Placeholder CSV (`Kommentar` only) |

---

## The shared contract

Every Verfahren is defined by a **pair of CSV files** that live in
`../implenia-web/app/assets/` — that repo is always the source of truth:

| File | Meaning |
|---|---|
| `<verfahren>-sensors.csv` | **Vorgaben** (specifications): the planned values per element, imported from BIM / the shift assignment |
| `<verfahren>-sensors-herstellen.csv` | **Herstellen** (production): the values recorded while the element is being built |

The herstellen CSV is copied into this repo at `server/assets/sensors/` so the
kiosk can serve it offline. Sync with `./scripts/sync-sensors.sh`
(`--check` for CI). **Never edit the copies here.**

### Herstellen CSV columns

| Column | Values | Used for |
|---|---|---|
| `Name` | exact sensor name | Joins everything: MQTT topic suffix, API sensor name, export column header |
| `Typ` | `Double` / `Integer` / `Text` | Which `sensor-{float,int,string}` API endpoint receives the readings |
| `Einheit` | e.g. `bar`, `l/min` | Unit shown next to the live value |
| `Quelle` | `mqtt` \| `kiosk` \| `user` \| `server` | **Who produces the value** — see below |
| `Rolle` | `depth`, `mode`, `torque`, … | Semantic tag; lets framework code find "the depth sensor" without hardcoding a name |
| `Priorität` | `hero` \| `primary` \| `secondary` | Tile size in the live view (`ElementDetail.tsx`) |
| `Alias` | e.g. `p_Anpress [bar]` | Legacy machine-side channel name (DSV only) |
| `Stream` | `hdi` \| `ivl` \| `result` | DSV-only legacy split; drives offline XLSX export |

### `Quelle` decides the whole data flow

- **`mqtt`** — the machine publishes it. Ingestion maps the MQTT topic's last
  segment (lowercased) to the sensor name, buffers to SQLite, broadcasts to the
  UI, and records it into the session. Zero configuration.
- **`kiosk`** — the kiosk itself must *derive* the value (e.g. integrating a
  flow rate into a volume) and record it like any other reading.
- **`user`** — a worker enters it on the touchscreen. Needs a UI control.
- **`server`** — implenia-web computes it after upload. The kiosk ignores it.

`fetchHerstellenSensors()` (`server/src/herstellen-sensors.ts`) only keeps
sensors whose source is `mqtt` or `kiosk` for the live view — so a `user`
sensor that has no UI control is silently invisible and never recorded.

---

## How the Verfahren differ

| Dimension | DSV | Injektionsbohren | Ankerbohren |
|---|---|---|---|
| Data source | Serial (Elvis ESP32) + MQTT | **MQTT only** | MQTT |
| Channel mapping needed | Yes (serial value index → sensor) | **No** (topic name *is* the sensor name) | No |
| Procedures per element | Vorschneiden / Bohren / Düsen | **One** (Bohren → Verpressen) | Bohren → Injizieren |
| Phase signal | `Bohren/Düsen` (Integer, `mqtt`) | `Status` (Integer, **`user`**) | `Reserve 5` (Text, `mqtt`) |
| Hero sensors | `Tiefe` | `Bohrtiefe`, `Suspensionsdruck`, `Status` | `Bohrtiefe`, `Reserve 5` |
| Geology on the kiosk | Vorgabe layers (DIN 4023) | Vorgabe layers **+ worker-recorded `GeoDIN`** | — |
| `Stream` column | `hdi` / `ivl` / `result` | **none** | none |
| Offline XLSX export | Works (per stream) | **Not wired up** — no streams defined | Not wired up |
| Protocols in web | Herstellprotokoll + Bohrlochverlaufsprotokoll | Herstellprotokoll | Herstellprotokoll + Injektionsprotokoll |
| Sensor count (herstellen) | 59 | 27 | 16 |

The recurring theme: **DSV is the complicated one.** It carries legacy baggage
(three data streams, serial channel mapping, aliases, three sub-procedures).
Injektionsbohren has none of that — which is exactly why it is the right next
field deployment.

---

## What is framework, what is use-case

Framework code must never branch on the Verfahren. It reads the CSV and acts on
`Quelle`, `Rolle` and `Priorität`:

- `ElementDetail.tsx` sizes tiles by `Priorität` and finds the depth indicator
  by `Rolle === 'depth'` — already generic.
- `session-export.ts` derives its columns from the `Stream` column — generic,
  but only produces output for Verfahren that *have* streams.
- `herstellen-sensors.ts` filters by `Quelle` — generic.

Use-case code that legitimately varies: phase semantics, derived calculations,
protocol layout, export column formulas.

### The one place the Verfahren is still hardcoded

```ts
// server/src/sensor-meta.ts
const ACTIVE_VERFAHREN = 'dsv';   // "Hardcoded until the setup wizard lets service personnel choose"
```

and in the UI:

```ts
// ui/src/components/ChannelPicker.tsx
fetch('/api/verfahren/dsv/sensors?source=mqtt')
```

Everything else already flows from the CSV. Making the active Verfahren a
runtime setting is the single highest-leverage change for supporting a second
machine type.

---

## Adding or activating a Verfahren

1. Add / update the CSV pair in `implenia-web/app/assets/`, then
   `./scripts/sync-sensors.sh` here.
2. Register it in `BIM_WIDGET_TYPES` (`implenia-web/app/helpers/bim-widget-types.ts`)
   and in `VERFAHREN` (`server/src/routes/verfahren.ts`).
3. Make sure every `Quelle=user` sensor has a UI control on the kiosk, and every
   `Quelle=kiosk` sensor has a derivation.
4. Decide the offline-export story (streams, or a generic fallback).
5. Write the per-Verfahren page in this directory.

## Cross-project conventions

- **Timestamps**: one ISO 8601 column named `Zeitpunkt`, local time *with*
  offset. Never the legacy `Datum` + `Uhrzeit` pair. See the root `CLAUDE.md`.
- **Sensor names are the join key** across kiosk, web and machine-backend.
  Renaming one is a three-repo change.
