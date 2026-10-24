/**
 * Uploading a session's measurements as CSV, in chunks.
 *
 * The per-sensor path posts one JSON batch per sensor to
 * `/api/v1/sensor-<type>/<id>/batch`. On the captured G08 session that is
 * 15.7 MB of JSON in 64 requests, because every reading carries its own ISO
 * timestamp and its own object. The same session on a 1 s grid is 0.85 MB of
 * CSV — one timestamp per row instead of per value — posted to
 * `/api/v1/measuring-device/<device_id>/readings/batch/csv`, which the platform
 * reads column-wise and upserts on `(sensor_id, date)`.
 *
 * **Chunked by rows, not sent as one file.** The endpoint takes 50 MB and the
 * whole session would fit in a single request, but a single request is also a
 * single failure: a dropped mobile link would cost the entire upload and leave
 * the progress bar with nothing to report between start and finish. One request
 * per `CHUNK_ROWS` rows keeps the bar moving, limits a failure to the readings
 * of that chunk, and retries cleanly — the upsert makes a re-sent chunk a
 * no-op.
 *
 * **Not every sensor can go this way.** A CSV is one table, so a column gets a
 * cell on every row of its chunk, and an empty cell *inserts a NULL* — the
 * kiosk's own marker for a sensor outage. For the drilling telemetry that is
 * exactly right: the grid is dense, and a genuinely dead channel should read as
 * dead. For three kinds of sensor it is not, and they keep the per-sensor path:
 *
 *   - **String sensors** (`Kommentar`, `Geologieprofil`, `logs`,
 *     `Ausführungsdatum`). An empty cell writes an empty *string*, not a NULL,
 *     and for `Ausführungsdatum` an empty string is the documented way to
 *     *un-complete* an element (see CLAUDE.md). A comment belongs at the
 *     instant it was dictated, not at a grid row.
 *   - **`Ausführungsdatum`** (role `is_completed`), which is a single
 *     overwritable slot at a sentinel date and is not session data at all.
 *
 * The depth series used to need protecting too, because a `GeoDIN` boundary
 * borrowed its instant from a depth reading and gridding that series moved the
 * reading the boundary pointed at. A committed profile is one value in which
 * every layer carries its own depth, so nothing points into the depth series
 * and it grids like any other channel.
 *
 * Both halves of a session therefore upload, and `sensorsFailed` counts across
 * both: the element is only completed when nothing was left behind.
 */

import { TIMESTAMP_COLUMN } from './session-export.js';
import { gridColumns, reduceToGrid, type GridReading, type GridRow } from './grid-reduce.js';
import type { SessionUploadGroup } from './db.js';

/**
 * Rows per request. Small enough that a failure costs little and the progress
 * bar moves several times even on a short session, large enough that a 2 h
 * recording at a 1 s grid is eight requests rather than eight hundred. At
 * fourteen columns a chunk is roughly 110 KB — far inside the endpoint's 50 MB.
 */
export const CHUNK_ROWS = 1000;

/**
 * Semicolon, the German CSV separator.
 *
 * The platform detects the separator by counting tabs, semicolons and commas in
 * the header and taking the most frequent, so this has to be the one that
 * cannot appear in a sensor name. Commas can: the shared CSVs are comma
 * separated themselves, but a name like `Druck, innen` added upstream would
 * turn a comma-separated upload into mis-aligned columns. It also makes the
 * platform's German-decimal handling unambiguous, though this writer emits
 * dots.
 */
const SEP = ';';

/** What the session's `sensor_map` knows about one sensor. */
export interface UploadSensorMeta {
  /** The platform's spelling of the name. The CSV header addresses it by this. */
  name?: string;
  /** The role pinned into the session when recording began. */
  role?: string;
  /** `float` | `int` | `string`, for the per-sensor endpoint's path. */
  type?: string;
  /**
   * Where the sensor's values come from — `mqtt`, `kiosk`, `user`, `server`.
   *
   * Pinned into the session like the role, and resolved from the local CSVs by
   * name for sessions recorded before it was. `undefined` means "not known",
   * which is not the same as "not mqtt": see `GRIDDABLE_SOURCES`.
   */
  source?: string;
}

/**
 * Roles whose every reading has to keep the instant it was recorded at.
 *
 * Not a style preference: a grid merges readings, and for these a merge is a
 * lost completion stamp or a lost profile. See the module comment.
 *
 * `geology_profile` is the one of the two that actually reaches
 * `session_readings` today — one value at a sentinel instant, which a grid
 * would date at a bucket and a chunk would pad with empty cells. It is already
 * refused for being a string sensor, and that is the accident: the type is a
 * property of this Verfahren's CSV, the sentinel is a property of the
 * contract. `is_completed` is here for the documented reason rather than a
 * live one — `element-completion.ts` posts it straight to the platform.
 */
export const EXACT_TIMESTAMP_ROLES = new Set(['is_completed', 'geology_profile']);

export interface CsvChunk {
  /** The request body, header included. */
  csv: string;
  /** Source readings this chunk accounts for — marked together, succeed or fail. */
  ids: number[];
  rows: number;
  /** Sensor names in the header, in column order. For the unknown-column check. */
  columns: string[];
}

export interface CsvUploadPlan {
  chunks: CsvChunk[];
  /** Sensors that must keep their own instants — uploaded the per-sensor way. */
  leftovers: SessionUploadGroup[];
  /** Sensor names that went into the CSV, for logging. */
  gridded: string[];
}

/**
 * Sources whose channels a grid may thin — the machine's own telemetry, and
 * nothing else.
 *
 * This is the rule that decides what an *absent* cell means, which a CSV cannot
 * say. A column gets a cell on every row of its chunk, and an empty cell
 * inserts a NULL: the kiosk's own marker for "the sensor had nothing to
 * report".
 *
 * For an `mqtt` channel that is honest. It publishes every ~290 ms (every ~3 s
 * for the pumps), so a 1 s row with no value of its own and nothing inside
 * `maxHoldMs` behind it means the channel really did go quiet for four
 * seconds, and a NULL is what the per-sensor path would have written too.
 *
 * `kiosk` is in here for the same reason rather than by charity: those are the
 * volume integrations, and the kiosk derives one from *every* pump reading, so
 * they arrive on the machine's cadence (2 587 of them in the captured session,
 * against 26 699 depth readings — the ~3 s pumps). Excluding them would cost
 * DSV, which declares thirteen, most of its derived channels for nothing.
 *
 * `user` is where it is a lie, because those values are *events*.
 * Injektionsbohren's `Status` (`Quelle=user`, role `mode`) is the case that
 * cost a whole protocol: the operator steps the phase four times in a shift,
 * so a 2 h recording holds four readings, the grid gives it a value in 13 rows
 * of 354 — and the remaining 341 cells uploaded as 341 fabricated outages.
 * implenia-web forward-fills `Status` (`forwardFillSensors`, engine.ts) and a
 * present-but-null row *overwrites* the carried value, so from the first
 * fabricated NULL onwards no row matched `Status === 0`: `detectPhases` kept
 * one single row, `beginn_bohren` equalled `ende_bohren`, the duration and
 * every phase average went empty, and the Bohren window collapsed to zero
 * width — which left `herstellungLayersFromRows` nothing to read and printed
 * the protocol with its Vorgabe geology and no observed layers at all. Uploaded
 * cleanly, 186 NULLs on a sensor that was never once unhealthy.
 *
 * A `user` sensor is therefore not merely *allowed* to keep its own instants,
 * it has to: four readings addressed by id is both the smaller upload and the
 * only one that says what happened. `server` stays out as well — nothing but
 * `GeoDIN` was ever recorded under it, and nothing writes that any more.
 *
 * An unknown source is treated as not griddable. The per-sensor route always
 * works and costs bandwidth; this one silently rewrites history.
 *
 * **What this still does not catch.** The question the grid really wants
 * answered is "does this channel produce a value on every machine reading, or
 * only on an event", and a `Quelle` answers it only by proxy. A phase-limited
 * `kiosk` channel — DSV's `Volumen Vorschnitt` and friends — is dense inside
 * its phase and absent outside it, so the chunk that straddles the transition
 * writes a handful of fabricated NULLs. That is bounded and cosmetic where
 * `Status` was unbounded and fatal (nothing in web forward-fills a volume), so
 * it is left as it is. The complete fix is to drop a column from the one chunk
 * it is not dense in and send those readings per-sensor, which means moving
 * reading ids between a chunk and the leftovers — worth doing deliberately,
 * not as a rider on a bug fix.
 */
export const GRIDDABLE_SOURCES = new Set(['mqtt', 'kiosk']);

/**
 * Whether a sensor's readings may be put on a grid and addressed by name.
 *
 * Two of the three exclusions are about what a grid *merges*, and one is about
 * how the CSV addresses a column:
 *
 *   - a source that is not the machine's own telemetry — see
 *     `GRIDDABLE_SOURCES`, which is also why `GeoDIN` (`server`) and the
 *     string sensors (`user`) would fall out even without their own rules;
 *   - a role whose every reading has to keep its instant
 *     (`EXACT_TIMESTAMP_ROLES`), kept explicit because it is the *documented*
 *     reason rather than a side effect of the source check above it;
 *   - a sensor with no name in the session map. The CSV header is the only way
 *     to address a column, and the map is keyed by the *lowercased* name, from
 *     which the real spelling is not recoverable (see CLAUDE.md, "Sensor roles
 *     are pinned to the session"). Rather than write to `ausführungsdatum` and
 *     hope, such a sensor takes the per-sensor path, which addresses it by id.
 */
export function isGriddableSensor(
  group: Pick<SessionUploadGroup, 'sensorType'>,
  meta: UploadSensorMeta | undefined,
): boolean {
  if (group.sensorType === 'string') return false;
  if (!meta?.name) return false;
  // A name the platform stores with padding cannot be addressed by a CSV
  // header: the endpoint trims what it reads, so the column matches nothing,
  // and the mismatch is invisible to `csvChunkProblem` unless it trims too
  // (it does). Rather than rely on that one check, such a sensor takes the
  // id-addressed route, where the spelling never has to survive a round trip.
  if (meta.name !== meta.name.trim()) return false;
  if (!meta.source || !GRIDDABLE_SOURCES.has(meta.source)) return false;
  if (meta.role && EXACT_TIMESTAMP_ROLES.has(meta.role)) return false;
  return true;
}

/**
 * The value of a recorded reading as a numeric column, or `null` for a gap.
 *
 * The same rule `uploadValue` applies on the per-sensor path, and for the same
 * reason: a reading recorded before a non-finite spelling was recognised sits
 * in `value_text` as something like `nan`, and a column of numbers must not be
 * handed it. A value that is not a finite number is a gap, which is what it
 * means — the rig had nothing to report.
 */
function numericValue(r: { valueNumeric: number | null; valueText: string | null }): number | null {
  const raw = r.valueNumeric ?? r.valueText ?? null;
  if (raw === null) return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

/** Quote a field only where it would otherwise break the row. */
function csvField(value: string): string {
  if (!/[";\r\n]/.test(value)) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

function serializeChunk(
  rows: GridRow<string>[],
  columns: string[],
  nameOf: Map<string, string>,
): string {
  const lines: string[] = [
    [TIMESTAMP_COLUMN, ...columns.map((id) => csvField(nameOf.get(id)!))].join(SEP),
  ];
  for (const row of rows) {
    const cells = [new Date(row.at).toISOString()];
    for (const id of columns) {
      const v = row.values.get(id);
      cells.push(v === undefined || v === null ? '' : String(v));
    }
    lines.push(cells.join(SEP));
  }
  // Trailing newline: the platform reads the body with encoding/csv, which does
  // not need one, but a file that ends mid-line is the shape every CSV bug
  // starts as.
  return lines.join('\n') + '\n';
}

/**
 * Split a session's pending readings into CSV chunks and per-sensor leftovers.
 *
 * Pure, so the whole decision — which sensor goes which way, which readings a
 * chunk accounts for, what the body looks like — is testable without a network
 * or a database.
 */
export function planCsvUpload(
  groups: SessionUploadGroup[],
  sensorMeta: Map<string, UploadSensorMeta>,
  options: { bucketMs: number; maxHoldMs: number; rowsPerChunk?: number },
): CsvUploadPlan {
  const rowsPerChunk = options.rowsPerChunk ?? CHUNK_ROWS;
  const leftovers: SessionUploadGroup[] = [];
  const readings: GridReading<string>[] = [];
  const nameOf = new Map<string, string>();

  for (const group of groups) {
    const meta = sensorMeta.get(group.sensorId);
    if (!isGriddableSensor(group, meta)) {
      leftovers.push(group);
      continue;
    }
    nameOf.set(group.sensorId, meta!.name!);
    for (const r of group.readings) {
      readings.push({
        key: group.sensorId,
        receivedAt: r.receivedAt,
        value: numericValue(r),
        id: r.id,
      });
    }
  }

  const rows = reduceToGrid(readings, {
    bucketMs: options.bucketMs,
    maxHoldMs: options.maxHoldMs,
  });

  const chunks: CsvChunk[] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const slice = rows.slice(i, i + rowsPerChunk);
    // Each chunk gets its own header, carrying only the columns it actually
    // has values for. A sensor that records only during Verpressen is then
    // simply absent from the Bohren chunks instead of contributing an empty
    // cell — a written NULL — to every one of their rows.
    // Always at least one column: a bucket exists because a reading fell in
    // it, and that reading sets a cell — a gap sets one holding `null`. So no
    // chunk can come out empty and quietly take its readings' ids with it.
    const columns = gridColumns(slice);
    chunks.push({
      csv: serializeChunk(slice, columns, nameOf),
      ids: slice.flatMap((r) => r.ids),
      rows: slice.length,
      columns: columns.map((id) => nameOf.get(id)!),
    });
  }

  return { chunks, leftovers, gridded: Array.from(nameOf.values()) };
}

/**
 * A sensor's readings that have to reach the platform at their *own* instants,
 * on top of whatever the grid sent.
 *
 * It claims no reading ids. The readings it carries are already accounted for
 * by the CSV chunk that gridded them, and re-marking them here would have two
 * halves of one upload fighting over the same rows. What it does carry is its
 * own place in the progress count, so a failure lands in `sensorsFailed` and
 * the element is not completed on a profile the platform cannot reassemble.
 */
/** What the platform answers a CSV batch with. */
export interface CsvBatchResponse {
  success?: boolean;
  rows_processed?: number;
  values_inserted?: number;
  null_values?: number;
  failed_count?: number;
  unknown_sensors?: string[];
  errors?: string[];
}

/** Why a chunk's response is not acceptable. */
export interface CsvChunkProblem {
  /** German, for the log and the fallback's reason. */
  message: string;
  /**
   * Whether retrying this route can ever help.
   *
   * A name the platform does not know, and a body it understood no row of, are
   * properties of the request: they come back identically however often they
   * are sent, so the session has to take the id-addressed per-sensor path
   * instead. Values the platform failed to *insert* are not — that is its own
   * database having a bad minute, and falling back on it would re-send the
   * whole session as JSON over the mobile link this route exists to spare.
   */
  structural: boolean;
}

/**
 * Why a chunk's response is not acceptable, or null when it is.
 *
 * The CSV endpoint addresses sensors **by name**, which the rest of this kiosk
 * deliberately does not do — the Schichtauftrag carries real platform ids
 * precisely because a name can drift (see CLAUDE.md). The response is what
 * makes name-addressing safe here: it names every header it could not match,
 * so a column that silently would have gone nowhere becomes a failure instead,
 * and the caller falls back to the id-addressed per-sensor path.
 *
 * This reads a refusal as well as a success, because the endpoint answers both
 * with the same shape: it sets `success = failed_count === 0 && rows_processed
 * > 0` and serves a false one as a 422 carrying this very body. The status
 * therefore says nothing about whether the route is usable, and only the fields
 * do.
 */
export function csvChunkProblem(
  chunk: CsvChunk,
  res: CsvBatchResponse | null,
): CsvChunkProblem | null {
  if (!res) {
    return { message: 'Die Plattform hat keine Antwort geliefert.', structural: false };
  }

  // Compared trimmed on both sides. The platform matches a header cell with
  // `strings.TrimSpace` and reports the *trimmed* spelling back, so a sensor
  // whose platform name carries padding — `"Bohrtiefe "` — is written to the
  // header verbatim, fails to match there, and comes back as `Bohrtiefe`,
  // which `includes` would not find among our columns. The chunk would then
  // pass every check, be marked uploaded, and leave that sensor's whole series
  // nowhere: the exact silent loss this response check exists to catch.
  const ours = new Set(chunk.columns.map((c) => c.trim()));
  const unknown = (res.unknown_sensors ?? []).filter((n) => ours.has(n.trim()));
  if (unknown.length > 0) {
    return {
      message: `Die Plattform kennt diese Sensoren nicht: ${unknown.join(', ')}`,
      structural: true,
    };
  }
  // Rows parsed but values not stored: an insert error on the platform's side,
  // which is a "not now". Checked before the row counts, because a row whose
  // insert failed was still parsed and still counted in `rows_processed`.
  if ((res.failed_count ?? 0) > 0) {
    return {
      message: `${res.failed_count} Messwerte konnten nicht gespeichert werden.`,
      structural: false,
    };
  }
  if (chunk.rows > 0 && (res.rows_processed ?? 0) === 0) {
    // Not one row was understood. That is the body — an unmatched header, a
    // timestamp column it could not parse — and not the link.
    const detail = (res.errors ?? []).slice(0, 2).join('; ');
    return {
      message: detail || 'Die Plattform hat keine einzige Zeile verarbeitet.',
      structural: true,
    };
  }
  if (res.success === false) {
    const detail = (res.errors ?? []).slice(0, 2).join('; ');
    return {
      message: detail || 'Die Plattform hat die Messwerte abgelehnt.',
      structural: false,
    };
  }
  if ((res.rows_processed ?? 0) < chunk.rows) {
    return {
      message: `Nur ${res.rows_processed ?? 0} von ${chunk.rows} Zeilen wurden verarbeitet.`,
      structural: false,
    };
  }
  return null;
}
