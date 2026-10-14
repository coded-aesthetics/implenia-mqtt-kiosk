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
| `Maschine/Druck_innen` | `IDrehmoment` | the rotary pressures are what the torque sensors are fed from — see below |
| `Maschine/Druck_aussen` | `ADrehmoment` | ditto, outer head |
| `Spuelpumpe/Volumen` | `Q_Bohren` | this rig publishes the totals the CSV marks `kiosk` — see below |
| `Verpresspumpe/Volumen` | `Q_verpressen` | ditto, grout pump |

### Deliberately unmapped

- `Bohrgeraet/Klemmdruck` — the Klemmbacke, configured under Rohrverlängerung.
  It is a machine signal, not a sensor of the Verfahren, and is never uploaded.
- `Bohrgeraet/Winkel` — the CSV has two inclination sensors (`Richtung X`,
  `Richtung Y`) and the rig publishes one signal, which also carries
  implausible spikes. Needs a rig to look at before guessing.

Nothing else. Every topic the G08 capture contains is now bound, which is the
state this file should be kept in: an unbound topic is recorded, displayed live,
and silently never uploaded.

### `IDrehmoment` / `ADrehmoment` are fed from the rotary pressures

These two were read as "no counterpart in the CSV" for a while, which was
wrong and cost two channels of every upload. The rig has no torque transducer:
the inner and outer **rotary pressures are what drive the rotation**, so they
are what the torque sensors were always meant to carry — the `I`/`A` in the
sensor names is `innen`/`aussen`, matching the topics exactly. The CSV naming
comes from an early misunderstanding of what these machines can report, and it
is live on the platform, so the binding is the pragmatic half of the fix.

**The relation is a factor nobody has measured, and it may not be linear.**
Scale stays 1 until someone does, so what reaches the platform is bar under a
sensor declared in `Nm`. That is a deliberate trade: no computation in
implenia-web's Injektionsbohren profile reads either sensor — the only consumer
is the Tiefenprofil curve — so the cost is an axis label that overstates
precision, against channels that were being thrown away entirely. A linear
factor can be set per rig under Einstellungen → Kalibrierung without a release;
a non-linear one has nowhere to live today, and the honest fix then is to rename
the sensors in implenia-web's CSVs.

### `Q_Bohren` / `Q_verpressen` are bound although the CSV says `kiosk`

The CSV marks both as `kiosk`-computed, and the kiosk does compute them — but
this rig also publishes the totals, and they are the machine's own count. The
binding takes the published value. It stays a contract question for
implenia-web rather than something this file settles, and the consequence to
know is that a `kiosk` sensor does not appear on the assignment screen, so a
technician cannot see or change this binding on site.

### Units do not match, and that is the calibration screen's job

`Ziehgeschwindigkeit` arrives in **m/min** where `Vorschubgeschw.` is **cm/min**,
and it measures the carriage rather than the hole — the same ~2.6:1 the depth
has. Binding the topic is only half the work; the factor is set per rig under
Einstellungen → Kalibrierung.
