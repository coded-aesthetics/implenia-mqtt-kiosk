import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMeta, setMeta } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('sensor-meta');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENSORS_DIR = path.join(__dirname, '..', 'assets', 'sensors');

/**
 * The Verfahren (construction methods) this kiosk can be configured for.
 * Each key must have a matching `<key>-sensors-herstellen.csv` in
 * `server/assets/sensors/`, synced from implenia-web.
 */
export const VERFAHREN: Record<string, string> = {
  dsv: 'DSV (Düsenstrahlverfahren)',
  ankerbohren: 'Ankerbohren',
  grosspfahlbohren: 'Grosspfahlbohren',
  injektionsbohren: 'Injektionsbohren',
};

export function isValidVerfahren(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERFAHREN, key);
}

/** `meta` key holding the Verfahren this machine was set up for. */
const ACTIVE_VERFAHREN_KEY = 'active_verfahren';

/**
 * Cached active Verfahren. `undefined` means "not read from the DB yet",
 * `null` means "read, and this machine has not been set up".
 */
let activeVerfahren: string | null | undefined;

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

/**
 * Parsed rows per Verfahren. The CSVs are release assets — they only change
 * when a new version is deployed, which restarts the process — so this holds
 * for the process lifetime and is dropped by clearVerfahrenCache() for the
 * reset flow and for tests.
 *
 * Worth caching because the calibration and topic-assignment screens poll
 * their endpoints every 1.5-3 s, and each request used to re-read and
 * re-parse the file from disk.
 */
const csvCache = new Map<string, CsvSensorRow[]>();

/**
 * Sensor rows for a Verfahren, or null when the CSV is missing or unreadable.
 *
 * Readonly because the result is shared: mutating it would poison the cache
 * for every later caller.
 */
export function loadSensorCsv(verfahren: string): readonly CsvSensorRow[] | null {
  const cached = csvCache.get(verfahren);
  if (cached) return cached;

  const file = path.join(SENSORS_DIR, `${verfahren}-sensors-herstellen.csv`);
  try {
    const rows = parseSensorCsv(fs.readFileSync(file, 'utf-8'));
    csvCache.set(verfahren, rows);
    return rows;
  } catch {
    // Deliberately not cached: a missing file is a deployment fault that a
    // re-sync can fix without a restart.
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
let roleCache: Map<string, string> | null = null;

export function getSensorMetaLookup(): Map<string, SensorMetaLookup> {
  if (metaCache) return metaCache;

  const verfahren = getActiveVerfahren();
  if (!verfahren) {
    // Not set up yet. No enrichment is available, so sensors fall back to
    // their API metadata — the live view still works, just without
    // CSV-derived priorities, roles and units.
    metaCache = new Map();
    return metaCache;
  }

  const rows = loadSensorCsv(verfahren);
  if (!rows) {
    log.warn('Could not load sensor CSV for verfahren: %s', verfahren);
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

  log.info('Loaded %d sensor definitions from %s CSV', map.size, verfahren);
  metaCache = map;
  return metaCache;
}

/**
 * The role of a sensor, looked up by the key the topic resolver produces — a
 * lowercased sensor name.
 *
 * `getSensorMetaLookup()` is keyed by the exact CSV name, which a resolved
 * topic never is, so ingestion cannot use it to answer "is this the depth
 * sensor?" without a second index. This is that index.
 */
export function getSensorRole(sensorKey: string): string | null {
  if (!roleCache) {
    roleCache = new Map();
    const depthSensors: string[] = [];
    for (const [name, meta] of getSensorMetaLookup()) {
      if (!meta.role) continue;
      roleCache.set(name.toLowerCase(), meta.role);
      if (meta.role === 'depth') depthSensors.push(name);
    }
    // Rohrverlängerung handling feeds every `depth` sensor into one per-pipe
    // check, so two of them would interleave into nonsense. That would be a
    // mistake in the shared CSV, and it is worth saying out loud.
    if (depthSensors.length > 1) {
      log.warn(
        'Verfahren defines %d sensors with role "depth" (%s) — Rohrverlängerung expects exactly one',
        depthSensors.length, depthSensors.join(', '),
      );
    }
  }
  return roleCache.get(sensorKey.toLowerCase()) ?? null;
}

/**
 * The Verfahren this machine was set up for, or `null` if it has not been
 * through the setup wizard yet. Cached after the first read; every mutation
 * path clears the cache.
 */
export function getActiveVerfahren(): string | null {
  if (activeVerfahren === undefined) {
    const stored = getMeta(ACTIVE_VERFAHREN_KEY) ?? null;
    if (stored && !isValidVerfahren(stored)) {
      // A CSV was removed or renamed under a configured machine. Treat it as
      // unset rather than serving metadata from a Verfahren we cannot load.
      log.error('Stored verfahren "%s" is not a known Verfahren — treating machine as unconfigured', stored);
      activeVerfahren = null;
    } else {
      activeVerfahren = stored;
    }
  }
  return activeVerfahren;
}

/** Raised when a second Verfahren is written to an already-configured kiosk. */
export class VerfahrenAlreadySetError extends Error {
  constructor(public readonly current: string) {
    super(`Verfahren already set to "${current}"`);
    this.name = 'VerfahrenAlreadySetError';
  }
}

/**
 * Set the Verfahren for this machine. Write-once by design: recorded sessions,
 * serial channel mappings and stream-export columns are all interpreted
 * through the active Verfahren, so switching it under existing data would
 * silently reinterpret that data. Changing it requires a full reset.
 */
export function setActiveVerfahren(verfahren: string): void {
  if (!isValidVerfahren(verfahren)) {
    throw new Error(`Unbekanntes Verfahren: ${verfahren}`);
  }
  const current = getActiveVerfahren();
  if (current !== null) {
    throw new VerfahrenAlreadySetError(current);
  }
  setMeta(ACTIVE_VERFAHREN_KEY, verfahren);
  activeVerfahren = verfahren;
  metaCache = null;
  roleCache = null;
  csvCache.clear();
  log.info('Verfahren set to %s', verfahren);
}

/**
 * Drop all cached Verfahren state so the next read hits the DB again.
 * For the reset flow and for tests.
 */
export function clearVerfahrenCache(): void {
  activeVerfahren = undefined;
  metaCache = null;
  roleCache = null;
  csvCache.clear();
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
  const verfahren = getActiveVerfahren();
  const rows = verfahren ? loadSensorCsv(verfahren) : null;
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
  const verfahren = getActiveVerfahren();
  const rows = verfahren ? loadSensorCsv(verfahren) : null;
  if (!rows) return [];
  const present = new Set(rows.map((r) => r.stream).filter(Boolean));
  return STREAM_ORDER.filter((s) => present.has(s));
}
