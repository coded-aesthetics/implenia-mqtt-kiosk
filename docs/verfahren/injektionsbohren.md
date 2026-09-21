# Injektionsbohren

> Next field deployment. MQTT data source, one procedure, no channel mapping.

## The process

An *Injektionsbohrung* is a single borehole produced in **two phases within one
continuous session**:

1. **Bohren** — the drill advances to final depth. A flushing suspension is
   pumped through the drill string (`DurchflussB`) to carry cuttings out and
   stabilise the hole. `Bohrtiefe` increases; `IDrehmoment` / `ADrehmoment`
   (inner and outer rod torque) and `Vorschubgeschw.` react to the geology —
   this is what makes the depth profile a usable soil log.
2. **Verpressen** — the drill is withdrawn while grout is injected under
   pressure through the same string (`DurchflussV`). `Bohrtiefe` decreases back
   towards 0; `Suspensionsdruck` is the value that matters.

Both phases share one borehole, one element, one recording session. In the
reference protocol (`H26`): drilling 16:12–16:56 to 41.92 m, then injection
16:56–17:48 from 53.79 m back to 0 — note that the injection phase's start
depth can exceed the drilling end depth, because the rod string reaches deeper
than the measured drill depth.

Typical magnitudes from that protocol:

| | Bohren | Verpressen |
|---|---|---|
| Duration | ~45 min | ~51 min |
| Mean suspension pressure | 45.95 bar | 2.39 bar |
| Mean flow | 639.92 l/min | 25.96 l/min |
| Suspension volume | 28 583.4 l | 1 319.9 l |

Drilling consumes an order of magnitude more fluid at far higher pressure than
injection. Any UI that scales the two phases on one axis will make the
injection phase unreadable — the web protocol uses separate charts per phase.

## Data flow

```
Machine ──MQTT──► kiosk ingestion ──► SQLite session ──► batch upload ──► implenia-web
                       │                                                      │
                       └──► WebSocket ──► live tiles                          └──► computed values
                                                                                   + Herstellprotokoll
```

There is **no serial path and no channel mapping**. The MQTT topic's last
segment is the sensor name, matched case-insensitively against the sensor
definitions fetched from the API (`server/src/ingestion.ts`). The `Alias`
column is empty for every Injektionsbohren sensor, so topics must end in the
exact CSV names — including the trailing dot in `Vorschubgeschw.` and the
capitalisation of `DurchflussB` / `DurchflussV`.

## Sensors

Source: `server/assets/sensors/injektionsbohren-sensors-herstellen.csv`
(27 rows; synced from `implenia-web`).

### From the machine (`Quelle=mqtt`, 14 sensors)

| Name | Unit | Rolle | Prio | Notes |
|---|---|---|---|---|
| `Bohrtiefe` | m | `depth` | **hero** | Drives the geology depth indicator |
| `Suspensionsdruck` | bar | `pressure_suspension` | **hero** | The injection-phase control value |
| `Drehzahl` | 1/min | `rpm` | primary | |
| `Vorschubgeschw.` | cm/min | `rate` | primary | Negative while withdrawing |
| `IDrehmoment` | Nm | `torque` | primary | Inner rod — blue in the depth profile |
| `ADrehmoment` | Nm | `torque` | primary | Outer rod — red in the depth profile |
| `Druck Hammer` | bar | `pressure_rotation` | primary | |
| `Vorschubdruck` | bar | `pressure_feed` | primary | |
| `DurchflussB` | l/min | `flow_suspension` | primary | Flow during **Bohren** |
| `DurchflussV` | l/min | `flow_suspension` | primary | Flow during **Verpressen** |
| `Gear 1`, `Gear 2` | — | `gear` | secondary | |
| `Richtung X`, `Richtung Y` | ° | `inclination_x/y` | secondary | |

Two separate flow sensors rather than one flow plus a phase flag — the machine
already routes the measurement per phase. During Bohren, `DurchflussV` reads ~0
and vice versa (visible in the protocol's blue/purple traces).

### From the worker (`Quelle=user`, 4 sensors)

| Name | Typ | Rolle | Prio | Notes |
|---|---|---|---|---|
| `Status` | Integer | `mode` | **hero** | **0 = Bohren, 1 = Verpressen.** Everything downstream is phase-segmented by this |
| `Geologie` | Text | `geology_text` | — | Observed soil description |
| `Ausführungsdatum` | Text | `is_completed` | — | Marks the borehole done |
| `Kommentar` | Text | — | — | Already handled by the voice-comment queue |

### Derived by the kiosk (`Quelle=kiosk`, 2 sensors)

| Name | Unit | Notes |
|---|---|---|
| `Q_Bohren` | l | Cumulative suspension volume during Bohren |
| `Q_verpressen` | l | Cumulative grout volume during Verpressen |

Note the inconsistent casing (`Q_Bohren` vs `Q_verpressen`) — it is the
contract, do not "fix" it locally.

### Computed by the platform (`Quelle=server`, 7 sensors)

`GeoDIN` (geology layer number, `geology_nr`) plus the as-built coordinates
`Startpunkt X/Y/Z Ist` and `Fusspunkt X/Y/Z Ist`. The kiosk ignores these.

## The phase model is the crux

`Status` has `Quelle=user`. Unlike DSV, where `Bohren/Düsen` arrives over MQTT,
**nothing on the machine tells the system which phase it is in** — the worker
does, on the touchscreen.

Everything in implenia-web hangs off that one integer:

- `helpers/computed-values/profiles/injektionsbohren.ts` splits all readings
  into a `bohren` phase (`Status === 0`) and a `verpressen` phase
  (`Status === 1`), then derives every KPI in the protocol's table:
  time-integrated volumes (`q_bohren` / `q_verpressen`, gap-capped at 5 min so
  breaks don't inflate the integral), per-phase averages of `Suspensionsdruck`
  and flow, phase start/end timestamps, start/end depths, and durations.
- `models/injektionsbohren-protocol.server.ts` reconstructs phase intervals
  from the `Status` value *history*: each reading holds until the next one, and
  the last reading before the window start seeds the initial phase. So the
  kiosk only needs to record `Status` **on change**, not continuously — but it
  must record one at the very start of the session.
- `helpers/drilling-stats/profiles/injektionsbohren.ts` treats "any `Status`
  reading equals 1" as the proxy for *this borehole was produced*, and uses that
  timestamp as the execution date, because `Ausführungsdatum` is not populated
  by any kiosk workflow yet.

If the worker never sets `Status`, the borehole produces no protocol, no KPIs
and does not count as produced anywhere in the web app. **This is the single
most important thing the kiosk must get right for this Verfahren.**

### Design decision: the phase *is* the screen

`Status` is not a toggle sitting on a shared screen. The kiosk has **two
distinct UI states, one per phase**, each showing only the sensors that matter
in that phase:

- **Bohren** — `Bohrtiefe`, `IDrehmoment`, `ADrehmoment`, `Vorschubgeschw.`,
  `Drehzahl`, `Druck Hammer`, `Vorschubdruck`, `DurchflussB`
- **Verpressen** — `Suspensionsdruck`, `DurchflussV`, `Bohrtiefe`

The worker moves from Bohren to Verpressen once per borehole; writing
`Status` is a *side effect* of that move, not a separate thing to remember.
This also solves the readability problem: drilling runs at ~640 l/min and
~46 bar, injection at ~26 l/min and ~2.4 bar, so the two phases cannot share a
scale anyway (the web protocol likewise charts them separately).

V1 keeps the transition manual and one-way-ish — the worker switches when they
switch. Automatic phase detection (`DurchflussV` rising while `Bohrtiefe`
falls) is deliberately out of scope; if it ever lands it should *propose* the
switch for one-tap confirmation, never perform it.

## Geology

The worker is supposed to log the DIN 4023 layer (`GeoDIN`) when the soil
changes. In practice **they routinely forget** — and the failure mode is worse
than "no data".

### How implenia-web reads it

`herstellungLayersFromRows()` walks the Bohren-phase readings in time order and
emits a layer **at every `GeoDIN` change**, at that row's `Bohrtiefe`. The
protocol's Geologie toggle then defaults to whichever source has data:

```ts
const [mode, setMode] = useState<GeologyMode>(hasHerstellung ? "herstellung" : "vorgabe");
```

Two consequences:

- **No `GeoDIN` readings at all → web already falls back to Vorgabe.** The
  fallback the crew needs exists; the kiosk gets it for free by recording
  nothing.
- **One `GeoDIN` reading mid-borehole → the Vorgabe is discarded entirely.**
  `layersHerstellung` becomes a single layer starting at that depth, everything
  above it is unlabelled, and the toggle defaults to that. A worker who
  correctly notices one change at 20 m produces a *worse* protocol than one who
  does nothing. This is the crass-error case, and it is the one to design out.

### V1 behaviour: backfill on first correction

- The kiosk already draws the Vorgabe profile with a live depth indicator
  (`buildSchichten()` + `BohrprofilLog` in `ElementDetail.tsx`), reading
  `Geologie 1–10` / `Tiefe Geologie 1–10` from the vorgaben payload. That stays
  the default picture: **make no choice, and the Vorgabe stands.**
- If the worker logs a layer change, the kiosk records `GeoDIN` for that layer
  **and backfills the Vorgabe layers above the current depth** as `GeoDIN`
  readings, so `layersHerstellung` is a complete sequence rather than a stump.
- Net effect: do nothing → Vorgabe (web's own fallback). Intervene once → the
  Vorgabe with that one correction applied. Never a half-profile.

### V2: assisted detection

Derive a change-of-signature signal from `IDrehmoment` / `ADrehmoment` /
`Vorschubgeschw.` — the same traces the depth profile already plots visibly
react to layer changes — and *prompt* the worker at that depth. Suggestion
only, one tap to accept, never automatic. Explicitly out of scope for the
field deployment.

### Implementation hazard: `GeoDIN` must share a timestamp with `Bohrtiefe`

`loadAlignedPhaseRows()` buckets readings into rows keyed by **exact
millisecond**, and `herstellungLayersFromRows()` skips any row where either
`geoDin` or `bohrtiefe` is null. A `GeoDIN` reading whose timestamp does not
exactly match a recorded `Bohrtiefe` reading is **silently dropped** — empty
geology column, no error anywhere.

So when the kiosk emits a `GeoDIN` reading it must reuse the `receivedAt` of
the most recent `Bohrtiefe` reading rather than `Date.now()`. Also note
`GeoDIN` readings are filtered by the phase window, so they only count if
recorded *after* `Status` is first set and within the Bohren phase.

Relaxing that join in `implenia-web` (nearest row, or forward-fill the depth)
would be the more robust fix and is worth raising — but the kiosk should not
depend on it.

## What implenia-web builds from the upload

The `HERSTELLPROTOKOLL Injektionsbohren` (`injektionsbohren_herstellprotokoll`)
has four blocks:

1. **Header** — `Nr.` is the element/device name (e.g. `H26`); Bauvorhaben,
   Bauherr, Ort come from the construction site; Geräteführer from the shift
   assignment's personnel record. None of this is kiosk data.
2. **Tiefenprofil mit Geologie** — two depth-axis charts (Bohren left,
   Verpressen right) plotting `IDrehmoment`, `ADrehmoment` and
   `Vorschubgeschw.` against `Bohrtiefe`, with a DIN 4023 soil column between
   them. The column can be switched between **Herstelldaten** (from the
   worker's `GeoDIN` readings) and **Vorgabe** (the planned `Geologie 1–10` /
   `Tiefe Geologie 1–10` from the vorgaben device).
3. **Darstellung Bohr- und Verpressvorgang** — one time-axis chart with
   `DurchflussB`, `DurchflussV`, `Suspensionsdruck` and `Bohrtiefe`.
4. **Kennwert table** — the computed KPIs, Bohren vs Verpressen side by side.

So the minimum viable upload for a complete protocol is:
`Status`, `Bohrtiefe`, `Suspensionsdruck`, `DurchflussB`, `DurchflussV`,
`IDrehmoment`, `ADrehmoment`, `Vorschubgeschw.` — plus `GeoDIN` if the worker
logs geology, and `Kommentar` for remarks.

`Q_Bohren` / `Q_verpressen` are *not* read at their recorded timestamps: web
deliberately recomputes the integrals and writes them back at a sentinel date,
because the legacy client's cumulative values were wrong
(`helpers/drilling-stats/sentinel-read.ts`). Whatever the kiosk records there is
display-only.

## Kiosk gap analysis

What already works, unchanged, for Injektionsbohren:

- MQTT ingestion, SQLite buffering, WebSocket broadcast, session recording and
  per-sensor batch upload — all source-agnostic.
- The live view: tiles are sized by `Priorität`, the geology depth indicator
  finds its sensor via `Rolle === 'depth'`, units come from the API/CSV.
- Vorgaben display, DIN 4023 profile, voice comments, updater, watchdog.

What is missing:

1. **`ACTIVE_VERFAHREN` is hardcoded to `'dsv'`** (`server/src/sensor-meta.ts:12`).
   Every `Priorität` / `Rolle` / unit lookup resolves against the DSV CSV, so on
   an Injektionsbohren machine no tile would get a hero size and the depth
   indicator would fall back to its name heuristic. Needs to become a runtime
   setting (config UI + `meta` table), with `ChannelPicker.tsx:42`'s hardcoded
   `/api/verfahren/dsv/sensors` following along.
2. **No phase UI.** The live view has no concept of a phase: it renders every
   `mqtt`/`kiosk` sensor at once, sized by `Priorität`. Injektionsbohren needs
   the two screens described above, with the switch writing an Integer `Status`
   reading into the session (and once at session start). Best built as
   framework surface — phase sets keyed off `Rolle === 'mode'` — so Ankerbohren
   inherits it. Voice commands ("Bohren", "Verpressen") are an obvious fit.
3. **No UI control for `Ausführungsdatum` / `Geologie`.** `Quelle=user` sensors
   are currently invisible — `fetchHerstellenSensors()` keeps only `mqtt` and
   `kiosk` sources. Populating `Ausführungsdatum` would also let web drop its
   `Status == 1` proxy (the `TODO(post-PR-458)` in the drilling-stats profile).
4. **No derivation for `Q_Bohren` / `Q_verpressen`.** `Quelle=kiosk` sensors
   have no producer in this codebase at all. Given that web recomputes them
   anyway, the honest options are: compute them correctly here as a live display
   value (time-integral of the active phase's flow, same 5-minute gap cap as
   web), or drop them from the kiosk's scope and show nothing.
5. **Offline export produces nothing.** `session-export.ts` derives its columns
   from the CSV `Stream` column; the Injektionsbohren CSV has none, so
   `getSessionExportStreams()` returns an empty list and the worker has no way
   to get data off the kiosk without internet. This violates the "no internet →
   allow manual file upload" requirement. Either add `Stream=hdi` to the
   Injektionsbohren herstellen CSV in `implenia-web` (and confirm its stream
   importer accepts Injektionsbohren widgets), or give the exporter a fallback
   that exports all recorded sensors as one `Zeitpunkt` time-series sheet.
6. **No `GeoDIN` entry path.** The worker cannot record a layer change at the
   current depth. Lower priority than 1–3 — with nothing recorded, web falls
   back to the Vorgabe profile on its own, which is the accepted V1 default.
   When built, it must backfill and must reuse the depth reading's timestamp
   (see [Geology](#geology)).

### Known data-quality nits

- `Druck Hammer` has a leading space in its `Typ` column (`" Double"`) in the
  shared CSV, and `parseSensorCsv()` does not trim. Harmless today because
  nothing reads `Typ`, but it will bite whoever uses it to pick the upload
  endpoint. Fix belongs in `implenia-web`.
- `implenia-web` plans to rename `DurchflussB` / `DurchflussV` to
  `Durchfluss Bohren` / `Durchfluss Verpressen` after PR #458. That is a
  breaking change for MQTT topic names — coordinate before deploying.

## Open questions for the site

- Which MQTT topic prefix does the machine publish under, and does it publish
  every sensor at ~1 Hz or only on change?
- Is `Ausführungsdatum` expected from the kiosk on this project, or does the
  office set it?
- When the worker logs a layer change, which DIN codes should the picker
  offer? The full DIN 4023 catalogue is far too many targets for gloved taps —
  the layers already in this borehole's Vorgabe, plus the handful seen
  elsewhere on the site, is probably the whole realistic set.
- Does geology ever need logging during Verpressen? Web drives the profile
  from the Bohren phase and falls back to Verpressen only when Bohren is
  absent, so a correction logged during injection would not appear.
