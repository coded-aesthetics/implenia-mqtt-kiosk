import { describe, it, expect } from 'vitest';
import {
  buildSchichten, byPriority, collectVorgabeEntries, extractCoordinates,
  geplanteTiefe, getPriority, isSpecialSensor, letzteVorgabeTiefe,
  parseRawPayload, vorgabeText,
} from './vorgaben';
import type { VorgabenData } from '../hooks/useImplenia';

describe('vorgabeText', () => {
  it('shows a dash for nothing', () => {
    expect(vorgabeText(null)).toBe('–');
    expect(vorgabeText(undefined)).toBe('–');
    expect(vorgabeText('')).toBe('–');
    expect(vorgabeText(NaN)).toBe('–');
    expect(vorgabeText(Infinity)).toBe('–');
  });

  it('leaves a number machine-readable', () => {
    // The contract that matters: NOT German-formatted. These strings are
    // parsed back by buildSchichten and extractCoordinates.
    expect(vorgabeText(1234.5)).toBe('1234.5');
    expect(vorgabeText(1234.5)).not.toContain(',');
    expect(vorgabeText(0)).toBe('0');
  });

  it('falls back to JSON for anything else', () => {
    expect(vorgabeText({ a: 1 })).toBe('{"a":1}');
  });
});

describe('collectVorgabeEntries', () => {
  it('is empty without a Schichtauftrag', () => {
    expect(collectVorgabeEntries(null)).toEqual([]);
  });

  it('flattens every sensor type into one list', () => {
    const vorgaben = {
      float_sensors: { 'Säulenhöhe': 12.5 },
      int_sensors: { 'Geologie 1': 3 },
      string_sensors: { Bemerkung: 'test' },
      geo_sensors: { 'Startpunkt X': 2600000.25 },
      int_float_sensors: { Nummer: 7 },
    } as unknown as VorgabenData;

    expect(collectVorgabeEntries(vorgaben)).toEqual([
      { name: 'Säulenhöhe', value: '12.5' },
      { name: 'Geologie 1', value: '3' },
      { name: 'Bemerkung', value: 'test' },
      { name: 'Startpunkt X', value: '2600000.25' },
      { name: 'Nummer', value: '7' },
    ]);
  });

  it('tolerates missing sensor groups', () => {
    expect(collectVorgabeEntries({ float_sensors: { A: 1 } } as unknown as VorgabenData))
      .toEqual([{ name: 'A', value: '1' }]);
  });
});

describe('isSpecialSensor', () => {
  it('claims the sensors that are drawn some other way', () => {
    expect(isSpecialSensor('Geologie 1')).toBe(true);
    expect(isSpecialSensor('Tiefe Geologie 12')).toBe(true);
    expect(isSpecialSensor('Startpunkt X')).toBe(true);
    expect(isSpecialSensor('Fusspunkt Z')).toBe(true);
    expect(isSpecialSensor('Nummer')).toBe(true);
  });

  it('leaves ordinary sensors to the tiles', () => {
    expect(isSpecialSensor('Säulenhöhe')).toBe(false);
    expect(isSpecialSensor('Bohrtiefe')).toBe(false);
    // Near-misses must not be swallowed.
    expect(isSpecialSensor('Geologie')).toBe(false);
    expect(isSpecialSensor('Startpunkt')).toBe(false);
  });
});

describe('extractCoordinates', () => {
  it('groups the axes of each point into one row', () => {
    expect(extractCoordinates([
      { name: 'Startpunkt X', value: '2600000' },
      { name: 'Startpunkt Y', value: '1200000' },
      { name: 'Startpunkt Z', value: '450' },
      { name: 'Säulenhöhe', value: '12' },
    ])).toEqual([{ label: 'Startpunkt', x: '2600000', y: '1200000', z: '450' }]);
  });

  it('keeps Startpunkt and Fusspunkt apart', () => {
    const groups = extractCoordinates([
      { name: 'Startpunkt X', value: '1' },
      { name: 'Fusspunkt X', value: '2' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(['Startpunkt', 'Fusspunkt']);
  });

  it('shows a dash for an axis that was not delivered', () => {
    expect(extractCoordinates([{ name: 'Startpunkt X', value: '1' }]))
      .toEqual([{ label: 'Startpunkt', x: '1', y: '–', z: '–' }]);
  });

  it('is empty when there are no coordinates', () => {
    expect(extractCoordinates([{ name: 'Säulenhöhe', value: '12' }])).toEqual([]);
  });
});

describe('buildSchichten', () => {
  it('is null when the Schichtauftrag carries no geology', () => {
    // This is what tells the screen not to reserve a column for the profile.
    expect(buildSchichten([{ name: 'Säulenhöhe', value: '12' }])).toBeNull();
  });

  it('runs each layer from the previous one to its own end depth', () => {
    expect(buildSchichten([
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '4.5' },
      { name: 'Geologie 2', value: '7' },
      { name: 'Tiefe Geologie 2', value: '9' },
    ])).toEqual({
      schichten: [{ tiefe: 0, nr: 3 }, { tiefe: 4.5, nr: 7 }],
      endTiefe: 9,
    });
  });

  it('orders layers by index, not by arrival', () => {
    const result = buildSchichten([
      { name: 'Geologie 2', value: '7' },
      { name: 'Tiefe Geologie 2', value: '9' },
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '4.5' },
    ]);
    expect(result?.schichten.map((s) => s.nr)).toEqual([3, 7]);
  });

  it('prefers Säulenhöhe over the last geology depth', () => {
    expect(buildSchichten([
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '4.5' },
      { name: 'Säulenhöhe', value: '20' },
    ])?.endTiefe).toBe(20);
  });

  it('prefers Injektionsbohren\u2019s Bohrlaenge over the last geology depth', () => {
    // The planned geology ends at 36 m, the bore goes to 43. Below endTiefe
    // the chart draws neither a layer nor the depth indicator.
    expect(buildSchichten([
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '36' },
      { name: 'Bohrlaenge', value: '43' },
    ])?.endTiefe).toBe(43);
  });

  it('accepts the umlaut spelling of Bohrl\u00e4nge too', () => {
    // A miss here is silent: the profile quietly stops at the last geology
    // depth, which is what this change exists to fix.
    expect(buildSchichten([
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '36' },
      { name: 'Bohrl\u00e4nge', value: '43' },
    ])?.endTiefe).toBe(43);
  });

  it('ignores a planned depth of zero rather than collapsing the profile', () => {
    expect(buildSchichten([
      { name: 'Geologie 1', value: '3' },
      { name: 'Tiefe Geologie 1', value: '6' },
      { name: 'Bohrlaenge', value: '0' },
    ])?.endTiefe).toBe(6);
  });

  it('falls back to a nominal depth when nothing says how deep', () => {
    expect(buildSchichten([{ name: 'Geologie 1', value: '3' }])?.endTiefe).toBe(10);
  });

  it('skips a layer whose code is not a positive number', () => {
    expect(buildSchichten([
      { name: 'Geologie 1', value: '0' },
      { name: 'Geologie 2', value: 'unbekannt' },
    ])).toBeNull();
  });

  it('reads the machine-readable strings vorgabeText produces', () => {
    // The round trip that a German-formatted value would silently break:
    // "1.234,50" parses back as 1.234.
    const entries = collectVorgabeEntries({
      int_sensors: { 'Geologie 1': 3 },
      float_sensors: { 'Tiefe Geologie 1': 1234.5, 'Säulenhöhe': 2000.75 },
    } as unknown as VorgabenData);

    expect(buildSchichten(entries)).toEqual({
      schichten: [{ tiefe: 0, nr: 3 }],
      endTiefe: 2000.75,
    });
  });
});

describe('geplanteTiefe', () => {
  it('reads Injektionsbohren\u2019s Bohrlaenge', () => {
    expect(geplanteTiefe({ float_sensors: { Bohrlaenge: 43 } })).toBe(43);
  });

  it('reads DSV\u2019s S\u00e4ulenh\u00f6he', () => {
    expect(geplanteTiefe({ float_sensors: { 'S\u00e4ulenh\u00f6he': 12.5 } })).toBe(12.5);
  });

  it('agrees with the profile\u2019s own bottom', () => {
    // The briefing\u2019s hero and the column\u2019s endTiefe are the same number,
    // read through one list of names \u2014 that is the point of the helper.
    const vorgaben = {
      int_sensors: { 'Geologie 1': 5 },
      float_sensors: { 'Tiefe Geologie 1': 36, Bohrlaenge: 43 },
    };
    expect(geplanteTiefe(vorgaben))
      .toBe(buildSchichten(collectVorgabeEntries(vorgaben as never))?.endTiefe);
  });

  it('is null when nothing names a depth, and for zero', () => {
    expect(geplanteTiefe({ float_sensors: { 'Tiefe Geologie 1': 36 } })).toBeNull();
    expect(geplanteTiefe({ float_sensors: { Bohrlaenge: 0 } })).toBeNull();
    expect(geplanteTiefe(null)).toBeNull();
  });
});

describe('letzteVorgabeTiefe', () => {
  it('is the deepest surveyed boundary, whatever order it arrives in', () => {
    expect(letzteVorgabeTiefe([
      { name: 'Tiefe Geologie 2', value: '36' },
      { name: 'Tiefe Geologie 1', value: '2.5' },
    ])).toBe(36);
  });

  it('ignores everything that is not a geology depth', () => {
    expect(letzteVorgabeTiefe([
      { name: 'Tiefe Geologie 1', value: '12' },
      { name: 'Bohrlaenge', value: '43' },
      { name: 'Geologie 1', value: '20' },
    ])).toBe(12);
  });

  it('is null when the Schichtauftrag names no depth at all', () => {
    expect(letzteVorgabeTiefe([{ name: 'Geologie 1', value: '5' }])).toBeNull();
    expect(letzteVorgabeTiefe([{ name: 'Tiefe Geologie 1', value: 'n/a' }])).toBeNull();
  });
});

describe('parseRawPayload', () => {
  it('formats a numeric payload for German eyes', () => {
    expect(parseRawPayload('1234.5678')).toBe('1.234,57');
    expect(parseRawPayload('  42 ')).toBe('42,00');
  });

  it('shows a dash for a payload carrying no value', () => {
    for (const p of ['', '   ', 'NaN', 'null', 'Infinity', '-Infinity', '""']) {
      expect(parseRawPayload(p)).toBe('–');
    }
  });

  it('shows the text of a string sensor as-is', () => {
    expect(parseRawPayload('Bohren')).toBe('Bohren');
  });
});

describe('getPriority', () => {
  it('defaults to primary', () => {
    expect(getPriority(undefined)).toBe('primary');
    expect(getPriority({ id: '1', name: 'A' })).toBe('primary');
    expect(getPriority({ id: '1', name: 'A', meta: { priority: 'unsinn' } })).toBe('primary');
  });

  it('honours a known priority', () => {
    expect(getPriority({ id: '1', name: 'A', meta: { priority: 'hero' } })).toBe('hero');
    expect(getPriority({ id: '1', name: 'A', meta: { priority: 'secondary' } })).toBe('secondary');
  });
});

describe('byPriority', () => {
  it('buckets while preserving order', () => {
    const items = [
      { n: 'a', p: 'secondary' as const },
      { n: 'b', p: 'hero' as const },
      { n: 'c', p: 'secondary' as const },
      { n: 'd', p: 'primary' as const },
    ];
    const out = byPriority(items, (i) => i.p);
    expect(out.hero.map((i) => i.n)).toEqual(['b']);
    expect(out.primary.map((i) => i.n)).toEqual(['d']);
    expect(out.secondary.map((i) => i.n)).toEqual(['a', 'c']);
  });

  it('gives back three buckets even when empty', () => {
    expect(byPriority([], () => 'hero' as const))
      .toEqual({ hero: [], primary: [], secondary: [] });
  });
});
