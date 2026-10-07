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

  it('rounds a fractional ground-type number', () => {
    // int_float_sensors can deliver a code as a float.
    const profile = parseVorgabeGeology({
      int_float_sensors: { 'Geologie 1': 5.0 },
      float_sensors: { 'Tiefe Geologie 1': 3 },
    });
    expect(profile?.schichten).toEqual([{ tiefe: 0, nr: 5 }]);
  });
});
