import { describe, it, expect } from 'vitest';
import {
  CHUNK_ROWS, csvChunkProblem, isGriddableSensor, pinAnchorReadings, planCsvUpload,
  type CsvChunk, type UploadSensorMeta,
} from './csv-upload.js';
import type { SessionUploadGroup } from './db.js';

const T0 = Date.parse('2026-05-18T12:00:00.000Z');

let nextId = 1;
function group(
  sensorId: string,
  sensorType: string,
  values: [offsetMs: number, value: number | string | null][],
): SessionUploadGroup {
  return {
    sensorId,
    sensorType,
    readings: values.map(([offset, value]) => ({
      id: nextId++,
      valueNumeric: typeof value === 'number' ? value : null,
      valueText: typeof value === 'string' ? value : null,
      receivedAt: T0 + offset,
    })),
  };
}

const meta = (entries: Record<string, UploadSensorMeta>) =>
  new Map(Object.entries(entries));

const GRID = { bucketMs: 1000, maxHoldMs: 4000 };

function parse(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.trimEnd().split('\n');
  return {
    header: lines[0].split(';'),
    rows: lines.slice(1).map((l) => l.split(';')),
  };
}

// ── which sensors may be gridded ────────────────────────────────────────────

describe('isGriddableSensor', () => {
  it('accepts a named numeric telemetry sensor', () => {
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Bohrtiefe' })).toBe(true);
    expect(isGriddableSensor({ sensorType: 'int' }, { name: 'Status' })).toBe(true);
  });

  it('refuses a string sensor — an empty cell there writes an empty string', () => {
    expect(isGriddableSensor({ sensorType: 'string' }, { name: 'Kommentar' })).toBe(false);
  });

  it('refuses GeoDIN: a grid merges boundaries, and one row is one layer', () => {
    expect(
      isGriddableSensor({ sensorType: 'int' }, { name: 'GeoDIN', role: 'geology_nr' }),
    ).toBe(false);
  });

  it('refuses the completion stamp and the geology text', () => {
    expect(
      isGriddableSensor({ sensorType: 'string' }, { name: 'Ausführungsdatum', role: 'is_completed' }),
    ).toBe(false);
    expect(
      isGriddableSensor({ sensorType: 'string' }, { name: 'Geologie', role: 'geology_text' }),
    ).toBe(false);
  });

  it('accepts the depth sensor — its geology instants are pinned back in', () => {
    // It carries the biggest channel of the session; leaving it ungridded to
    // protect the geology join costs more than pinning the handful of readings
    // that join actually needs. See pinAnchorReadings.
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Bohrtiefe', role: 'depth' }))
      .toBe(true);
  });

  it('refuses a sensor the session never recorded a name for', () => {
    // The map is keyed by the lowercased name, so the real spelling is not
    // recoverable — and the CSV header is the only way to address a column.
    expect(isGriddableSensor({ sensorType: 'float' }, { role: 'depth' })).toBe(false);
    expect(isGriddableSensor({ sensorType: 'float' }, undefined)).toBe(false);
  });
});

// ── planning ────────────────────────────────────────────────────────────────

describe('planCsvUpload', () => {
  it('puts the telemetry in the CSV and leaves the rest to the per-sensor path', () => {
    const groups = [
      group('s-rpm', 'float', [[0, 60]]),
      group('s-tiefe', 'float', [[0, 1.5]]),
      group('s-geodin', 'int', [[0, 23]]),
      group('s-kommentar', 'string', [[0, 'Hindernis']]),
    ];
    const plan = planCsvUpload(groups, meta({
      's-rpm': { name: 'Drehzahl', role: 'rpm' },
      's-tiefe': { name: 'Bohrtiefe', role: 'depth' },
      's-geodin': { name: 'GeoDIN', role: 'geology_nr' },
      's-kommentar': { name: 'Kommentar' },
    }), GRID);

    expect(plan.gridded).toEqual(['Drehzahl', 'Bohrtiefe']);
    expect(plan.leftovers.map((g) => g.sensorId)).toEqual(['s-geodin', 's-kommentar']);
  });

  it('writes a Zeitpunkt header with the platform spelling of each sensor', () => {
    const plan = planCsvUpload(
      [group('s1', 'float', [[0, 1]]), group('s2', 'float', [[0, 2]])],
      meta({ s1: { name: 'Bohrtiefe' }, s2: { name: 'Düsstrecke (Ist)' } }),
      GRID,
    );
    expect(parse(plan.chunks[0].csv).header).toEqual([
      'Zeitpunkt', 'Bohrtiefe', 'Düsstrecke (Ist)',
    ]);
  });

  it('dates each row in ISO 8601 with an explicit zone', () => {
    const plan = planCsvUpload(
      [group('s1', 'float', [[123, 1]])],
      meta({ s1: { name: 'Bohrtiefe' } }),
      GRID,
    );
    expect(parse(plan.chunks[0].csv).rows[0][0]).toBe('2026-05-18T12:00:00.123Z');
  });

  it('reduces a second of readings to one row holding the last value', () => {
    const plan = planCsvUpload(
      [group('s1', 'float', [[0, 1], [300, 2], [600, 3], [900, 4]])],
      meta({ s1: { name: 'Bohrtiefe' } }),
      GRID,
    );
    const { rows } = parse(plan.chunks[0].csv);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('4');
  });

  it('accounts for every reading it reduced away', () => {
    const groups = [group('s1', 'float', [[0, 1], [300, 2], [600, 3]])];
    const plan = planCsvUpload(groups, meta({ s1: { name: 'Bohrtiefe' } }), GRID);
    const ids = plan.chunks.flatMap((c) => c.ids).sort((a, b) => a - b);
    expect(ids).toEqual(groups[0].readings.map((r) => r.id));
  });

  it('uploads a non-finite reading as a gap, not as text', () => {
    // A reading recorded before `nan` was recognised sits in value_text, and a
    // numeric column must not be handed it.
    const plan = planCsvUpload(
      [group('s1', 'float', [[0, 'nan']])],
      meta({ s1: { name: 'Bohrtiefe' } }),
      GRID,
    );
    expect(parse(plan.chunks[0].csv).rows[0][1]).toBe('');
  });

  it('quotes a sensor name that would otherwise break the row', () => {
    const plan = planCsvUpload(
      [group('s1', 'float', [[0, 1]])],
      meta({ s1: { name: 'Druck; innen' } }),
      GRID,
    );
    expect(plan.chunks[0].csv.split('\n')[0]).toBe('Zeitpunkt;"Druck; innen"');
  });

  // ── chunking ──────────────────────────────────────────────────────────────

  it('splits the rows into chunks so a failure costs one of them', () => {
    const readings: [number, number][] = [];
    for (let i = 0; i < 25; i++) readings.push([i * 1000, i]);
    const plan = planCsvUpload(
      [group('s1', 'float', readings)],
      meta({ s1: { name: 'Bohrtiefe' } }),
      { ...GRID, rowsPerChunk: 10 },
    );
    expect(plan.chunks.map((c) => c.rows)).toEqual([10, 10, 5]);
  });

  it('gives every chunk its own header', () => {
    const readings: [number, number][] = [];
    for (let i = 0; i < 4; i++) readings.push([i * 1000, i]);
    const plan = planCsvUpload(
      [group('s1', 'float', readings)],
      meta({ s1: { name: 'Bohrtiefe' } }),
      { ...GRID, rowsPerChunk: 2 },
    );
    for (const chunk of plan.chunks) {
      expect(chunk.csv.startsWith('Zeitpunkt;Bohrtiefe')).toBe(true);
    }
  });

  it('leaves a sensor out of the chunks it has no value in', () => {
    // Verpressen-only sensor: a column present in the Bohren chunks would
    // contribute an empty cell — a written NULL — to every one of their rows.
    const plan = planCsvUpload(
      [
        group('s1', 'float', [[0, 1], [1000, 1], [60_000, 1], [61_000, 1]]),
        group('s2', 'float', [[60_000, 9], [61_000, 9]]),
      ],
      meta({ s1: { name: 'Bohrtiefe' }, s2: { name: 'Q_verpressen' } }),
      { ...GRID, rowsPerChunk: 2 },
    );
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0].columns).toEqual(['Bohrtiefe']);
    expect(plan.chunks[1].columns).toEqual(['Bohrtiefe', 'Q_verpressen']);
  });

  it('accounts for every reading exactly once across all chunks', () => {
    const readings: [number, number][] = [];
    for (let i = 0; i < 50; i++) readings.push([i * 250, i]);
    const groups = [group('s1', 'float', readings)];
    const plan = planCsvUpload(groups, meta({ s1: { name: 'Bohrtiefe' } }), {
      ...GRID, rowsPerChunk: 3,
    });
    const ids = plan.chunks.flatMap((c) => c.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort((a, b) => a - b)).toEqual(groups[0].readings.map((r) => r.id));
  });

  it('produces no chunks for a session with nothing griddable', () => {
    const plan = planCsvUpload(
      [group('s1', 'string', [[0, 'Hallo']])],
      meta({ s1: { name: 'Kommentar' } }),
      GRID,
    );
    expect(plan.chunks).toEqual([]);
    expect(plan.leftovers).toHaveLength(1);
  });

  it('defaults to a chunk size that keeps a 2 h session to a handful of requests', () => {
    // 7 799 rows at a 1 s grid is what the captured session reduces to.
    expect(Math.ceil(7799 / CHUNK_ROWS)).toBeLessThanOrEqual(10);
  });
});

// ── pinning the depth readings a geology boundary points at ─────────────────

describe('pinAnchorReadings', () => {
  const depth = {
    sensorId: 's-tiefe',
    sensorType: 'float',
    name: 'Bohrtiefe',
    readings: [0, 290, 580, 870].map((o) => ({ receivedAt: T0 + o, value: 1 + o / 1000 })),
  };

  it('picks exactly the readings a boundary was dated at', () => {
    // A GeoDIN entry carries no depth of its own: implenia-web recovers the
    // layer's depth by pairing the two series on millisecond equality. The grid
    // re-dates the depth series, so the readings the boundaries point at have
    // to reach the platform at their own instants as well.
    const batch = pinAnchorReadings([T0 + 290, T0 + 580], depth)!;
    expect(batch.sensorId).toBe('s-tiefe');
    expect(batch.sensorType).toBe('float');
    expect(batch.readings.map((r) => r.receivedAt)).toEqual([T0 + 290, T0 + 580]);
  });

  it('sends the recorded value, never an interpolated one', () => {
    // The exact value exists — the boundary was dated at a real reading. There
    // is nothing to estimate.
    const batch = pinAnchorReadings([T0 + 580], depth)!;
    expect(batch.readings).toEqual([{ receivedAt: T0 + 580, value: 1.58 }]);
  });

  it('is nothing for a Verfahren with no geology', () => {
    expect(pinAnchorReadings([], depth)).toBeNull();
  });

  it('is nothing when the session has no depth sensor', () => {
    expect(pinAnchorReadings([T0 + 290], null)).toBeNull();
  });

  it('is nothing when no depth reading matches — nothing to pin, nothing to send', () => {
    expect(pinAnchorReadings([T0 + 123], depth)).toBeNull();
  });

  it('ignores an instant with no reading rather than inventing one', () => {
    const batch = pinAnchorReadings([T0 + 290, T0 + 123], depth)!;
    expect(batch.readings.map((r) => r.receivedAt)).toEqual([T0 + 290]);
  });
});

// ── reading the platform's answer ───────────────────────────────────────────

describe('csvChunkProblem', () => {
  const chunk: CsvChunk = {
    csv: '', ids: [1, 2], rows: 2, columns: ['Bohrtiefe', 'Drehzahl'],
  };

  it('accepts a response that processed every row', () => {
    expect(csvChunkProblem(chunk, {
      success: true, rows_processed: 2, values_inserted: 4, failed_count: 0,
    })).toBeNull();
  });

  it('rejects a 200 whose columns the platform could not match', () => {
    // The endpoint addresses sensors by name and reports the misses instead of
    // failing, so this is the one check that stops a column going nowhere.
    const problem = csvChunkProblem(chunk, {
      success: true, rows_processed: 2, unknown_sensors: ['Drehzahl'],
    });
    expect(problem).toMatch(/Drehzahl/);
  });

  it('ignores an unknown column that is not one of ours', () => {
    expect(csvChunkProblem(chunk, {
      success: true, rows_processed: 2, unknown_sensors: ['Irgendwas'],
    })).toBeNull();
  });

  it('rejects a response that failed outright', () => {
    expect(csvChunkProblem(chunk, { success: false, errors: ['insert error'] }))
      .toMatch(/insert error/);
  });

  it('rejects a response that lost values', () => {
    expect(csvChunkProblem(chunk, { success: true, rows_processed: 2, failed_count: 3 }))
      .toMatch(/3/);
  });

  it('rejects a response that processed fewer rows than were sent', () => {
    expect(csvChunkProblem(chunk, { success: true, rows_processed: 1 }))
      .toMatch(/1 von 2/);
  });

  it('rejects a missing response', () => {
    expect(csvChunkProblem(chunk, null)).not.toBeNull();
  });
});
