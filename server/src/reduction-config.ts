import { getMeta, setMeta } from './db.js';

/**
 * How much the kiosk reduces a recording before it leaves the machine, and by
 * which route it sends it.
 *
 * Per-kiosk and DB-backed like the Rohrverlängerung and calibration settings,
 * not environment: a release image is identical across sites, and how fast a
 * particular rig publishes is a property of that rig. Service personnel set it
 * on the Datenübertragung screen.
 *
 * Nothing here ever deletes anything. `session_readings` keeps every reading at
 * full resolution whatever these say; reduction happens on the way out, so a
 * setting chosen wrong costs resolution on the platform and can be corrected by
 * re-uploading or exporting the same session at a finer grid.
 */

const EXPORT_BUCKET_KEY = 'reduce_export_bucket_ms';
const UPLOAD_BUCKET_KEY = 'reduce_upload_bucket_ms';
const UPLOAD_MODE_KEY = 'reduce_upload_mode';

/** `0` means "no grid": every reading keeps its own instant. */
export const GRID_OFF = 0;

/**
 * The grids the screen offers.
 *
 * 1 s is the default because it is lossless in practice on the only rig that
 * has been captured — between 58 % and 90 % of readings per channel are exact
 * repeats, and the median 1 s bucket of twelve of its fourteen channels holds a
 * single distinct value. Coarser grids are there for a site on a metered link;
 * `GRID_OFF` is there because a reduction nobody can switch off is a reduction
 * nobody can audit.
 */
export const GRANULARITIES: { ms: number; label: string; short: string }[] = [
  { ms: GRID_OFF, label: 'Voll (jeder Messwert)', short: 'Voll' },
  { ms: 1000, label: '1 Sekunde', short: '1 s' },
  { ms: 2000, label: '2 Sekunden', short: '2 s' },
  { ms: 5000, label: '5 Sekunden', short: '5 s' },
  { ms: 10_000, label: '10 Sekunden', short: '10 s' },
];

/** How the measurements of a session are sent to the platform. */
export const UPLOAD_MODES = {
  csv: 'Gesammelt als CSV',
  sensor: 'Einzeln je Sensor',
} as const;

export type UploadMode = keyof typeof UPLOAD_MODES;

export function isUploadMode(v: string): v is UploadMode {
  return Object.prototype.hasOwnProperty.call(UPLOAD_MODES, v);
}

export interface ReductionConfig {
  /** Grid for the USB xlsx export, in ms. `GRID_OFF` for every reading. */
  exportBucketMs: number;
  /** Grid for the platform upload, in ms. `GRID_OFF` for every reading. */
  uploadBucketMs: number;
  uploadMode: UploadMode;
}

export const DEFAULTS: ReductionConfig = {
  exportBucketMs: 1000,
  uploadBucketMs: 1000,
  uploadMode: 'csv',
};

function readBucket(key: string, fallback: number): number {
  const raw = getMeta(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function getReductionConfig(): ReductionConfig {
  const mode = getMeta(UPLOAD_MODE_KEY);
  return {
    exportBucketMs: readBucket(EXPORT_BUCKET_KEY, DEFAULTS.exportBucketMs),
    uploadBucketMs: readBucket(UPLOAD_BUCKET_KEY, DEFAULTS.uploadBucketMs),
    uploadMode: mode && isUploadMode(mode) ? mode : DEFAULTS.uploadMode,
  };
}

/**
 * How long a value may be carried into later rows at a given grid.
 *
 * Four buckets, and never under 4 s. The floor is what makes a 1 s grid work on
 * the captured rig at all: its pump channels publish every ~3 s, so without it
 * two of every three rows would carry no flow or volume — and an empty cell is
 * a written NULL to the platform's CSV endpoint, which would report the pumps
 * as failing twice a second. Four buckets is what keeps the same rule honest at
 * a coarse grid, where a 10 s bucket genuinely cannot say anything about a
 * sensor last heard from a minute ago.
 */
export function holdMsFor(bucketMs: number): number {
  return Math.max(4 * bucketMs, 4000);
}

export interface ReductionInput {
  exportBucketMs?: number;
  uploadBucketMs?: number;
  uploadMode?: string;
}

export type ValidationResult =
  | { ok: true; value: ReductionConfig }
  | { ok: false; error: string };

const MAX_BUCKET_MS = 60_000;

function validateBucket(
  value: number | undefined, current: number, feld: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: current };
  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      error:
        `Bitte für ${feld} eine Auflösung in Millisekunden angeben, ` +
        'z. B. 1000 für eine Sekunde — oder 0 für jeden einzelnen Messwert.',
    };
  }
  if (value > MAX_BUCKET_MS) {
    return {
      ok: false,
      error:
        `Eine Auflösung von ${Math.round(value / 1000)} Sekunden für ${feld} ist zu grob. ` +
        `Mehr als ${MAX_BUCKET_MS / 1000} Sekunden je Messpunkt lässt den Bohrverlauf nicht mehr erkennen.`,
    };
  }
  return { ok: true, value: Math.floor(value) };
}

/**
 * Validate what the Datenübertragung screen submitted.
 *
 * German and actionable: service personnel read these on site and cannot call
 * anyone.
 */
export function validateReduction(input: ReductionInput): ValidationResult {
  const current = getReductionConfig();

  const exportBucket = validateBucket(
    input.exportBucketMs, current.exportBucketMs, 'den USB-Export',
  );
  if (!exportBucket.ok) return exportBucket;

  const uploadBucket = validateBucket(
    input.uploadBucketMs, current.uploadBucketMs, 'den Upload',
  );
  if (!uploadBucket.ok) return uploadBucket;

  let uploadMode = current.uploadMode;
  if (input.uploadMode !== undefined) {
    if (!isUploadMode(input.uploadMode)) {
      return {
        ok: false,
        error:
          'Bitte angeben, wie die Messwerte hochgeladen werden sollen: ' +
          Object.values(UPLOAD_MODES).join(' oder ') + '.',
      };
    }
    uploadMode = input.uploadMode;
  }

  // A CSV is one table: every sensor is a column on every row, and a cell left
  // empty is not "no reading" to the platform — it inserts a NULL, which is how
  // this kiosk reports a sensor outage. Ungridded, each row carries one real
  // value and thirteen empty cells, so the captured session would upload
  // 275 935 measurements and 3 566 722 fabricated outages. Refused rather than
  // silently corrected, because the two settings are on one screen and the
  // technician has to see which one is in the way.
  if (uploadMode === 'csv' && uploadBucket.value === GRID_OFF) {
    return {
      ok: false,
      error:
        'Beim gesammelten CSV-Upload muss für den Upload eine Auflösung gewählt sein, ' +
        'z. B. 1 Sekunde. Für jeden einzelnen Messwert bitte „' + UPLOAD_MODES.sensor +
        '" verwenden.',
    };
  }

  return {
    ok: true,
    value: {
      exportBucketMs: exportBucket.value,
      uploadBucketMs: uploadBucket.value,
      uploadMode,
    },
  };
}

/** Persist validated settings. Callers must validate first. */
export function setReductionConfig(value: ReductionConfig): void {
  setMeta(EXPORT_BUCKET_KEY, String(value.exportBucketMs));
  setMeta(UPLOAD_BUCKET_KEY, String(value.uploadBucketMs));
  setMeta(UPLOAD_MODE_KEY, value.uploadMode);
}
