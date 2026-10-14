import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERFAHREN, loadSensorCsv } from './sensor-meta.js';
import { loadTopicMap, resolveSensorKey, sensorNameIndex } from './topic-resolver.js';

/**
 * Guards the shipped topic maps against the failure they exist to prevent.
 *
 * A value that is not a real sensor name binds a topic to nothing: the reading
 * is displayed live, stored without a sensor id, and filtered out of every
 * upload. Nothing anywhere reports an error — so a typo here is invisible
 * until someone notices a column missing from an export weeks later.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.join(__dirname, '..', 'assets', 'topic-maps');

describe('shipped topic maps', () => {
  for (const verfahren of Object.keys(VERFAHREN)) {
    const file = path.join(MAPS_DIR, `${verfahren}.json`);
    if (!fs.existsSync(file)) continue;

    describe(verfahren, () => {
      const map = loadTopicMap(verfahren);
      const names = new Set((loadSensorCsv(verfahren) ?? []).map((r) => r.name));

      it('binds only to sensors this Verfahren actually has', () => {
        const unknown = [...map.values()].filter((name) => !names.has(name));
        expect(unknown).toEqual([]);
      });

      it('never binds two topics to the same sensor', () => {
        // Two topics feeding one sensor interleave into a single series, and
        // the result looks like noise rather than an error.
        const bound = [...map.values()];
        expect(bound.length).toBe(new Set(bound).size);
      });
    });
  }
});

describe('the Injektionsbohren map against the rig it came from', () => {
  const ctx = {
    overrides: new Map<string, string>(),
    topicMap: loadTopicMap('injektionsbohren'),
    sensorNames: sensorNameIndex(loadSensorCsv('injektionsbohren') ?? []),
  };

  // Exactly as they appear in the G08 reference capture (assets/reference/README.md).
  const expected: Record<string, string> = {
    'Bohrgeraet/Tiefe': 'bohrtiefe',
    'Bohrgeraet/Drehzahl': 'drehzahl',
    'Bohrgeraet/Ziehgeschwindigkeit': 'vorschubgeschw.',
    'Maschine/Druck_Hammer': 'druck hammer',
    'Maschine/Druck_Vorschub': 'vorschubdruck',
    'Maschine/Druck_Medium': 'suspensionsdruck',
    // The rig has no torque transducer: the inner and outer rotary pressures
    // are what drive the rotation, and the I/A in the sensor names is
    // innen/aussen. Unbound, these were two channels of every upload thrown
    // away — see assets/topic-maps/README.md for the unit caveat.
    'Maschine/Druck_innen': 'idrehmoment',
    'Maschine/Druck_aussen': 'adrehmoment',
    'Spuelpumpe/Durchfluss': 'durchflussb',
    'Verpresspumpe/Durchfluss': 'durchflussv',
  };

  for (const [topic, sensor] of Object.entries(expected)) {
    it(`resolves ${topic}`, () => {
      expect(resolveSensorKey(topic, ctx)).toBe(sensor);
    });
  }

  it('keeps the two pumps apart', () => {
    // They share a last segment, which is why the map is keyed by full topic.
    expect(resolveSensorKey('Spuelpumpe/Durchfluss', ctx))
      .not.toBe(resolveSensorKey('Verpresspumpe/Durchfluss', ctx));
  });

  it('binds every topic the reference capture publishes but the Klemmbacke and the Winkel', () => {
    // An unbound topic is recorded, shown live and silently never uploaded, so
    // the ones left out are a decision and belong in the README rather than in
    // whatever the map happens to contain.
    const published = [
      'Bohrgeraet/Winkel', 'Bohrgeraet/Klemmdruck', 'Bohrgeraet/Ziehgeschwindigkeit',
      'Bohrgeraet/Tiefe', 'Bohrgeraet/Drehzahl', 'Maschine/Druck_Hammer',
      'Maschine/Druck_aussen', 'Maschine/Druck_Vorschub', 'Maschine/Druck_Medium',
      'Maschine/Druck_innen', 'Verpresspumpe/Volumen', 'Spuelpumpe/Volumen',
      'Verpresspumpe/Durchfluss', 'Spuelpumpe/Durchfluss',
    ];
    const names = new Set((loadSensorCsv('injektionsbohren') ?? [])
      .map((r) => r.name.toLowerCase()));
    const unbound = published.filter((t) => !names.has(resolveSensorKey(t, ctx) ?? ''));
    expect(unbound).toEqual(['Bohrgeraet/Winkel', 'Bohrgeraet/Klemmdruck']);
  });

  it('leaves the Klemmbacke unbound', () => {
    // It drives the Rohrwechsel detection and is not a sensor of the
    // Verfahren; binding it would put a machine signal into the upload.
    const key = resolveSensorKey('Bohrgeraet/Klemmdruck', ctx);
    expect((loadSensorCsv('injektionsbohren') ?? []).some((r) => r.name.toLowerCase() === key))
      .toBe(false);
  });
});
