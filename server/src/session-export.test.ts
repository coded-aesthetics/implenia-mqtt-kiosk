import { describe, it, expect } from 'vitest';
import {
  buildTimeSeriesRows,
  buildIndexRows,
  buildStreamRows,
  exportFilename,
  isExportableStream,
  TIMESTAMP_COLUMN,
  INDEX_COLUMN,
} from './session-export.js';
import type { SessionReadingRow } from './db.js';

function r(topic: string, value: number | string, receivedAt: number): SessionReadingRow {
  return {
    topic,
    valueNumeric: typeof value === 'number' ? value : null,
    valueText: typeof value === 'string' ? value : null,
    receivedAt,
  };
}

// ── buildTimeSeriesRows (HDI) ───────────────────────────────────────────────

describe('buildTimeSeriesRows', () => {
  const sensors = ['Anpressdruck', 'Drehzahl', 'Bohrtiefe'];

  it('emits a Zeitpunkt header followed by the sensor names in order', () => {
    const rows = buildTimeSeriesRows(sensors, []);
    expect(rows[0]).toEqual([TIMESTAMP_COLUMN, 'Anpressdruck', 'Drehzahl', 'Bohrtiefe']);
  });

  it('produces no data rows when there are no readings', () => {
    expect(buildTimeSeriesRows(sensors, [])).toHaveLength(1);
  });

  it('groups readings that share a timestamp into one row', () => {
    const ts = Date.parse('2024-05-31T06:15:03.000Z');
    const rows = buildTimeSeriesRows(sensors, [
      r('device/1/Anpressdruck', 12.5, ts),
      r('device/1/Drehzahl', 300, ts),
      r('device/1/Bohrtiefe', 4.2, ts),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['2024-05-31T06:15:03.000Z', 12.5, 300, 4.2]);
  });

  it('matches sensors by topic suffix case-insensitively', () => {
    const rows = buildTimeSeriesRows(sensors, [r('a/b/ANPRESSDRUCK', 9, 1000)]);
    expect(rows[1]).toEqual([new Date(1000).toISOString(), 9, '', '']);
  });

  it('leaves cells empty for sensors with no reading at a timestamp', () => {
    const rows = buildTimeSeriesRows(sensors, [
      r('x/Anpressdruck', 1, 1000),
      r('x/Drehzahl', 2, 2000),
    ]);
    expect(rows[1]).toEqual([new Date(1000).toISOString(), 1, '', '']);
    expect(rows[2]).toEqual([new Date(2000).toISOString(), '', 2, '']);
  });

  it('sorts data rows by timestamp ascending', () => {
    const rows = buildTimeSeriesRows(sensors, [
      r('x/Anpressdruck', 1, 3000),
      r('x/Anpressdruck', 2, 1000),
      r('x/Anpressdruck', 3, 2000),
    ]);
    expect(rows.slice(1).map((row) => row[0])).toEqual([
      new Date(1000).toISOString(),
      new Date(2000).toISOString(),
      new Date(3000).toISOString(),
    ]);
  });

  it('ignores readings for sensors outside the stream', () => {
    const rows = buildTimeSeriesRows(sensors, [r('x/UnknownSensor', 99, 1000)]);
    expect(rows).toHaveLength(1);
  });

  it('emits Zeitpunkt as ISO 8601 with an explicit UTC zone', () => {
    const rows = buildTimeSeriesRows(sensors, [r('x/Anpressdruck', 1, 1717135200000)]);
    expect(rows[1][0]).toMatch(/Z$/);
    expect(rows[1][0]).toBe(new Date(1717135200000).toISOString());
  });

  it('matches sensor names that contain a slash', () => {
    const rows = buildTimeSeriesRows(
      ['Bohren/Düsen', 'W/Z-Wert'],
      [r('device/1/Bohren/Düsen', 2, 1000), r('device/1/W/Z-Wert', 0.5, 1000)],
    );
    expect(rows[0]).toEqual([TIMESTAMP_COLUMN, 'Bohren/Düsen', 'W/Z-Wert']);
    expect(rows[1]).toEqual([new Date(1000).toISOString(), 2, 0.5]);
  });

  it('does not cross-match IVL Tiefe against HDI Bohrtiefe', () => {
    const rows = buildTimeSeriesRows(['Bohrtiefe'], [r('device/1/Tiefe', 7, 1000)]);
    expect(rows).toHaveLength(1); // Tiefe reading dropped, not folded into Bohrtiefe
  });

  it('keeps text values as strings', () => {
    const rows = buildTimeSeriesRows(['Kommentar'], [r('x/Kommentar', 'Bohren', 1000)]);
    expect(rows[1]).toEqual([new Date(1000).toISOString(), 'Bohren']);
  });
});

// ── buildIndexRows (IVL) ────────────────────────────────────────────────────

describe('buildIndexRows', () => {
  const sensors = ['Alpha', 'Beta', 'Tiefe'];

  it('emits an Index header followed by the sensor names', () => {
    expect(buildIndexRows(sensors, [])[0]).toEqual([INDEX_COLUMN, 'Alpha', 'Beta', 'Tiefe']);
  });

  it('assigns sequential 0-based indices in timestamp order', () => {
    const rows = buildIndexRows(sensors, [
      r('d/1/Alpha', 1.1, 3000),
      r('d/1/Beta', 2.2, 3000),
      r('d/1/Tiefe', 5, 3000),
      r('d/1/Alpha', 1.3, 1000),
      r('d/1/Beta', 2.4, 1000),
      r('d/1/Tiefe', 3, 1000),
    ]);
    // earliest timestamp (1000) → Index 0, next (3000) → Index 1
    expect(rows[1]).toEqual([0, 1.3, 2.4, 3]);
    expect(rows[2]).toEqual([1, 1.1, 2.2, 5]);
  });

  it('emits the index as a plain integer, not a sentinel timestamp', () => {
    const rows = buildIndexRows(sensors, [r('d/1/Alpha', 1, 999999999)]);
    expect(rows[1][0]).toBe(0);
    expect(typeof rows[1][0]).toBe('number');
  });

  it('produces no data rows without readings', () => {
    expect(buildIndexRows(sensors, [])).toHaveLength(1);
  });
});

// ── buildStreamRows dispatch ────────────────────────────────────────────────

describe('buildStreamRows', () => {
  it('uses the timestamp format for hdi', () => {
    const rows = buildStreamRows('hdi', ['Anpressdruck'], [r('x/Anpressdruck', 1, 1000)]);
    expect(rows[0][0]).toBe(TIMESTAMP_COLUMN);
  });

  it('uses the index format for ivl', () => {
    const rows = buildStreamRows('ivl', ['Alpha'], [r('x/Alpha', 1, 1000)]);
    expect(rows[0][0]).toBe(INDEX_COLUMN);
    expect(rows[1][0]).toBe(0);
  });
});

// ── isExportableStream ──────────────────────────────────────────────────────

describe('isExportableStream', () => {
  it('accepts hdi and ivl', () => {
    expect(isExportableStream('hdi')).toBe(true);
    expect(isExportableStream('ivl')).toBe(true);
  });
  it('rejects result and unknown streams', () => {
    expect(isExportableStream('result')).toBe(false);
    expect(isExportableStream('bogus')).toBe(false);
  });
});

// ── exportFilename ──────────────────────────────────────────────────────────

describe('exportFilename', () => {
  it('appends the stream suffix and xlsx extension', () => {
    expect(exportFilename('Säule 42', 'hdi')).toBe('Säule_42_hdi.xlsx');
    expect(exportFilename('Säule 42', 'ivl')).toBe('Säule_42_ivl.xlsx');
  });

  it('replaces path-unsafe characters', () => {
    expect(exportFilename('A/B:C*?', 'hdi')).toBe('A_B_C_hdi.xlsx');
  });

  it('falls back to a default base when the name is empty', () => {
    expect(exportFilename('', 'hdi')).toBe('session_hdi.xlsx');
  });
});

// ── reduced export ──────────────────────────────────────────────────────────

describe('buildStreamRows at a time grid', () => {
  const sensors = ['Bohrtiefe', 'Drehzahl', 'Wassermenge'];
  const T0 = Date.parse('2026-05-18T12:00:00.000Z');
  const at = (ms: number) => T0 + ms;

  it('keeps every reading on its own row without a grid', () => {
    // What this export always did, and what "Voll" on the Datenübertragung
    // screen must still produce.
    const rows = buildStreamRows('hdi', sensors, [
      r('rig/Bohrtiefe', 1, at(0)),
      r('rig/Drehzahl', 2, at(10)),
      r('rig/Bohrtiefe', 3, at(20)),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual(['2026-05-18T12:00:00.000Z', 1, '', '']);
    expect(rows[2]).toEqual(['2026-05-18T12:00:00.010Z', '', 2, '']);
  });

  it('collapses the same readings onto one row at a one-second grid', () => {
    const rows = buildStreamRows('hdi', sensors, [
      r('rig/Bohrtiefe', 1, at(0)),
      r('rig/Drehzahl', 2, at(10)),
      r('rig/Bohrtiefe', 3, at(20)),
    ], 1000);
    expect(rows).toHaveLength(2);
    // Last value per sensor, dated at the newest reading in the bucket.
    expect(rows[1]).toEqual(['2026-05-18T12:00:00.020Z', 3, 2, '']);
  });

  it('turns a sparse matrix into a dense one', () => {
    // The shape of the real problem: ten channels at ~290 ms, each on its own
    // millisecond, so the ungridded sheet is one filled cell per row.
    const readings = [];
    for (let i = 0; i < 30; i++) {
      readings.push(r('rig/Bohrtiefe', i, at(i * 290)));
      readings.push(r('rig/Drehzahl', 100 + i, at(i * 290 + 12)));
      readings.push(r('rig/Wassermenge', 200 + i, at(i * 290 + 24)));
    }
    const raw = buildStreamRows('hdi', sensors, readings);
    const gridded = buildStreamRows('hdi', sensors, readings, 1000);

    const filled = (rows: (string | number)[][]) =>
      rows.slice(1).reduce((n, row) => n + row.slice(1).filter((c) => c !== '').length, 0);
    const cells = (rows: (string | number)[][]) => (rows.length - 1) * sensors.length;

    expect(filled(raw) / cells(raw)).toBeLessThan(0.4);
    expect(filled(gridded) / cells(gridded)).toBe(1);
    expect(gridded.length).toBeLessThan(raw.length / 5);
  });

  it('carries a slow channel into the rows between its readings', () => {
    // The pump case: one reading every 3 s against a 1 s grid.
    const readings = [];
    for (let i = 0; i < 4; i++) readings.push(r('rig/Bohrtiefe', i, at(i * 1000)));
    readings.push(r('rig/Wassermenge', 70, at(0)));
    readings.push(r('rig/Wassermenge', 71, at(3000)));

    const rows = buildStreamRows('hdi', sensors, readings, 1000);
    expect(rows.slice(1).map((row) => row[3])).toEqual([70, 70, 70, 71]);
  });

  it('leaves a recorded gap empty instead of carrying the value before it', () => {
    const rows = buildStreamRows('hdi', sensors, [
      r('rig/Bohrtiefe', 5, at(0)),
      { topic: 'rig/Bohrtiefe', valueNumeric: null, valueText: null, receivedAt: at(1000) },
      r('rig/Drehzahl', 1, at(2000)),
      r('rig/Drehzahl', 1, at(3000)),
    ], 1000);
    expect(rows.slice(1).map((row) => row[1])).toEqual([5, '', '', '']);
  });

  it('numbers the IVL rows after the grid, not before it', () => {
    const rows = buildStreamRows('ivl', ['Alpha', 'Beta'], [
      r('rig/Alpha', 1, at(0)),
      r('rig/Beta', 2, at(10)),
      r('rig/Alpha', 3, at(1000)),
    ], 1000);
    expect(rows[0][0]).toBe(INDEX_COLUMN);
    expect(rows.slice(1).map((row) => row[0])).toEqual([0, 1]);
  });

  it('keeps the column order the stream defines', () => {
    const rows = buildStreamRows('hdi', sensors, [
      r('rig/Wassermenge', 9, at(0)),
      r('rig/Bohrtiefe', 1, at(10)),
    ], 1000);
    expect(rows[0]).toEqual([TIMESTAMP_COLUMN, 'Bohrtiefe', 'Drehzahl', 'Wassermenge']);
    expect(rows[1]).toEqual(['2026-05-18T12:00:00.010Z', 1, '', 9]);
  });
});
