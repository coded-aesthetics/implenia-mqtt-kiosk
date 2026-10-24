import { describe, it, expect } from 'vitest';
import {
  CHUNK_ROWS, csvChunkProblem, isGriddableSensor, planCsvUpload,
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

/**
 * Sensor metadata as a session pins it. `source` defaults to `mqtt` because
 * that is what the machine's telemetry carries and what most of these fixtures
 * are; the cases that turn on the source say so explicitly.
 */
const meta = (entries: Record<string, UploadSensorMeta>) =>
  new Map(Object.entries(entries).map(
    ([id, m]) => [id, { source: 'mqtt', ...m }] as const,
  ));

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
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Bohrtiefe', source: 'mqtt' }))
      .toBe(true);
  });

  it('refuses a string sensor — an empty cell there writes an empty string', () => {
    expect(isGriddableSensor({ sensorType: 'string' }, { name: 'Kommentar', source: 'user' }))
      .toBe(false);
  });

  it('refuses an operator-entered sensor, however numeric it is', () => {
    // `Status` is the case that cost a protocol. Four readings in a 2 h
    // recording, so the grid left 341 of 354 cells empty — and an empty cell
    // inserts a NULL. implenia-web forward-fills Status and a present-but-null
    // row overwrites the carry, so its phase detection kept a single row: no
    // duration, no phase averages, and a zero-width Bohren window that left
    // the protocol with no observed geology at all.
    expect(isGriddableSensor({ sensorType: 'int' }, { name: 'Status', source: 'user', role: 'mode' }))
      .toBe(false);
  });

  it('accepts a kiosk-derived volume — one per pump reading, not per event', () => {
    // The kiosk integrates a volume from every pump reading, so these arrive
    // on the machine's cadence. DSV declares thirteen of them.
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Q_verpressen', source: 'kiosk' }))
      .toBe(true);
  });

  it('refuses a platform-computed sensor', () => {
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Fusspunkt X Ist', source: 'server' }))
      .toBe(false);
  });

  it('refuses a sensor whose source the session never pinned', () => {
    // Not knowing is not the same as knowing it is telemetry. The per-sensor
    // route costs bandwidth; the grid would cost the truth.
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Bohrtiefe' })).toBe(false);
  });

  it('refuses the committed geology profile — it is one value, not a series', () => {
    // A string sensor can never take this route: an empty cell writes an empty
    // string rather than a NULL. The profile is additionally dated at a
    // sentinel, so it is not session data at all.
    expect(isGriddableSensor(
      { sensorType: 'string' },
      { name: 'Geologieprofil', source: 'kiosk', role: 'geology_profile' },
    )).toBe(false);
  });

  it('refuses the completion stamp', () => {
    expect(
      isGriddableSensor(
        { sensorType: 'string' },
        { name: 'Ausführungsdatum', source: 'user', role: 'is_completed' },
      ),
    ).toBe(false);
  });

  it('accepts the depth sensor, which nothing points into any more', () => {
    // It carries the biggest channel of the session. A geology boundary used
    // to borrow one of its readings' instants, so gridding it moved the
    // reading a layer pointed at; a committed layer states its own depth, so
    // the series reduces like any other.
    expect(isGriddableSensor(
      { sensorType: 'float' }, { name: 'Bohrtiefe', source: 'mqtt', role: 'depth' },
    )).toBe(true);
  });

  it('refuses a name the platform stores with padding', () => {
    // The endpoint trims what it reads from the header, so such a column
    // matches nothing there and the mismatch comes back under a spelling we
    // never sent. It takes the id-addressed route instead.
    expect(isGriddableSensor({ sensorType: 'float' }, { name: 'Bohrtiefe ', source: 'mqtt' }))
      .toBe(false);
  });

  it('refuses a sensor the session never recorded a name for', () => {
    // The map is keyed by the lowercased name, so the real spelling is not
    // recoverable — and the CSV header is the only way to address a column.
    expect(isGriddableSensor({ sensorType: 'float' }, { role: 'depth', source: 'mqtt' }))
      .toBe(false);
    expect(isGriddableSensor({ sensorType: 'float' }, undefined)).toBe(false);
  });
});

// ── planning ────────────────────────────────────────────────────────────────

describe('planCsvUpload', () => {
  it('puts the telemetry in the CSV and leaves the rest to the per-sensor path', () => {
    const groups = [
      group('s-rpm', 'float', [[0, 60]]),
      group('s-tiefe', 'float', [[0, 1.5]]),
      group('s-status', 'int', [[0, 0]]),
      group('s-kommentar', 'string', [[0, 'Hindernis']]),
    ];
    const plan = planCsvUpload(groups, meta({
      's-rpm': { name: 'Drehzahl', role: 'rpm' },
      's-tiefe': { name: 'Bohrtiefe', role: 'depth' },
      's-status': { name: 'Status', source: 'user', role: 'mode' },
      's-kommentar': { name: 'Kommentar' },
    }), GRID);

    expect(plan.gridded).toEqual(['Drehzahl', 'Bohrtiefe']);
    expect(plan.leftovers.map((g) => g.sensorId)).toEqual(['s-status', 's-kommentar']);
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
    expect(problem?.message).toMatch(/Drehzahl/);
    // A name is permanent: no retry of this route resolves it.
    expect(problem?.structural).toBe(true);
  });

  it('recognises one of ours reported back under its trimmed spelling', () => {
    // The platform matches header cells with TrimSpace and reports the trimmed
    // name. Comparing untrimmed let the chunk pass every check and be marked
    // uploaded with that sensor's whole series nowhere on the platform.
    const padded: CsvChunk = { csv: '', ids: [1], rows: 2, columns: ['Bohrtiefe '] };
    const problem = csvChunkProblem(padded, {
      success: true, rows_processed: 2, unknown_sensors: ['Bohrtiefe'],
    });
    expect(problem?.message).toMatch(/Bohrtiefe/);
    expect(problem?.structural).toBe(true);
  });

  it('ignores an unknown column that is not one of ours', () => {
    expect(csvChunkProblem(chunk, {
      success: true, rows_processed: 2, unknown_sensors: ['Irgendwas'],
    })).toBeNull();
  });

  it('rejects a response that understood no row at all, and calls it structural', () => {
    // No row parsed is the body, not the link — an unmatched header or a
    // timestamp column it cannot read. The endpoint answers it as a 422
    // carrying this very shape.
    const problem = csvChunkProblem(chunk, {
      success: false, rows_processed: 0, errors: ['no matching sensors found'],
    });
    expect(problem?.message).toMatch(/no matching sensors/);
    expect(problem?.structural).toBe(true);
  });

  it('rejects a response that lost values without calling it structural', () => {
    // `failed_count` is the platform's own insert error — a bad minute in its
    // database, served as a 422 all the same. Falling back on it would put the
    // whole session back on the mobile link as JSON.
    const problem = csvChunkProblem(chunk, {
      success: false, rows_processed: 2, failed_count: 3, errors: ['insert error'],
    });
    expect(problem?.message).toMatch(/3/);
    expect(problem?.structural).toBe(false);
  });

  it('rejects a response that processed fewer rows than were sent', () => {
    const problem = csvChunkProblem(chunk, { success: true, rows_processed: 1 });
    expect(problem?.message).toMatch(/1 von 2/);
    expect(problem?.structural).toBe(false);
  });

  it('rejects a missing response as a transport failure, not a structural one', () => {
    const problem = csvChunkProblem(chunk, null);
    expect(problem).not.toBeNull();
    expect(problem?.structural).toBe(false);
  });
});
