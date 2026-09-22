import { describe, it, expect } from 'vitest';
import {
  VERFAHREN,
  isValidVerfahren,
  parseSensorCsv,
  loadSensorCsv,
} from './sensor-meta.js';

describe('isValidVerfahren', () => {
  it('accepts every registered Verfahren', () => {
    for (const key of Object.keys(VERFAHREN)) {
      expect(isValidVerfahren(key)).toBe(true);
    }
  });

  it('rejects unknown keys', () => {
    expect(isValidVerfahren('schlitzwand')).toBe(false);
    expect(isValidVerfahren('')).toBe(false);
  });

  it('does not treat inherited Object properties as Verfahren', () => {
    // A `?type=constructor` request must 404, not resolve through the prototype.
    expect(isValidVerfahren('constructor')).toBe(false);
    expect(isValidVerfahren('toString')).toBe(false);
  });
});

describe('parseSensorCsv', () => {
  it('maps columns by header name, not position', () => {
    const csv = 'Rolle,Name,Quelle,Einheit,Typ,Priorität,Alias\ndepth,Bohrtiefe,mqtt,m,Double,hero,';
    expect(parseSensorCsv(csv)).toEqual([
      { name: 'Bohrtiefe', type: 'Double', unit: 'm', source: 'mqtt', role: 'depth', priority: 'hero', alias: '', stream: '' },
    ]);
  });

  it('returns an empty list for a header-only or empty file', () => {
    expect(parseSensorCsv('')).toEqual([]);
    expect(parseSensorCsv('Name,Typ,Einheit,Quelle,Rolle,Priorität,Alias')).toEqual([]);
  });

  it('leaves the stream empty when the CSV has no Stream column', () => {
    const csv = 'Name,Typ,Einheit,Quelle,Rolle,Priorität,Alias\nDrehzahl,Double,1/min,mqtt,rpm,primary,';
    expect(parseSensorCsv(csv)[0].stream).toBe('');
  });
});

describe('loadSensorCsv', () => {
  it('loads a CSV for every registered Verfahren', () => {
    for (const key of Object.keys(VERFAHREN)) {
      const rows = loadSensorCsv(key);
      expect(rows, `${key} must have a herstellen CSV`).not.toBeNull();
      expect(rows!.length).toBeGreaterThan(0);
    }
  });

  it('returns null for a Verfahren with no CSV on disk', () => {
    expect(loadSensorCsv('does-not-exist')).toBeNull();
  });

  it('parses the Injektionsbohren contract the kiosk depends on', () => {
    const byName = new Map(loadSensorCsv('injektionsbohren')!.map((r) => [r.name, r]));

    // Status drives every phase-segmented KPI in implenia-web and is set by
    // the worker, not the machine.
    expect(byName.get('Status')).toMatchObject({ type: 'Integer', source: 'user', role: 'mode' });
    expect(byName.get('Bohrtiefe')).toMatchObject({ source: 'mqtt', role: 'depth', priority: 'hero' });
    // Casing is part of the cross-repo contract — see docs/verfahren.
    expect(byName.has('Q_Bohren')).toBe(true);
    expect(byName.has('Q_verpressen')).toBe(true);
    expect(byName.has('DurchflussB')).toBe(true);
    expect(byName.has('DurchflussV')).toBe(true);
  });

  it('defines no streams for Injektionsbohren, but does for DSV', () => {
    expect(loadSensorCsv('injektionsbohren')!.every((r) => r.stream === '')).toBe(true);
    expect(loadSensorCsv('dsv')!.some((r) => r.stream === 'hdi')).toBe(true);
  });
});
