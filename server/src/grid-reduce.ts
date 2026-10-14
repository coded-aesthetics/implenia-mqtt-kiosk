/**
 * Time-grid reduction of a recorded session.
 *
 * The rigs publish far faster than they measure. Over the 2 h 10 m G08 capture
 * (`assets/bohrung_g8.txt`) the ten drilling channels arrive every ~290 ms and
 * the four pump channels every ~3 s — 275 935 readings on 274 475 *distinct
 * milliseconds*, because every MQTT message is stamped with its own
 * `Date.now()` (mqtt.ts). Laid out as a table that is one row per instant and
 * one column per sensor, 92.8 % of the cells are empty: the xlsx came to 274 475
 * rows and 12.4 MB, took 41 s to build and peaked at 1.6 GB of heap — on a
 * 4 GB J1900 kiosk that is an export the worker cannot complete. At a 1 s grid
 * the same session is 7 799 rows, 0.6 MB and one second of work.
 *
 * Between 58 % and 90 % of the readings per channel are *exact repeats* of the
 * previous value, so this is a high publish rate rather than a high sampling
 * rate, and a grid costs almost nothing. "Almost" is the reason for every rule
 * below.
 *
 * **Last value in the bucket, never a mean.** A mean invents numbers the rig
 * never reported, and two channels in that capture show why that is not
 * pedantic: `Klemmdruck` is bimodal at ~1650 open / ~4200 closed, and its 1 s
 * mean lands in the physically impossible 2500–4200 band in 35 buckets — a
 * value the clamp cannot produce. `Tiefe` steps by a whole Bohrrohr during a
 * Rohrverlängerung, and its 1 s mean sits up to 1.0 m away from every sample in
 * the bucket. The volume channels are monotonic counters, where a mean is
 * simply the wrong number. Taking the last value means every cell is a value
 * the machine actually sent.
 *
 * **The row's instant is a real reading's instant too** — the newest one in the
 * bucket — not the synthetic bucket boundary. Nothing downstream then has to
 * trust a timestamp no sensor ever reported, and a reading keeps a timestamp it
 * can be found under: `session_readings` still holds the full-resolution data,
 * so a row can be traced back to it.
 *
 * **Forward-fill is bounded.** Filling a gap says "this value still held",
 * which is true of a rig that re-publishes an unchanged value three times a
 * second and false of one that stopped answering. `maxHoldMs` is where the
 * claim stops: the 3 s pumps fill into every 1 s row, a dead sensor leaves the
 * cell empty, and a sensor the operator set once (a mode flag) does not get
 * stamped onto thousands of rows.
 *
 * **A null is a gap, and gaps are not carried.** `null` means the sensor had
 * nothing to report — the kiosk's existing outage marker (see `uploadValue` in
 * recording.ts). It is emitted in the bucket it was recorded in and then stops
 * the fill, so the value from before an outage is never carried across it.
 */

/** One recorded value on its way into the grid. */
export interface GridReading<K> {
  /** Column this value belongs to — a sensor id for the upload, a name for the export. */
  key: K;
  receivedAt: number;
  value: number | string | null;
  /**
   * The caller's handle on the source row, collected into the row that
   * represents it. The upload uses `session_readings.id` so a chunk can mark
   * exactly the readings it accounted for.
   */
  id?: number;
}

export interface GridOptions {
  /** Bucket width in milliseconds. Must be > 0 — see `reduceToGrid`. */
  bucketMs: number;
  /**
   * How long a value may be carried into later rows. Measured from the
   * reading's own instant to the row's. A value inside its own bucket is always
   * emitted, whatever this says.
   */
  maxHoldMs: number;
}

export interface GridRow<K> {
  /** The newest reading's instant in this bucket. A real recorded instant. */
  at: number;
  /** Column → value. A column is absent when nothing is known for it here. */
  values: Map<K, number | string | null>;
  /**
   * Every source reading that fell in this bucket, including the ones a later
   * value in the same bucket superseded. They are represented by this row, so
   * the caller accounts for them when the row is dealt with — the same bargain
   * the per-sensor upload already makes when it dedups by timestamp and then
   * marks every pending id of the group.
   */
  ids: number[];
}

interface Cell {
  value: number | string | null;
  at: number;
}

/**
 * Reduce readings to one row per `bucketMs`, newest value per column.
 *
 * Input order does not matter: buckets are keyed by instant and the newest
 * reading wins within one, so a caller may concatenate per-sensor series
 * without interleaving them. Readings sharing a millisecond resolve to the last
 * one seen, which is what the per-sensor upload's own deduplication does.
 */
export function reduceToGrid<K>(
  readings: Iterable<GridReading<K>>,
  options: GridOptions,
): GridRow<K>[] {
  const { bucketMs, maxHoldMs } = options;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new Error(`Ungültige Auflösung: ${bucketMs} ms`);
  }

  const buckets = new Map<number, { at: number; cells: Map<K, Cell>; ids: number[] }>();
  for (const r of readings) {
    const index = Math.floor(r.receivedAt / bucketMs);
    let bucket = buckets.get(index);
    if (!bucket) {
      bucket = { at: r.receivedAt, cells: new Map(), ids: [] };
      buckets.set(index, bucket);
    }
    if (r.receivedAt > bucket.at) bucket.at = r.receivedAt;
    const prev = bucket.cells.get(r.key);
    if (prev === undefined || r.receivedAt >= prev.at) {
      bucket.cells.set(r.key, { value: r.value, at: r.receivedAt });
    }
    if (r.id !== undefined) bucket.ids.push(r.id);
  }

  // Insertion order is first appearance across the session, which keeps the
  // emitted column order stable for a given input.
  const carry = new Map<K, Cell>();
  const rows: GridRow<K>[] = [];

  for (const index of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const bucket = buckets.get(index)!;
    for (const [key, cell] of bucket.cells) carry.set(key, cell);

    const values = new Map<K, number | string | null>();
    for (const [key, cell] of carry) {
      const own = bucket.cells.has(key);
      if (cell.value === null) {
        // The outage is reported where it was recorded and never carried: a
        // value from before it must not reappear after it, and repeating the
        // null on every later row would write an outage per row for as long as
        // the sensor stays dead.
        if (own) values.set(key, null);
        continue;
      }
      if (!own && bucket.at - cell.at > maxHoldMs) continue;
      values.set(key, cell.value);
    }

    rows.push({ at: bucket.at, values, ids: bucket.ids });
  }

  return rows;
}

/**
 * The columns a set of grid rows actually carries, in first-appearance order.
 *
 * Used to give each upload chunk its own header: a sensor that only records
 * during Verpressen is then simply not a column in the Bohren chunks, instead
 * of contributing an empty cell to every one of their rows. An empty cell is
 * not "no data" to the platform's CSV endpoint — it inserts a NULL — so a
 * column that is empty throughout a chunk would otherwise write one fabricated
 * outage per row.
 */
export function gridColumns<K>(rows: GridRow<K>[]): K[] {
  const seen = new Set<K>();
  const columns: K[] = [];
  for (const row of rows) {
    for (const key of row.values.keys()) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}
