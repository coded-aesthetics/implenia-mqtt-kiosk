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
