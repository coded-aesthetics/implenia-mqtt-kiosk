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
