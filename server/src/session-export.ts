import ExcelJS from 'exceljs';
import {
  getSessionById, getAllSessionReadings, markSessionExported,
  markStreamExported, getExportedStreams, type SessionReadingRow,
} from './db.js';
import { getStreamSensors, getAvailableStreams, STREAM_LABELS } from './sensor-meta.js';
import { reduceToGrid, type GridReading } from './grid-reduce.js';
import { getReductionConfig, holdMsFor, GRID_OFF } from './reduction-config.js';

/**
 * Session-data export for the implenia-web DSV widget import.
 *
 * This is the offline counterpart to the batch upload: when the kiosk has no
 * internet, the worker exports a completed recording to USB and imports it
 * manually in the web app.
 *
 * Which sensors belong to which stream is NOT hardcoded here — it is driven by
 * the `Stream` column of the shared `*-sensors-herstellen.csv` (synced from
 * implenia-web, the source of truth). Each stream exports to its own file
 * because implenia-web's importer only reads the first worksheet and detects
 * the stream from that sheet's header.
 *
 * The output mirrors implenia-web's own stream export (`stream-csv.server.ts`)
 * so files round-trip through its importer (bulk-insert path):
 *   - HDI: time-series, first column `Zeitpunkt` = ISO 8601 instant (the
 *     DST-safe shared convention; see CLAUDE.md).
 *   - IVL: indexed, first column `Index` = sequential sample number. The
 *     importer maps each index to its sentinel timestamp itself, so the kiosk
 *     only needs a monotonic 0-based index — it never touches the sentinel.
 */

/** Shared timestamp column name — must match implenia-web's TIMESTAMP_COLUMN. */
export const TIMESTAMP_COLUMN = 'Zeitpunkt';
/** First-column header for the indexed (IVL) stream format. */
export const INDEX_COLUMN = 'Index';

/** Streams the kiosk can produce. `result` is computed server-side in web. */
export const EXPORTABLE_STREAMS = ['hdi', 'ivl'] as const;
export type ExportableStream = (typeof EXPORTABLE_STREAMS)[number];

export function isExportableStream(s: string): s is ExportableStream {
  return (EXPORTABLE_STREAMS as readonly string[]).includes(s);
}

function readingValue(r: SessionReadingRow): number | string | null {
  if (r.valueNumeric !== null) return r.valueNumeric;
  if (r.valueText !== null) return r.valueText;
  return null;
}

/**
 * One row of the exported sheet, before the first column is prepended.
 *
 * `at` is the instant the row stands for: a real reading's instant, both
 * ungridded and gridded (see grid-reduce.ts).
 */
interface MatrixRow {
  at: number;
  values: Map<string, number | string | null>;
}

/**
 * Resolve readings to their stream columns, and lay them out as rows.
 *
 * Readings are matched to a column by their topic's trailing sensor name —
 * endsWith (not a last-segment split) so names that themselves contain a
 * slash — e.g. "Bohren/Düsen", "W/Z-Wert" — still match. Readings for sensors
 * outside the stream are ignored.
 *
 * With `bucketMs > 0` the rows come from `reduceToGrid`: one per bucket,
 * carrying each sensor's last value in it. Without it, every reading keeps its
 * own instant and nothing is filled in — which is the shape this export always
 * had, kept because a reduction nobody can switch off is a reduction nobody can
 * audit. It is also, on a real session, a 274 475-row workbook that a kiosk
 * cannot build; see grid-reduce.ts for the measurements.
 */
function buildMatrix(
  sensorNames: string[],
  readings: SessionReadingRow[],
  bucketMs: number,
): { names: string[]; rows: MatrixRow[] } {
  const columns = sensorNames.map((name) => ({ name, lower: name.toLowerCase() }));

  const resolved: GridReading<string>[] = [];
  for (const r of readings) {
    const topicLower = r.topic.toLowerCase();
    const col = columns.find(
      (c) => topicLower === c.lower || topicLower.endsWith('/' + c.lower),
    );
    if (!col) continue;
    resolved.push({ key: col.name, receivedAt: r.receivedAt, value: readingValue(r) });
  }

  if (bucketMs > 0) {
    const rows = reduceToGrid(resolved, { bucketMs, maxHoldMs: holdMsFor(bucketMs) });
    return { names: sensorNames, rows };
  }

  const byTs = new Map<number, Map<string, number | string | null>>();
  for (const r of resolved) {
    let row = byTs.get(r.receivedAt);
    if (!row) { row = new Map(); byTs.set(r.receivedAt, row); }
    row.set(r.key, r.value);
  }
  const rows = Array.from(byTs, ([at, values]) => ({ at, values }))
    .sort((a, b) => a.at - b.at);
  return { names: sensorNames, rows };
}

/**
 * Render the rows, keeping the column order the stream's CSV defines.
 *
 * A column with nothing for a row — never recorded, or a recorded gap — is an
 * empty cell. implenia-web's importer reads those as "no value", which is what
 * they are.
 */
function renderRows(
  firstHeader: string,
  names: string[],
  rows: MatrixRow[],
  firstCell: (row: MatrixRow, index: number) => string | number,
): (string | number)[][] {
  const out: (string | number)[][] = [[firstHeader, ...names]];
  rows.forEach((row, index) => {
    const cells: (string | number)[] = [firstCell(row, index)];
    for (const name of names) {
      const v = row.values.get(name);
      cells.push(v === undefined || v === null ? '' : v);
    }
    out.push(cells);
  });
  return out;
}

/**
 * Time-series rows (HDI): one row per instant, first column is an ISO 8601
 * `Zeitpunkt`.
 */
export function buildTimeSeriesRows(
  sensorNames: string[],
  readings: SessionReadingRow[],
  bucketMs = GRID_OFF,
): (string | number)[][] {
  const { names, rows } = buildMatrix(sensorNames, readings, bucketMs);
  return renderRows(TIMESTAMP_COLUMN, names, rows, (row) => new Date(row.at).toISOString());
}

/**
 * Indexed rows (IVL): one row per instant in chronological order, first column
 * is a sequential 0-based sample `Index`. implenia-web maps the index to its own
 * sentinel timestamp on import.
 */
export function buildIndexRows(
  sensorNames: string[],
  readings: SessionReadingRow[],
  bucketMs = GRID_OFF,
): (string | number)[][] {
  const { names, rows } = buildMatrix(sensorNames, readings, bucketMs);
  return renderRows(INDEX_COLUMN, names, rows, (_row, index) => index);
}

/** Build the rows for a stream using its format (time-series vs indexed). */
export function buildStreamRows(
  stream: ExportableStream,
  sensorNames: string[],
  readings: SessionReadingRow[],
  bucketMs = GRID_OFF,
): (string | number)[][] {
  return stream === 'ivl'
    ? buildIndexRows(sensorNames, readings, bucketMs)
    : buildTimeSeriesRows(sensorNames, readings, bucketMs);
}

/** Sanitize an element name and stream into a safe filename. */
export function exportFilename(elementName: string, stream: ExportableStream): string {
  const safe = elementName.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'session'}_${stream}.xlsx`;
}

/** Count session readings that belong to a given stream's sensors. */
function countStreamReadings(sensorNames: string[], readings: SessionReadingRow[]): number {
  const lower = sensorNames.map((n) => n.toLowerCase());
  let count = 0;
  for (const r of readings) {
    const topicLower = r.topic.toLowerCase();
    if (lower.some((n) => topicLower === n || topicLower.endsWith('/' + n))) count++;
  }
  return count;
}

export interface StreamExportOption {
  stream: ExportableStream;
  label: string;
  count: number;
}

/**
 * The exportable streams for a session: those the active verfahren defines
 * (via the CSV) AND that actually have recorded data. Drives the per-stream
 * export buttons — no empty-file dead-ends.
 */
export function getSessionExportStreams(sessionId: number): StreamExportOption[] {
  const readings = getAllSessionReadings(sessionId);
  const available = getAvailableStreams().filter(isExportableStream);
  const options: StreamExportOption[] = [];
  for (const stream of available) {
    const sensors = getStreamSensors(stream).map((s) => s.name);
    const count = countStreamReadings(sensors, readings);
    if (count > 0) {
      options.push({ stream, label: STREAM_LABELS[stream] ?? stream.toUpperCase(), count });
    }
  }
  return options;
}

/**
 * Record that one stream's file was written, and decide whether the session as
 * a whole now counts as exported.
 *
 * The reset guard reads `exported_at` as "every reading of this session has
 * been saved somewhere", but a session exports one file per stream. Marking
 * the session after the first file would hand the remaining streams' readings
 * to the next reset — never uploaded, never written anywhere. So the session
 * is only marked once no stream that has data is still missing.
 *
 * Returns the streams still waiting to be exported, for logging and for the UI.
 */
export function recordStreamExport(
  sessionId: number,
  stream: ExportableStream,
): { remaining: string[] } {
  markStreamExported(sessionId, stream);
  const exported = new Set(getExportedStreams(sessionId));
  const remaining = getSessionExportStreams(sessionId)
    .filter((o) => !exported.has(o.stream))
    .map((o) => o.stream);
  if (remaining.length === 0) {
    markSessionExported(sessionId);
  }
  return { remaining };
}

/**
 * Build the xlsx workbook buffer for a completed session's stream.
 * Throws if the session does not exist or the stream is not exportable.
 */
export async function buildSessionExport(
  sessionId: number,
  stream: ExportableStream,
): Promise<{ buffer: Buffer; filename: string; dataRows: number }> {
  const session = getSessionById(sessionId);
  if (!session) {
    throw new Error(`Sitzung ${sessionId} nicht gefunden`);
  }

  const sensors = getStreamSensors(stream).map((s) => s.name);
  const readings = getAllSessionReadings(sessionId);
  const { exportBucketMs } = getReductionConfig();
  const rows = buildStreamRows(stream, sensors, readings, exportBucketMs);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Implenia Kiosk';
  wb.created = new Date();
  const ws = wb.addWorksheet(stream);
  for (let i = 0; i < rows.length; i++) {
    const excelRow = ws.addRow(rows[i]);
    if (i === 0) excelRow.font = { bold: true };
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  // Row count excludes the header. A stream the verfahren does not define
  // produces a header-only file — which must not count as data having been
  // saved anywhere.
  return {
    buffer,
    filename: exportFilename(session.element_name, stream),
    dataRows: Math.max(rows.length - 1, 0),
  };
}
