import ExcelJS from 'exceljs';
import { getSessionById, getAllSessionReadings, type SessionReadingRow } from './db.js';
import { getStreamSensors, getAvailableStreams, STREAM_LABELS } from './sensor-meta.js';

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

function readingValue(r: SessionReadingRow): number | string {
  if (r.valueNumeric !== null) return r.valueNumeric;
  if (r.valueText !== null) return r.valueText;
  return '';
}

/**
 * Group readings into columns (one per stream sensor) and a sorted set of
 * distinct timestamps. Readings are matched to a column by their topic's
 * trailing sensor name — endsWith (not a last-segment split) so names that
 * themselves contain a slash — e.g. "Bohren/Düsen", "W/Z-Wert" — still match.
 * Readings for sensors outside the stream are ignored.
 */
function buildMatrix(sensorNames: string[], readings: SessionReadingRow[]) {
  const columns = sensorNames.map((name) => ({
    name,
    lower: name.toLowerCase(),
    byTs: new Map<number, number | string>(),
  }));
  const timestamps = new Set<number>();

  for (const r of readings) {
    const topicLower = r.topic.toLowerCase();
    const col = columns.find(
      (c) => topicLower === c.lower || topicLower.endsWith('/' + c.lower),
    );
    if (!col) continue;
    col.byTs.set(r.receivedAt, readingValue(r));
    timestamps.add(r.receivedAt);
  }

  return { columns, sortedTimestamps: Array.from(timestamps).sort((a, b) => a - b) };
}

/**
 * Time-series rows (HDI): one row per distinct timestamp, first column is an
 * ISO 8601 `Zeitpunkt`, empty cells where a sensor has no reading at that ts.
 */
export function buildTimeSeriesRows(
  sensorNames: string[],
  readings: SessionReadingRow[],
): (string | number)[][] {
  const { columns, sortedTimestamps } = buildMatrix(sensorNames, readings);
  const rows: (string | number)[][] = [[TIMESTAMP_COLUMN, ...columns.map((c) => c.name)]];
  for (const ts of sortedTimestamps) {
    const row: (string | number)[] = [new Date(ts).toISOString()];
    for (const col of columns) {
      const v = col.byTs.get(ts);
      row.push(v === undefined ? '' : v);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Indexed rows (IVL): one row per distinct timestamp in chronological order,
 * first column is a sequential 0-based sample `Index`. implenia-web maps the
 * index to its own sentinel timestamp on import.
 */
export function buildIndexRows(
  sensorNames: string[],
  readings: SessionReadingRow[],
): (string | number)[][] {
  const { columns, sortedTimestamps } = buildMatrix(sensorNames, readings);
  const rows: (string | number)[][] = [[INDEX_COLUMN, ...columns.map((c) => c.name)]];
  sortedTimestamps.forEach((ts, index) => {
    const row: (string | number)[] = [index];
    for (const col of columns) {
      const v = col.byTs.get(ts);
      row.push(v === undefined ? '' : v);
    }
    rows.push(row);
  });
  return rows;
}

/** Build the rows for a stream using its format (time-series vs indexed). */
export function buildStreamRows(
  stream: ExportableStream,
  sensorNames: string[],
  readings: SessionReadingRow[],
): (string | number)[][] {
  return stream === 'ivl'
    ? buildIndexRows(sensorNames, readings)
    : buildTimeSeriesRows(sensorNames, readings);
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
  const rows = buildStreamRows(stream, sensors, readings);

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
