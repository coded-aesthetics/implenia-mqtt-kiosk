import { describe, it, expect } from 'vitest';
import { gridColumns, reduceToGrid, type GridReading } from './grid-reduce.js';

const T0 = Date.parse('2026-05-18T12:00:00.000Z');

function g(
  key: string, offsetMs: number, value: number | string | null, id?: number,
): GridReading<string> {
  return { key, receivedAt: T0 + offsetMs, value, id };
}

const SECOND = { bucketMs: 1000, maxHoldMs: 4000 };

describe('reduceToGrid', () => {
  it('collapses a second of readings into one row', () => {
    const rows = reduceToGrid(
      [g('tiefe', 0, 1), g('tiefe', 290, 2), g('tiefe', 580, 3), g('tiefe', 870, 4)],
      SECOND,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values.get('tiefe')).toBe(4);
  });

  it('keeps the last value in the bucket, never an average', () => {
    // The Klemmdruck case: bimodal at ~1650 open / ~4200 closed, so a mean
    // lands on a pressure the clamp cannot produce.
    const rows = reduceToGrid([g('klemm', 0, 1650), g('klemm', 500, 4200)], SECOND);
    expect(rows[0].values.get('klemm')).toBe(4200);
  });

  it('dates the row at the newest reading in the bucket, not the bucket edge', () => {
    const rows = reduceToGrid([g('a', 120, 1), g('b', 870, 2)], SECOND);
    expect(rows[0].at).toBe(T0 + 870);
  });

  it('starts a new row for each bucket', () => {
    const rows = reduceToGrid(
      [g('tiefe', 0, 1), g('tiefe', 1200, 2), g('tiefe', 2400, 3)],
      SECOND,
    );
    expect(rows.map((r) => r.values.get('tiefe'))).toEqual([1, 2, 3]);
  });

  it('does not care about input order', () => {
    const ordered = reduceToGrid([g('a', 0, 1), g('a', 500, 2), g('b', 100, 9)], SECOND);
    const shuffled = reduceToGrid([g('b', 100, 9), g('a', 500, 2), g('a', 0, 1)], SECOND);
    expect(shuffled).toEqual(ordered);
  });

  it('resolves two readings on one millisecond to the last one seen', () => {
    const rows = reduceToGrid([g('a', 300, 1), g('a', 300, 2)], SECOND);
    expect(rows[0].values.get('a')).toBe(2);
  });

  // ── forward-fill ──────────────────────────────────────────────────────────

  it('carries a slow sensor into the rows between its readings', () => {
    // The pump case: ~3 s between readings, so two of every three 1 s rows
    // have nothing of their own.
    const readings = [
      g('tiefe', 0, 1), g('tiefe', 1000, 2), g('tiefe', 2000, 3), g('tiefe', 3000, 4),
      g('pumpe', 0, 70), g('pumpe', 3000, 71),
    ];
    const rows = reduceToGrid(readings, SECOND);
    expect(rows.map((r) => r.values.get('pumpe'))).toEqual([70, 70, 70, 71]);
  });

  it('stops carrying once maxHoldMs has passed', () => {
    const readings = [
      g('tot', 0, 5),
      g('leben', 1000, 1), g('leben', 2000, 1), g('leben', 3000, 1),
      g('leben', 4000, 1), g('leben', 5000, 1), g('leben', 6000, 1),
    ];
    const rows = reduceToGrid(readings, SECOND);
    // Held through the 4 s window, absent afterwards — not frozen forever.
    expect(rows.map((r) => r.values.get('tot'))).toEqual([5, 5, 5, 5, 5, undefined, undefined]);
  });

  it('emits a value in its own bucket however short the hold is', () => {
    const rows = reduceToGrid([g('a', 0, 1), g('b', 900, 2)], { bucketMs: 1000, maxHoldMs: 0 });
    expect(rows[0].values.get('a')).toBe(1);
    expect(rows[0].values.get('b')).toBe(2);
  });

  // ── gaps ──────────────────────────────────────────────────────────────────

  it('reports a recorded gap in the bucket it happened in', () => {
    const rows = reduceToGrid([g('a', 0, 1), g('a', 1000, null)], SECOND);
    expect(rows[1].values.get('a')).toBeNull();
  });

  it('never carries a gap, and never carries a value across one', () => {
    const readings = [
      g('a', 0, 1), g('a', 1000, null),
      g('b', 0, 1), g('b', 1000, 1), g('b', 2000, 1), g('b', 3000, 1),
    ];
    const rows = reduceToGrid(readings, SECOND);
    // The outage is stated once; the value from before it does not reappear.
    expect(rows.map((r) => r.values.get('a'))).toEqual([1, null, undefined, undefined]);
  });

  it('resumes carrying once the sensor reports again', () => {
    const readings = [g('a', 0, 1), g('a', 1000, null), g('a', 2000, 7), g('a', 3500, 7)];
    const rows = reduceToGrid(readings, SECOND);
    expect(rows.map((r) => r.values.get('a'))).toEqual([1, null, 7, 7]);
  });

  // ── ids ───────────────────────────────────────────────────────────────────

  it('assigns every source reading to exactly one row, superseded ones included', () => {
    const readings = [
      g('a', 0, 1, 10), g('a', 500, 2, 11), g('a', 1200, 3, 12),
      g('b', 100, 9, 20),
    ];
    const rows = reduceToGrid(readings, SECOND);
    expect(rows[0].ids.sort()).toEqual([10, 11, 20]);
    expect(rows[1].ids).toEqual([12]);
    const all = rows.flatMap((r) => r.ids).sort();
    expect(all).toEqual([10, 11, 12, 20]);
  });

  it('does not re-claim a carried reading in the row it was filled into', () => {
    const readings = [g('pumpe', 0, 70, 1), g('tiefe', 1000, 5, 2)];
    const rows = reduceToGrid(readings, SECOND);
    expect(rows[1].values.get('pumpe')).toBe(70);
    expect(rows[1].ids).toEqual([2]);
  });

  // ── edges ─────────────────────────────────────────────────────────────────

  it('returns nothing for no readings', () => {
    expect(reduceToGrid([], SECOND)).toEqual([]);
  });

  it('refuses a bucket width that is not a positive number', () => {
    expect(() => reduceToGrid([g('a', 0, 1)], { bucketMs: 0, maxHoldMs: 0 })).toThrow();
    expect(() => reduceToGrid([g('a', 0, 1)], { bucketMs: -1, maxHoldMs: 0 })).toThrow();
    expect(() => reduceToGrid([g('a', 0, 1)], { bucketMs: NaN, maxHoldMs: 0 })).toThrow();
  });

  it('carries text values like any other', () => {
    const rows = reduceToGrid(
      [g('mode', 0, 'bohren'), g('tiefe', 1000, 1), g('mode', 2000, 'verpressen')],
      SECOND,
    );
    expect(rows.map((r) => r.values.get('mode'))).toEqual(['bohren', 'bohren', 'verpressen']);
  });

  it('invents no row for a bucket in which nothing was recorded', () => {
    // A row exists because readings fell in its bucket. A quiet minute is
    // absent from the file rather than filled with carried values, so nothing
    // downstream reads a stalled rig as a running one.
    const rows = reduceToGrid([g('a', 0, 1), g('a', 60_000, 2)], SECOND);
    expect(rows).toHaveLength(2);
    expect(rows[1].at).toBe(T0 + 60_000);
  });

  it('keeps a monotonic counter monotonic', () => {
    // A mean would make a volume counter go backwards relative to its own last
    // reading; last-value cannot.
    const readings = [
      g('vol', 0, 100), g('vol', 400, 140), g('vol', 800, 180),
      g('vol', 1200, 220), g('vol', 1600, 260),
    ];
    const values = reduceToGrid(readings, SECOND).map((r) => r.values.get('vol') as number);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values).toEqual([180, 260]);
  });
});

describe('gridColumns', () => {
  it('lists the columns in first-appearance order', () => {
    const rows = reduceToGrid([g('b', 0, 1), g('a', 100, 2), g('c', 2000, 3)], SECOND);
    expect(gridColumns(rows)).toEqual(['b', 'a', 'c']);
  });

  it('omits a column that has no value in the given rows', () => {
    const rows = reduceToGrid(
      [g('früh', 0, 1), g('spät', 60_000, 2)],
      SECOND,
    );
    // The second row is a minute later: the first sensor is long past its hold.
    expect(gridColumns(rows.slice(1))).toEqual(['spät']);
  });

  it('counts a gap as a column — it is a value the platform must be told', () => {
    const rows = reduceToGrid([g('a', 0, null)], SECOND);
    expect(gridColumns(rows)).toEqual(['a']);
  });
});
