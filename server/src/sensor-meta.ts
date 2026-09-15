import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const log = createLogger('sensor-meta');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENSORS_DIR = path.join(__dirname, '..', 'assets', 'sensors');

// Hardcoded until the setup wizard lets service personnel choose
const ACTIVE_VERFAHREN = 'dsv';

export interface CsvSensorRow {
  name: string;
  type: string;
  unit: string;
  source: string;
  role: string;
  priority: string;
  alias: string;
  stream: string;
}

export function parseSensorCsv(content: string): CsvSensorRow[] {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const idx = {
    name: header.indexOf('Name'),
    type: header.indexOf('Typ'),
    unit: header.indexOf('Einheit'),
    source: header.indexOf('Quelle'),
    role: header.indexOf('Rolle'),
    priority: header.indexOf('Priorität'),
    alias: header.indexOf('Alias'),
    stream: header.indexOf('Stream'),
  };

  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      name: cols[idx.name] ?? '',
      type: cols[idx.type] ?? '',
      unit: cols[idx.unit] ?? '',
      source: cols[idx.source] ?? '',
      role: cols[idx.role] ?? '',
      priority: cols[idx.priority] ?? '',
      alias: cols[idx.alias] ?? '',
      stream: idx.stream >= 0 ? (cols[idx.stream] ?? '').trim() : '',
    };
  });
}

export function loadSensorCsv(verfahren: string): CsvSensorRow[] | null {
  const file = path.join(SENSORS_DIR, `${verfahren}-sensors-herstellen.csv`);
  try {
    return parseSensorCsv(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export interface SensorMetaLookup {
  source?: string;
  role?: string;
  priority?: string;
  unit?: string;
}

let metaCache: Map<string, SensorMetaLookup> | null = null;

export function getSensorMetaLookup(): Map<string, SensorMetaLookup> {
  if (metaCache) return metaCache;

  const rows = loadSensorCsv(ACTIVE_VERFAHREN);
  if (!rows) {
    log.warn('Could not load sensor CSV for verfahren: %s', ACTIVE_VERFAHREN);
    metaCache = new Map();
    return metaCache;
  }

  const map = new Map<string, SensorMetaLookup>();
  for (const row of rows) {
    const meta: SensorMetaLookup = {};
    if (row.source) meta.source = row.source;
    if (row.role) meta.role = row.role;
    if (row.priority) meta.priority = row.priority;
    if (row.unit) meta.unit = row.unit;
    map.set(row.name, meta);
  }

  log.info('Loaded %d sensor definitions from %s CSV', map.size, ACTIVE_VERFAHREN);
  metaCache = map;
  return metaCache;
}

export function getActiveVerfahren(): string {
  return ACTIVE_VERFAHREN;
}

export interface StreamSensor {
  name: string;
  unit: string;
}

/**
 * The herstellen data streams, in canonical order. Mirrors implenia-web's
 * `VALID_STREAMS` (`app/helpers/stream-csv.ts`) — the `Stream` column in the
 * shared `*-sensors-herstellen.csv` assigns each sensor to one of these.
 */
export const STREAM_ORDER = ['hdi', 'ivl', 'result'] as const;

/** German labels for the streams, mirroring implenia-web's `STREAM_LABELS`. */
export const STREAM_LABELS: Record<string, string> = {
  hdi: 'HDI-Daten',
  ivl: 'Inklinometer',
  result: 'Ergebnisdaten',
};

/**
 * Ordered list of sensors belonging to a given stream (`hdi` | `ivl` | `result`)
 * for the active verfahren, in CSV row order. Column headers for session-data
 * export are derived from this — the names must match the shared
 * `*-sensors-herstellen.csv` contract exactly.
 */
export function getStreamSensors(stream: string): StreamSensor[] {
  const rows = loadSensorCsv(ACTIVE_VERFAHREN);
  if (!rows) return [];
  return rows
    .filter((r) => r.stream === stream)
    .map((r) => ({ name: r.name, unit: r.unit }));
}

/**
 * The streams that the active verfahren defines (i.e. have at least one sensor
 * assigned via the CSV `Stream` column), in canonical order. This is what
 * "streams configured for the current machine" means — it is derived from the
 * shared CSV contract, never hardcoded per machine type.
 */
export function getAvailableStreams(): string[] {
  const rows = loadSensorCsv(ACTIVE_VERFAHREN);
  if (!rows) return [];
  const present = new Set(rows.map((r) => r.stream).filter(Boolean));
  return STREAM_ORDER.filter((s) => present.has(s));
}
