import { describe, it, expect } from 'vitest';
import { parseVorgabeGeology } from './vorgabe-geology.js';

describe('parseVorgabeGeology', () => {
  it('builds layers running from the previous end depth to its own', () => {
    expect(parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5, 'Geologie 2': 9, 'Geologie 3': 10 },
      float_sensors: {
        'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 7, 'Tiefe Geologie 3': 12,
      },
    })).toEqual({
      schichten: [
        { tiefe: 0, nr: 5 },
        { tiefe: 3, nr: 9 },
        { tiefe: 7, nr: 10 },
      ],
      endTiefe: 12,
    });
  });

  it('prefers Säulenhöhe over the last geology depth', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 8, 'Säulenhöhe': 15 },
    });
    expect(profile?.endTiefe).toBe(15);
  });

  it('returns null when there is no geology at all', () => {
    expect(parseVorgabeGeology({
      float_sensors: { 'Säulenhöhe': 12, 'Druck Hammer': 180 },
    })).toBeNull();
  });

  it('returns null for absent or malformed vorgaben', () => {
    expect(parseVorgabeGeology(null)).toBeNull();
    expect(parseVorgabeGeology(undefined)).toBeNull();
    expect(parseVorgabeGeology('nope')).toBeNull();
    expect(parseVorgabeGeology({})).toBeNull();
  });

  it('reads numbers that arrive as strings', () => {
    expect(parseVorgabeGeology({
      string_sensors: { 'Geologie 1': '5', 'Geologie 2': '9' },
      float_sensors: { 'Tiefe Geologie 1': '2.5', 'Tiefe Geologie 2': '6' },
    })).toEqual({
      schichten: [{ tiefe: 0, nr: 5 }, { tiefe: 2.5, nr: 9 }],
      endTiefe: 6,
    });
  });

  it('skips a layer whose code is unset', () => {
    // 0 is how a Schichtauftrag spells "no ground type here".
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5, 'Geologie 2': 0, 'Geologie 3': 10 },
      float_sensors: {
        'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 7, 'Tiefe Geologie 3': 11,
      },
    });
    expect(profile?.schichten).toEqual([{ tiefe: 0, nr: 5 }, { tiefe: 3, nr: 10 }]);
    expect(profile?.endTiefe).toBe(11);
  });

  it('ignores null and non-numeric values', () => {
    expect(parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5, 'Geologie 2': null },
      float_sensors: { 'Tiefe Geologie 1': 4, 'Tiefe Geologie 2': 'n/a' },
    })).toEqual({ schichten: [{ tiefe: 0, nr: 5 }], endTiefe: 4 });
  });

  it('orders by index, not by the order the keys arrived in', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 3': 10, 'Geologie 1': 5, 'Geologie 2': 9 },
      float_sensors: {
        'Tiefe Geologie 3': 9, 'Tiefe Geologie 1': 2, 'Tiefe Geologie 2': 5,
      },
    });
    expect(profile?.schichten.map((s) => s.nr)).toEqual([5, 9, 10]);
    expect(profile?.schichten.map((s) => s.tiefe)).toEqual([0, 2, 5]);
  });

  it('handles double-digit layer indices', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 9': 5, 'Geologie 10': 9 },
      float_sensors: { 'Tiefe Geologie 9': 3, 'Tiefe Geologie 10': 8 },
    });
    expect(profile?.schichten.map((s) => s.nr)).toEqual([5, 9]);
  });

  it('falls back to a nominal depth when nothing names one', () => {
    const profile = parseVorgabeGeology({ int_sensors: { 'Geologie 1': 5 } });
    expect(profile).toEqual({ schichten: [{ tiefe: 0, nr: 5 }], endTiefe: 10 });
  });

  it('ignores a Säulenhöhe of zero rather than collapsing the profile', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 6, 'Säulenhöhe': 0 },
    });
    expect(profile?.endTiefe).toBe(6);
  });

  it('matches the sensor names case-insensitively', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'geologie 1': 5 },
      float_sensors: { 'tiefe geologie 1': 4 },
    });
    expect(profile).toEqual({ schichten: [{ tiefe: 0, nr: 5 }], endTiefe: 4 });
  });

  it('prefers Injektionsbohren\u2019s Bohrlaenge over the last geology depth', () => {
    // The planned geology ends at 36 m, the bore goes to 43: the profile has
    // to reach the bottom of the hole or the chart stops drawing the depth
    // indicator seven metres above it.
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5, 'Geologie 2': 9 },
      float_sensors: {
        'Tiefe Geologie 1': 12, 'Tiefe Geologie 2': 36, Bohrlaenge: 43,
      },
    });
    expect(profile?.endTiefe).toBe(43);
    expect(profile?.schichten).toEqual([{ tiefe: 0, nr: 5 }, { tiefe: 12, nr: 9 }]);
  });

  it('accepts the umlaut spelling of Bohrl\u00e4nge too', () => {
    // A miss here is silent \u2014 the profile falls back to the last geology
    // depth and nothing says so \u2014 so both spellings are matched.
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 8, 'Bohrl\u00e4nge': 15 },
    });
    expect(profile?.endTiefe).toBe(15);
  });

  it('reads Ankerbohren\u2019s Bohrl\u00e4nge Anker', () => {
    // Its own `Bema\u00dfungen` name in `ankerbohren-sensors.csv`, which none of
    // the other three match by prefix \u2014 and Ankerbohren records geology, so
    // missing it clipped every one of its profiles to the last geology depth.
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 8, 'Bohrl\u00e4nge Anker': 18 },
    });
    expect(profile?.endTiefe).toBe(18);
  });

  it('ignores a Bohrlaenge of zero rather than collapsing the profile', () => {
    const profile = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 6, Bohrlaenge: 0 },
    });
    expect(profile?.endTiefe).toBe(6);
  });

  it('is deterministic when an element carries more than one planned depth', () => {
    // Not a shape any Verfahren produces, but the answer must not depend on
    // key order.
    const vorwaerts = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 6, 'S\u00e4ulenh\u00f6he': 12, Bohrlaenge: 43 },
    });
    const rueckwaerts = parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 6, Bohrlaenge: 43, 'S\u00e4ulenh\u00f6he': 12 },
    });
    expect(vorwaerts?.endTiefe).toBe(12);
    expect(rueckwaerts?.endTiefe).toBe(12);
  });

  it('bounds the plan at the bore when the geology runs deeper', () => {
    // A pillar keyed at 13 m carrying a profile that runs to 36 \u2014 a site may
    // share one geological section across every element, so this is ordinary.
    // The layers below 13 m are below the hole: `mergeProfile` drops them, and
    // taking the deeper of the two instead had the kiosk commit 23 m of
    // planned ground the drill never reached.
    const profile = parseVorgabeGeology({
      int_sensors: {
        'Geologie 1': 5, 'Geologie 2': 9, 'Geologie 3': 1, 'Geologie 4': 20,
      },
      float_sensors: {
        'Tiefe Geologie 1': 15, 'Tiefe Geologie 2': 20,
        'Tiefe Geologie 3': 30, 'Tiefe Geologie 4': 36,
        Bohrlaenge: 13,
      },
    });
    expect(profile?.endTiefe).toBe(13);
    // The layers themselves are untouched here \u2014 bounding them is the
    // merge\u2019s job, against this number *and* the deepest reading.
    expect(profile?.schichten).toEqual([
      { tiefe: 0, nr: 5 }, { tiefe: 15, nr: 9 },
      { tiefe: 20, nr: 1 }, { tiefe: 30, nr: 20 },
    ]);
  });

  it('answers with the bore whichever way the two run', () => {
    const tief = { int_sensors: { 'Geologie 1': 5 }, float_sensors: { 'Tiefe Geologie 1': 36, Bohrlaenge: 43 } };
    const flach = { int_sensors: { 'Geologie 1': 5 }, float_sensors: { 'Tiefe Geologie 1': 36, Bohrlaenge: 13 } };
    expect(parseVorgabeGeology(tief)?.endTiefe).toBe(43);
    expect(parseVorgabeGeology(flach)?.endTiefe).toBe(13);
  });

  // Nothing names a bore: the survey's own bottom is the only plan there is,
  // and it is what this fell back to before any Verfahren was on the list.
  it('falls back to the geology bottom when no bore is named', () => {
    expect(parseVorgabeGeology({
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 36 },
    })?.endTiefe).toBe(36);
  });

  it('rounds a fractional ground-type number', () => {
    // int_float_sensors can deliver a code as a float.
    const profile = parseVorgabeGeology({
      int_float_sensors: { 'Geologie 1': 5.0 },
      float_sensors: { 'Tiefe Geologie 1': 3 },
    });
    expect(profile?.schichten).toEqual([{ tiefe: 0, nr: 5 }]);
  });
});
