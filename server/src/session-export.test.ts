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
