# Topic maps

Maps an MQTT topic to a sensor name, per Verfahren, for boxes whose topic
names do not literally equal the sensor names in the herstellen CSV.

One file per Verfahren: `<verfahren>.json`, a flat object.

```json
{
  "Bohrtiefe_m": "Bohrtiefe",
  "flow_drill": "DurchflussB"
}
```

- **Key**: either the full topic (`sensors/machine1/flow_drill`) or just its
  last segment (`flow_drill`). The full topic is tried first, so a prefix-free
  key stays correct when the site changes its topic prefix.
- **Value**: the sensor name exactly as it appears in
  `assets/sensors/<verfahren>-sensors-herstellen.csv`.

This is a **kiosk-local ingestion concern**, deliberately not part of the
sensor CSV: implenia-web and implenia-machine-backend never see MQTT topics,
and a box's firmware renaming a topic should not require a change to a
contract shared across three repos.

Not to be confused with the CSV's `Alias` column, which carries a sensor's
legacy *name* on the platform and has nothing to do with transport.

## Precedence

1. Technician overrides stored in the DB (`topic_overrides`) — set on site
2. This file — shipped with the release
3. Topic segment equal to the sensor name — the no-configuration case

Overrides win so that a stale shipped map can never override a human decision.
A file may start empty (`{}`) when the topic names are not known yet.

## injektionsbohren

Taken from the G08 Marktbreit capture (`assets/reference/`), the only recording
of what one of these rigs actually publishes. It is a **starting point, not a
contract**: a technician's override always wins, and the assignment screen
shows what is bound and what is not.

Keys are **full topics on purpose**. The prefix carries meaning here, and two
topics share a last segment — `Spuelpumpe/Durchfluss` and
`Verpresspumpe/Durchfluss` — so prefix-free keys would collide and silently
bind both pumps to one sensor.

| Topic | Sensor | On what basis |
|---|---|---|
| `Bohrgeraet/Tiefe` | `Bohrtiefe` | name |
| `Bohrgeraet/Drehzahl` | `Drehzahl` | name |
| `Maschine/Druck_Hammer` | `Druck Hammer` | name |
| `Maschine/Druck_Vorschub` | `Vorschubdruck` | name |
| `Spuelpumpe/Durchfluss` | `DurchflussB` | the flush pump runs while drilling |
| `Verpresspumpe/Durchfluss` | `DurchflussV` | the grout pump runs while injecting |
| `Bohrgeraet/Ziehgeschwindigkeit` | `Vorschubgeschw.` | measured: it tracks the carriage rate at 60× m/s, i.e. m/min, and is the only rate signal against the only rate sensor |
| `Maschine/Druck_Medium` | `Suspensionsdruck` | elimination: the remaining pressure sensor once Hammer and Vorschub are taken |

### Deliberately unmapped

- `Bohrgeraet/Klemmdruck` — the Klemmbacke, configured under Rohrverlängerung.
  It is a machine signal, not a sensor of the Verfahren, and is never uploaded.
- `Bohrgeraet/Winkel` — the CSV has two inclination sensors (`Richtung X`,
  `Richtung Y`) and the rig publishes one signal, which also carries
  implausible spikes. Needs a rig to look at before guessing.
- `Maschine/Druck_innen`, `Maschine/Druck_aussen` — no counterpart in the CSV.
- `Spuelpumpe/Volumen`, `Verpresspumpe/Volumen` — the CSV marks `Q_Bohren` and
  `Q_verpressen` as `kiosk`-computed, but this rig publishes them. That is a
  contract question for implenia-web, not something to paper over with a
  binding: a `kiosk` sensor does not even appear on the assignment screen.

### Units do not match, and that is the calibration screen's job

`Ziehgeschwindigkeit` arrives in **m/min** where `Vorschubgeschw.` is **cm/min**,
and it measures the carriage rather than the hole — the same ~2.6:1 the depth
has. Binding the topic is only half the work; the factor is set per rig under
Einstellungen → Kalibrierung.
