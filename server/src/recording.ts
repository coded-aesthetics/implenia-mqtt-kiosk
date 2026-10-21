import { fetchImplenia, type ApiError } from './implenia-api.js';
import { resolveHerstellenSensors, type SensorDefs } from './herstellen-sensors.js';
import { getReductionConfig, holdMsFor } from './reduction-config.js';
import {
  ALIGNMENT_ANCHOR_ROLES, ANCHORED_ROLE, csvChunkProblem, pinAnchorReadings, planCsvUpload,
  type CsvBatchResponse, type CsvChunk, type CsvChunkProblem, type CsvUploadPlan,
  type PinnedBatch, type UploadSensorMeta,
} from './csv-upload.js';
import { isElementNotResolvable, withElementDevice } from './element-device.js';
import { ingestion, isOperatingMode, type OperatingMode, type SensorMapEntry } from './ingestion.js';
import type { DrillStatus } from './rohrwechsel.js';
import { createLogger, onLogEntry, type LogEntry } from './logger.js';
import { config } from './config.js';
import { connectivity } from './connectivity.js';
import { findSensorNameByRole, getSensorMetaLookup } from './sensor-meta.js';
import {
  completionStamp,
  writeElementCompletion,
} from './element-completion.js';
import {
  createSession,
  endSession,
  getActiveSession,
  getMostRecentSession,
  getSessionById,
  getSessionUploadGroups,
  getSessionReadingCount,
  getSessionSensorSeries,
  getSessionStats,
  getSessions,
  insertSessionReading,
  markSessionReadingsUploaded,
  markSessionReadingsFailed,
  resetFailedReadings,
  setOperatingModeRow,
  updateSessionStatus,
  type Session,
} from './db.js';

const log = createLogger('recording');

/**
 * The platform's sensor name, and the topic the entries are recorded under.
 *
 * ingestion.ts has to know this one too — it must not offer these rows to a
 * screen — and holds its own copy as `LOG_TOPIC`. Deliberately a second copy
 * rather than an import: `ingestion → mqtt → websocket → recording → ingestion`
 * is a cycle, so a const read here at module-body time lands in the temporal
 * dead zone and takes the process down at boot. `log-topic.test.ts` pins the
 * two together instead.
 */
export const LOG_SENSOR_NAME = 'logs';
let unsubscribeLog: (() => void) | null = null;

export async function ensureLogSensor(): Promise<void> {
  if (!config.LOG_SENSOR_UPLOAD) return;
  try {
    await fetchImplenia('/api/v1/measuring-device/sensor-string', {
      method: 'PUT',
      body: { name: LOG_SENSOR_NAME },
    });
    log.info('Log sensor ensured on platform');
  } catch (err) {
    log.warn('Could not ensure log sensor: %s', (err as Error).message);
  }
}

// --- Types ---

export interface RecordingState {
  active: boolean;
  sessionId: number | null;
  elementName: string | null;
  startedAt: number | null;
  readingCount: number;
  /**
   * Rohrverlängerung state, or null when it is not configured or nothing is
   * being recorded. The WebSocket pushes changes; this is what a screen that
   * has just loaded starts from.
   */
  rohrwechsel: DrillStatus | null;
  /** What the rig is doing. Null when nothing is being recorded. */
  operatingMode: OperatingMode | null;
  /**
   * Metres the worker has corrected the depth by on this element, or null when
   * nothing is being recorded.
   *
   * Its own field rather than part of `rohrwechsel`, which is null on a kiosk
   * with no Klemmbacke configured — a depth correction applies on every rig.
   */
  depthCorrection: number | null;
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
  /**
   * What the counters count. The per-sensor upload advances once per sensor;
   * the CSV upload advances once per chunk, and calling those "Sensoren" on the
   * recording bar would have a worker report the wrong thing to the office. The
   * bar's percentage arithmetic is the same either way.
   */
  unit: 'sensor' | 'paket';
}

/**
 * A recorded value in the shape its sensor's endpoint accepts.
 *
 * A numeric sensor must never be handed a string: the backend validates the
 * whole batch and rejects all of it with a 422 over a single bad element, so one
 * junk reading costs up to CHUNK_SIZE good ones and drops the session to
 * `partial`. A value that is not a finite number is therefore uploaded as a gap
 * (`null`), which is what it means — the rig had nothing to report.
 *
 * This backstops `parsePayload`, which already maps the non-finite spellings it
 * knows to null. It cannot be the only guard: readings recorded before a
 * spelling was recognised are already in SQLite as text, and they still have to
 * upload.
 */
function uploadValue(
  raw: number | string | null,
  sensorType: string,
): number | string | null {
  if (raw === null) return null;
  if (sensorType === 'string') return String(raw);
  if (sensorType !== 'float' && sensorType !== 'int') return raw;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

// Map sensor_* array key to upload endpoint type suffix
const SENSOR_TYPE_MAP: Record<string, string> = {
  sensors_float: 'float',
  sensors_int: 'int',
  sensors_string: 'string',
  sensors_geo: 'geo',
};

// --- Recording orchestration ---

export async function beginRecording(
  elementName: string,
  /**
   * The phase this session opens in. Defaults to `bohren`.
   *
   * A resumed element reopens on the phase its last session was in, and the
   * operator may step it before tapping start — so the screen they tapped on
   * is the phase the readings have to be stamped with. `startRecording`
   * writes the opening `Status` reading from the session's mode, and
   * implenia-web segments every Injektionsbohren KPI on that value (see
   * "Status numbering" in CLAUDE.md), so a screen saying Auffüllen over a
   * session recording `Status = 0` reports the filling as drilling.
   *
   * Written onto the session row rather than handed to `startRecording`,
   * because `operating_mode` is `NOT NULL DEFAULT 'bohren'`: a fresh row
   * already *has* a stored mode, which is what `startRecording` reads first
   * (and why `ingestion.pendingMode`, which sits behind it, only ever reaches
   * the reported state). Writing the row also persists the phase immediately,
   * so a restart one reading in resumes into it rather than into Bohren.
   */
  openingMode?: OperatingMode,
): Promise<{ sessionId: number }> {
  const existing = getActiveSession();
  if (existing) {
    throw new Error(`Aufzeichnung ${existing.id} für „${existing.element_name}" läuft bereits.`);
  }

  // Herstellen sensors (all element sensors minus vorgaben sensors), from the
  // platform or the local cache — see resolveHerstellenSensors.
  const defs = await resolveHerstellenSensors(elementName);

  /*
   * Build sensor map: { topicSuffix (lowercase) -> { sensorId, sensorType, unit, role } }
   *
   * The role is recorded alongside the id because the element's own metadata
   * is the authority on which sensor means what, and it is only in hand here.
   * See `sensorNameByRole`.
   */
  const sensorMap = new Map<string, SensorMapEntry>();
  const sensorMapJson: Record<
    string,
    {
      sensorId: string; sensorType: string; unit: string;
      role?: string; name?: string; source?: string;
    }
  > = {};

  for (const [key, type] of Object.entries(SENSOR_TYPE_MAP)) {
    const sensors = defs[key as keyof SensorDefs];
    if (!sensors) continue;
    for (const s of sensors) {
      const suffix = s.name.toLowerCase();
      const role = s.meta?.role || undefined;
      // The source decides whether this sensor's readings may be gridded on
      // the way out, so it is pinned alongside the role rather than resolved
      // at upload time — a recording keeps behaving the way it did when it
      // started, and `resolveHerstellenSensors` has already enriched it from
      // the local CSVs where the platform did not carry one.
      const source = s.meta?.source || undefined;
      const entry: SensorMapEntry = {
        sensorId: s.id,
        sensorType: type,
        name: s.name,
        ...(role ? { role } : {}),
        ...(source ? { source } : {}),
      };
      sensorMap.set(suffix, entry);
      sensorMapJson[suffix] = { ...entry, unit: s.unit ?? '' };
    }
  }

  const sessionId = createSession(elementName, JSON.stringify(sensorMapJson));
  if (openingMode && openingMode !== 'bohren') setOperatingModeRow(sessionId, openingMode);
  ingestion.startRecording(sessionId, sensorMap);
  attachLogSensor(sessionId, sensorMap);

  log.info('Started session %d for "%s" with %d sensors', sessionId, elementName, sensorMap.size);
  return { sessionId };
}

/**
 * Route log entries into the session so they are uploaded with it.
 *
 * Shared by starting and resuming: a restart that re-attached the readings but
 * not the log sensor would drop exactly the diagnostics explaining why the
 * kiosk restarted in the first place.
 */
function attachLogSensor(sessionId: number, sensorMap: Map<string, SensorMapEntry>): void {
  if (!config.LOG_SENSOR_UPLOAD) return;

  const logMapping = sensorMap.get(LOG_SENSOR_NAME);
  if (!logMapping) return;

  // Defensive: two subscriptions would record every entry twice.
  if (unsubscribeLog) unsubscribeLog();

  unsubscribeLog = onLogEntry(config.LOG_SENSOR_LEVEL, (entry: LogEntry) => {
    queueMicrotask(() => {
      try {
        insertSessionReading(
          sessionId,
          LOG_SENSOR_NAME,
          logMapping.sensorId,
          logMapping.sensorType,
          null,
          JSON.stringify({ l: entry.level, m: entry.module, msg: entry.msg }),
        );
      } catch {}
    });
  });
  log.info('Log sensor upload enabled for session %d', sessionId);
}

/**
 * The persisted sensor map, back in the shape the ingestion layer wants.
 *
 * Tolerant of a damaged map on purpose. Readings whose sensor is missing are
 * still recorded, just without a sensor id — kept locally and not uploadable,
 * which a technician can still export and fix. Refusing to resume would
 * instead record nothing at all for the rest of the element, which is the
 * outcome this whole path exists to prevent.
 *
 * Exported because geology needs the same resolution: its reads and writes go
 * by sensor id, since `session_readings.topic` holds the rig's raw MQTT topic
 * rather than a sensor name.
 */
export function parseSensorMap(json: string): Map<string, SensorMapEntry> {
  const map = new Map<string, SensorMapEntry>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    log.error('Session sensor map is not valid JSON — resuming without sensor ids');
    return map;
  }
  if (!parsed || typeof parsed !== 'object') {
    log.error('Session sensor map is not an object — resuming without sensor ids');
    return map;
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as {
      sensorId?: unknown; sensorType?: unknown; role?: unknown; name?: unknown;
    };
    if (typeof entry?.sensorId === 'string' && typeof entry?.sensorType === 'string') {
      map.set(key, {
        sensorId: entry.sensorId,
        sensorType: entry.sensorType,
        // Both absent on every session recorded before they were persisted.
        ...(typeof entry.role === 'string' && entry.role ? { role: entry.role } : {}),
        ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
      });
    }
  }
  return map;
}

/**
 * The sensor carrying a role *in this session*, by name, or null if it has
 * none.
 *
 * Why not `findSensorNameByRole()` alone: that answers from the sensor CSVs as
 * they stand right now, and a role is really a property of the element. Two
 * snapshots drift apart independently — the platform stamps each sensor's
 * `meta` from implenia-web's CSV when the element is *created*, while the
 * kiosk's copy of those CSVs is whatever its last release shipped, synced by
 * hand. So a role that moved to a different sensor, or a sensor that was
 * renamed, leaves an older element's role placement disagreeing with the CSV —
 * and a kiosk self-updates hourly, so the disagreement can also appear
 * *between* a session's start and its sign-off.
 *
 * Resolving from the session's own map keeps a recording behaving the way it
 * did when it started, which is the same reason the sensor ids are pinned
 * there rather than re-fetched. The CSV stays the fallback, for sessions
 * recorded before roles were persisted.
 *
 * The fallback is deliberately not narrowed to those sessions: it also answers
 * for a modern session whose element simply has no sensor carrying the role.
 * The geology screen needs it — `verfuegbar: false` comes with a German
 * message that has to name a sensor, and with nothing in the map the CSVs are
 * the only place left to get a spelling from. For the completion write it is
 * the lesser of two bad answers: the write is attempted under the CSV name and
 * the platform reports whether it landed, which is more than a skipped write
 * ever says. Note that it does *not* create the sensor — the batch endpoint
 * resolves string sensors by name and fails the reading when there is none,
 * and it says so in a 200 body, so the check belongs in
 * `writeElementCompletion`, not here. `session-roles.test.ts` pins both
 * callers.
 *
 * Returns the name **as the platform spells it**, not the lowercased map key.
 * Callers need the real spelling for three different reasons: a completion
 * write is addressed to the platform by sensor name, a German error message
 * naming a missing sensor should show the operator the real one, and the
 * entries are keyed by the lowercased name anyway, which every caller
 * lowercases for itself.
 */
export function sensorNameByRole(
  map: Map<string, SensorMapEntry>,
  role: string,
): string | null {
  for (const [key, entry] of map) {
    if (entry.role === role) return entry.name || key;
  }
  return findSensorNameByRole(role);
}

/**
 * Re-attach the live recording to a session still open in the database.
 *
 * PM2 restarts the kiosk mid-element — on a crash, on a power cut, and when
 * someone taps "Installieren & neustarten". Without this the session row stays
 * open while nothing is attached to it: `insertBuffer` and the WebSocket
 * broadcast both run *before* the recording check in `onReading`, so the bar
 * keeps reading "Aufzeichnung läuft" and the tiles keep ticking while
 * `insertSessionReading` is never called. The worker sees a healthy screen and
 * uploads an element missing everything after the restart.
 *
 * The sensor map is rebuilt from `recording_sessions.sensor_map` rather than
 * re-fetched: the Implenia API is exactly what is unavailable on a site that
 * has lost connectivity, and a resume that depended on it would fail where it
 * is needed most. `startRecording()` restores the Rohrwechsel phase and pipe
 * count from `drill_state` itself, so clipping survives the restart too.
 */
export function resumeRecording(): { sessionId: number } | null {
  const session = getActiveSession();
  if (!session) return null;

  const sensorMap = parseSensorMap(session.sensor_map);
  ingestion.startRecording(session.id, sensorMap);
  attachLogSensor(session.id, sensorMap);

  log.info(
    'Resumed session %d for "%s" with %d sensors',
    session.id, session.element_name, sensorMap.size,
  );
  return { sessionId: session.id };
}

export function endRecording(): { sessionId: number } {
  const session = getActiveSession();
  if (!session) {
    throw new Error('Keine aktive Aufzeichnung.');
  }

  ingestion.stopRecording();
  if (unsubscribeLog) {
    unsubscribeLog();
    unsubscribeLog = null;
  }
  endSession(session.id);

  log.info('Ended session %d', session.id);
  return { sessionId: session.id };
}

/**
 * Detach the live recording without touching the database.
 *
 * Only the reset path needs this: it deletes recording_sessions outright, and
 * an ingestion layer still holding the deleted session id writes readings
 * against a missing parent row. With foreign keys on, that throws inside the
 * source's synchronous 'reading' handler — an uncaught exception that takes
 * the process down the moment data starts arriving again. Callers that end a
 * session normally want endRecording().
 */
export function abortRecording(): void {
  ingestion.stopRecording();
  if (unsubscribeLog) {
    unsubscribeLog();
    unsubscribeLog = null;
  }
}

/**
 * The upload currently running for a session, keyed by session id.
 *
 * Three paths start an upload — the stop route, the connectivity watcher and
 * the boot sweep — and nothing stops two of them from picking the same session
 * within the same second: `uploading` is only written once the first attempt is
 * already underway. Two concurrent passes read the same `pending` rows, send
 * them twice, and then race on the session's final status: the one that
 * finishes second overwrites it, so a session every reading of which landed can
 * end up `partial` (its rows marked `failed` by the loser of the race), which
 * the recording bar then offers to retry forever.
 *
 * A second caller therefore joins the running upload instead of starting one.
 * It gets the same result, which is what it would have computed anyway.
 */
const uploadsInFlight = new Map<number, Promise<{ status: Session['status'] }>>();

export function uploadSession(
  sessionId: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ status: Session['status'] }> {
  const running = uploadsInFlight.get(sessionId);
  if (running) {
    log.info('Upload for session %d is already running — joining it', sessionId);
    return running;
  }

  const attempt = runUpload(sessionId, onProgress).finally(() => {
    uploadsInFlight.delete(sessionId);
  });
  uploadsInFlight.set(sessionId, attempt);
  return attempt;
}

/**
 * Statuses that say the CSV route will not work here, however often it is
 * retried: the endpoint is missing or refuses this content type (a backend
 * deployed before it existed — kiosks self-update hourly while the backend
 * deploys separately, so the field runs both versions at once), or the body was
 * rejected outright.
 *
 * A network error, a timeout and a 5xx are deliberately *not* in here. Those
 * mean "not now", and falling back on them would send the same measurements
 * twice over the mobile link this whole change exists to spare.
 *
 * **422 is not in here either**, because this endpoint uses it for both. It
 * answers a refusal with the same JSON result as a success — `success` is
 * `failed_count === 0 && rows_processed > 0` — so a header it could not match
 * and a Postgres insert error that cost it one chunk of values arrive under the
 * same status. `csvFailureIsStructural` reads the body instead.
 */
const CSV_STRUCTURAL_STATUS = new Set([400, 401, 403, 404, 405, 413, 415]);

/** The status whose body decides, rather than the status itself. */
const CSV_AMBIGUOUS_STATUS = 422;

/**
 * Whether a thrown CSV post says this route cannot work for this session.
 *
 * Three kinds of answer qualify, and the third is the subtle one:
 *
 *   - a status in `CSV_STRUCTURAL_STATUS`;
 *   - an element the platform answered about and does not know. The CSV
 *     endpoint is addressed per element *device*, so there is nothing to post
 *     to; the per-sensor route is addressed by sensor id and needs no device,
 *     which is why the same session uploaded fine before this route existed.
 *     A resolve that *failed to answer* is not this — that is an `ApiError`, or
 *     no status at all, and is handled above;
 *   - a 422 whose body says the request was at fault. An unmatched name is
 *     permanent; `failed_count` is the platform's own insert error and must not
 *     cost the session its grid.
 *
 * A 422 the kiosk cannot read is treated as structural: an uninterpretable
 * refusal is more likely a body this backend will keep refusing than a passing
 * fault, and an expensive upload that lands beats an element whose measurements
 * never leave the kiosk.
 */
function csvFailureIsStructural(chunk: CsvChunk, err: unknown): boolean {
  if (isElementNotResolvable(err)) return true;

  const status = (err as ApiError).statusCode;
  if (status === undefined) return false;
  if (status === CSV_AMBIGUOUS_STATUS) {
    const res = csvResponseFromError(err);
    return res ? csvChunkProblem(chunk, res)?.structural ?? true : true;
  }
  return CSV_STRUCTURAL_STATUS.has(status);
}

/** The CSV result a refusal carried, when it carried one. */
function csvResponseFromError(err: unknown): CsvBatchResponse | null {
  const body = (err as ApiError).body;
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CsvBatchResponse) : null;
  } catch {
    return null;
  }
}

/**
 * Post the CSV chunks, marking each chunk's readings as it goes.
 *
 * Returns `fallback` when the *first* chunk failed structurally. Only the first:
 * nothing has been written at that point, so the session can still take the
 * per-sensor path whole. A later chunk failing is an ordinary transport failure
 * — its readings go to `failed`, the recording bar offers a retry, and the
 * platform's upsert makes the re-send a no-op.
 */
async function uploadCsvChunks(
  session: Session,
  chunks: CsvChunk[],
  hooks: {
    report: (currentSensor: string | null) => void;
    onChunkDone: (ok: boolean) => void;
  },
): Promise<{ fallback: boolean; reason?: string }> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    hooks.report(`Paket ${i + 1}/${chunks.length}`);

    let problem: CsvChunkProblem | null = null;
    try {
      const res = await withElementDevice(session.element_name, (deviceId) =>
        fetchImplenia<CsvBatchResponse>(
          `/api/v1/measuring-device/${encodeURIComponent(deviceId)}/readings/batch/csv`,
          { method: 'POST', rawBody: chunk.csv, contentType: 'text/csv; charset=utf-8' },
        ),
      );
      // A 200 is not yet a success. The endpoint addresses sensors by the names
      // in the header and reports the ones it could not match instead of
      // failing, so a column that went nowhere would otherwise look uploaded.
      problem = csvChunkProblem(chunk, res);
    } catch (err) {
      problem = {
        message: (err as Error).message,
        structural: csvFailureIsStructural(chunk, err),
      };
    }

    if (problem === null) {
      markSessionReadingsUploaded(chunk.ids);
      hooks.onChunkDone(true);
      continue;
    }

    if (i === 0 && problem.structural) return { fallback: true, reason: problem.message };

    markSessionReadingsFailed(chunk.ids);
    hooks.onChunkDone(false);
    log.error(
      'CSV upload failed for session %d chunk %d/%d (%d rows): %s',
      session.id, i + 1, chunks.length, chunk.rows, problem.message,
    );
  }

  return { fallback: false };
}

/**
 * The depth readings this session's geology boundaries are dated at.
 *
 * Both sensors are resolved by **role from the session's own map**, never by
 * name: the depth sensor is `Bohrtiefe` for Injektionsbohren and Ankerbohren
 * but `Tiefe` for DSV, and a session keeps the roles it started with. A
 * Verfahren with no geology sensor, or a pillar where none was recorded, yields
 * nothing and the depth series is simply gridded like any other.
 */
function anchorBatch(
  sessionId: number,
  sensorMeta: Map<string, UploadSensorMeta>,
): PinnedBatch | null {
  let anchorId: string | null = null;
  let depthId: string | null = null;
  let depth: UploadSensorMeta | undefined;
  // First match wins for each role, which is what `sensorNameByRole` does. A
  // map carrying one role twice is legal — the shipped CSVs do it for `gear`
  // and `torque` — and the two have to agree: `geology.ts` dates its boundaries
  // against the sensor `sensorNameByRole` picked, so pinning the *other* one
  // would thin the series those boundaries point at and lose every layer.
  for (const [sensorId, meta] of sensorMeta) {
    if (meta.role === ANCHORED_ROLE) {
      anchorId ??= sensorId;
    } else if (meta.role && ALIGNMENT_ANCHOR_ROLES.has(meta.role) && !depthId) {
      depthId = sensorId;
      depth = meta;
    }
  }
  if (!anchorId || !depthId || !depth?.name) return null;

  const instants = getSessionSensorSeries(sessionId, anchorId).map((p) => p.receivedAt);
  // Nothing to anchor, so don't read the depth series at all: DSV declares
  // `GeoDIN` with no consumer today, and on a session that recorded none this
  // would otherwise load and discard the largest channel in the recording —
  // 26 699 rows on the captured session, on a 4 GB machine, at upload time.
  if (instants.length === 0) return null;

  return pinAnchorReadings(instants, {
    sensorId: depthId,
    sensorType: depth.type ?? 'float',
    name: depth.name,
    readings: getSessionSensorSeries(sessionId, depthId),
  });
}

async function runUpload(
  sessionId: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ status: Session['status'] }> {
  const session = getSessionById(sessionId);
  if (!session) throw new Error(`Aufzeichnung ${sessionId} nicht gefunden.`);

  // Reset any previously failed readings so they get retried
  resetFailedReadings(sessionId);
  updateSessionStatus(sessionId, 'uploading');

  // Build reverse map: sensorId → what the session pinned about that sensor.
  //
  // The map is keyed by the *lowercased* sensor name, so `entry.name` is the
  // only place the platform's real spelling survives — and the CSV upload
  // addresses its columns by that spelling. `sensorName` keeps falling back to
  // the key for sessions recorded before names were persisted, because it only
  // feeds log lines.
  const sensorMeta = new Map<string, UploadSensorMeta>();
  const sensorKeys = new Map<string, string>();
  if (session.sensor_map) {
    try {
      const map = JSON.parse(session.sensor_map) as Record<
        string,
        {
          sensorId?: string; sensorType?: string; name?: string;
          role?: string; source?: string;
        }
      >;
      // Sessions recorded before the source was pinned fall back to the local
      // CSVs, by the platform's spelling of the name. That is the enrichment
      // role the CSVs already have, and the question is element-independent:
      // a `Quelle` says how a channel behaves, not what this element means by
      // it. A name the CSVs do not know stays undefined, which keeps the
      // sensor off the grid — the per-sensor route costs bandwidth, the grid
      // would cost the truth.
      const csvMeta = getSensorMetaLookup();
      for (const [key, entry] of Object.entries(map)) {
        if (!entry?.sensorId) continue;
        const source = entry.source
          ?? (entry.name ? csvMeta.get(entry.name)?.source : undefined);
        sensorMeta.set(entry.sensorId, {
          name: entry.name, role: entry.role, type: entry.sensorType, source,
        });
        sensorKeys.set(entry.sensorId, key);
      }
    } catch {}
  }
  const sensorName = (id: string) =>
    sensorMeta.get(id)?.name ?? sensorKeys.get(id) ?? id;

  const groups = getSessionUploadGroups(sessionId);
  const reduction = getReductionConfig();

  // The CSV route needs a grid; `validateReduction` refuses the combination,
  // but a kiosk whose settings predate that check must not produce a sparse
  // CSV, so the guard is repeated where it decides something.
  let plan: CsvUploadPlan | null = null;
  if (reduction.uploadMode === 'csv' && reduction.uploadBucketMs > 0) {
    plan = planCsvUpload(groups, sensorMeta, {
      bucketMs: reduction.uploadBucketMs,
      maxHoldMs: holdMsFor(reduction.uploadBucketMs),
    });
    log.info(
      'Session %d: %d readings of %d sensor(s) reduced to %d row(s) in %d CSV chunk(s) at %d ms; %d sensor(s) keep their own instants',
      sessionId,
      groups.reduce((n, g) => n + g.readings.length, 0),
      plan.gridded.length,
      plan.chunks.reduce((n, c) => n + c.rows, 0),
      plan.chunks.length,
      reduction.uploadBucketMs,
      plan.leftovers.length,
    );
  }

  // The depth readings a geology boundary was dated at, which the grid re-dates
  // and implenia-web pairs by exact millisecond. Built from the session rather
  // than from the pending groups, and sent whenever the grid is in play — on a
  // retry the chunks that gridded them have already been marked uploaded, and
  // the boundary would otherwise be left pointing at nothing.
  //
  // Only when the depth series was actually gridded, though: nothing needs
  // pinning back into a series that was never thinned. A depth sensor the grid
  // refused — no `source` the session could pin and a name the CSVs do not
  // know — goes out per sensor at full resolution, and an extra batch of the
  // same readings would be redundant work that still counts in `sensorsTotal`,
  // so a transient failure of it alone would hold the element open and offer
  // the operator a retry for an upload in which every reading had landed.
  const griddedNames = new Set(plan?.gridded ?? []);
  let pinned: PinnedBatch | null = plan ? anchorBatch(sessionId, sensorMeta) : null;
  if (pinned && !griddedNames.has(pinned.name)) pinned = null;
  if (pinned) {
    log.info(
      'Session %d: pinning %d %s reading(s) at geology instants alongside the grid',
      sessionId, pinned.readings.length, pinned.name,
    );
  }

  let chunks = plan?.chunks ?? [];
  let perSensorGroups = plan ? plan.leftovers : groups;

  let sensorsTotal = chunks.length + perSensorGroups.length + (pinned ? 1 : 0);
  let sensorsCompleted = 0;
  let sensorsFailed = 0;
  let unit: UploadProgress['unit'] = chunks.length > 0 ? 'paket' : 'sensor';

  const report = (currentSensor: string | null) => {
    onProgress?.({
      sessionId, sensorsTotal, sensorsCompleted, sensorsFailed, currentSensor, unit,
    });
  };

  if (chunks.length > 0) {
    const csv = await uploadCsvChunks(session, chunks, {
      report,
      onChunkDone: (ok) => { if (ok) sensorsCompleted++; else sensorsFailed++; },
    });
    if (csv.fallback) {
      // The first chunk was refused in a way that says this route will not work
      // at all on this backend or for these sensor names. Nothing has been
      // written yet, so the whole session can take the id-addressed per-sensor
      // path instead — the one that has always worked. Only the first chunk
      // decides this: a later failure is an ordinary transport failure, which
      // costs that chunk and is retried.
      log.warn(
        'Session %d: CSV upload not usable (%s) — falling back to the per-sensor upload',
        sessionId, csv.reason,
      );
      chunks = [];
      perSensorGroups = groups;
      // Nothing was gridded, so nothing needs pinning back in.
      pinned = null;
      sensorsTotal = groups.length;
      sensorsCompleted = 0;
      sensorsFailed = 0;
      unit = 'sensor';
    }
  }

  if (pinned) {
    report(pinned.name);
    try {
      await fetchImplenia(
        `/api/v1/sensor-${pinned.sensorType}/${pinned.sensorId}/batch`,
        {
          method: 'POST',
          body: {
            readings: pinned.readings.map((r) => ({
              date: new Date(r.receivedAt).toISOString(),
              value: r.value,
            })),
          },
        },
      );
      sensorsCompleted++;
    } catch (err) {
      // No reading ids to mark — the chunk that gridded them owns those. What
      // this failure must do is keep the session off `uploaded`, so the element
      // is not completed on a geology profile nothing can reassemble, and the
      // recording bar offers the retry that runs this again.
      sensorsFailed++;
      log.error(
        'Pinning %d %s reading(s) at geology instants failed for session %d: %s',
        pinned.readings.length, pinned.name, sessionId, (err as Error).message,
      );
    }
  }

  for (const group of perSensorGroups) {
    report(sensorName(group.sensorId));

    const allIds = group.readings.map((r) => r.id);

    // Deduplicate by timestamp — at high ingest rates (replay 60x, fast MQTT)
    // multiple readings can share the same millisecond. The backend's ON CONFLICT
    // rejects batches with duplicate dates, so we keep the last value per timestamp.
    const byDate = new Map<string, number | string | null>();
    let coerced = 0;
    for (const r of group.readings) {
      const raw = r.valueNumeric ?? r.valueText ?? null;
      const value = uploadValue(raw, group.sensorType);
      if (value === null && raw !== null) coerced++;
      byDate.set(new Date(r.receivedAt).toISOString(), value);
    }
    if (coerced > 0) {
      log.warn(
        'Sensor %s: %d non-numeric reading(s) uploaded as gaps',
        sensorName(group.sensorId), coerced,
      );
    }

    // Null readings mark sensor outages — keep the first and last of each
    // consecutive null run so the gap boundaries are visible in the backend,
    // but don't send every null at full ingest rate.
    const deduped = Array.from(byDate, ([date, value]) => ({ date, value }));
    const uploadable: { date: string; value: number | string | null }[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const r = deduped[i];
      if (r.value !== null) {
        uploadable.push(r);
      } else {
        const prevNull = i > 0 && deduped[i - 1].value === null;
        const nextNull = i < deduped.length - 1 && deduped[i + 1].value === null;
        // Keep first null (prev is non-null or start) and last null (next is non-null or end)
        if (!prevNull || !nextNull) {
          uploadable.push(r);
        }
      }
    }

    if (uploadable.length === 0) {
      sensorsCompleted++;
      markSessionReadingsUploaded(allIds);
      continue;
    }
    try {
      // Upload in chunks — the backend rejects payloads above its body-size limit
      const CHUNK_SIZE = 5000;
      for (let i = 0; i < uploadable.length; i += CHUNK_SIZE) {
        const chunk = uploadable.slice(i, i + CHUNK_SIZE);
        await fetchImplenia(
          `/api/v1/sensor-${group.sensorType}/${group.sensorId}/batch`,
          { method: 'POST', body: { readings: chunk } },
        );
      }
      markSessionReadingsUploaded(allIds);
      sensorsCompleted++;
    } catch (err) {
      markSessionReadingsFailed(allIds);
      sensorsFailed++;
      log.error(
        'Upload failed for sensor %s (%s, %d readings): %s',
        sensorName(group.sensorId), group.sensorType, uploadable.length, (err as Error).message,
      );
    }
  }

  const finalStatus: Session['status'] = sensorsFailed === 0 ? 'uploaded' : 'partial';
  updateSessionStatus(sessionId, finalStatus);

  // Only an upload that actually put readings on the platform finishes the
  // element. A session with nothing to send also ends as `uploaded` — it has
  // no pending rows, which is the case for an empty session and for one whose
  // every reading was clipped as a Rohrwechsel — and stamping an
  // Ausführungsdatum for it would report a pillar as produced on the strength
  // of no data at all, and drop it out of the shift assignment.
  if (finalStatus === 'uploaded' && getSessionStats(sessionId).uploaded > 0) {
    await autoMarkComplete(session);
  }

  // Final progress
  report(null);

  log.info('Upload complete for session %d: %d ok, %d failed', sessionId, sensorsCompleted, sensorsFailed);
  return { status: finalStatus };
}

export function getRecordingState(): RecordingState {
  // Check for active recording first
  const active = getActiveSession();
  if (active) {
    return {
      active: true,
      sessionId: active.id,
      elementName: active.element_name,
      startedAt: active.started_at,
      readingCount: getSessionReadingCount(active.id),
      rohrwechsel: ingestion.drillStatus,
      operatingMode: ingestion.operatingMode,
      depthCorrection: ingestion.depthCorrection,
    };
  }

  // Check for most recent ended session (pending upload) — only if it has readings
  const recent = getMostRecentSession();
  if (recent && (recent.status === 'ended' || recent.status === 'uploading' || recent.status === 'partial')) {
    const count = getSessionReadingCount(recent.id);
    if (count > 0) {
      const storedMode = recent.operating_mode;
      return {
        active: false,
        sessionId: recent.id,
        elementName: recent.element_name,
        startedAt: recent.started_at,
        readingCount: count,
        rohrwechsel: null,
        operatingMode: storedMode && isOperatingMode(storedMode) ? storedMode : null,
        depthCorrection: null,
      };
    }
  }

  return {
    active: false, sessionId: null, elementName: null, startedAt: null,
    readingCount: 0, rohrwechsel: null, operatingMode: null, depthCorrection: null,
  };
}

/**
 * Stamp the element's Ausführungsdatum after a successful upload.
 *
 * The completion sensor is resolved from the session that was just uploaded,
 * not from the sensor CSVs: the write goes to the platform's batch endpoint
 * keyed by sensor *name* (`string_sensors: { Ausführungsdatum: … }`), so a
 * name the element does not actually carry is a write that either fails or
 * lands somewhere nobody reads. The session knows which of its own sensors
 * holds the role. See `sensorNameByRole`.
 */
async function autoMarkComplete(session: Session): Promise<void> {
  const elementName = session.element_name;
  const completionSensor = sensorNameByRole(parseSensorMap(session.sensor_map), 'is_completed');
  if (!completionSensor) {
    log.warn('No is_completed sensor found — skipping auto-completion for "%s"', elementName);
    return;
  }

  const stamp = completionStamp();
  try {
    await writeElementCompletion(elementName, completionSensor, stamp);
    log.info(
      'Auto-marked element "%s" as complete (Ausführungsdatum = %s)',
      elementName,
      stamp,
    );
  } catch (err) {
    log.error(
      'Failed to auto-mark element "%s" as complete: %s',
      elementName,
      (err as Error).message,
    );
  }
}

/**
 * Upload a session in the background, broadcasting progress via the provided
 * callback. Errors are logged, never thrown — the session stays `ended` or
 * `partial` for retry.
 */
export async function tryAutoUpload(
  sessionId: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  try {
    await uploadSession(sessionId, onProgress);
  } catch (err) {
    log.error('Auto-upload failed for session %d: %s', sessionId, (err as Error).message);
  }
}

/**
 * Upload every session still waiting in `ended` or `partial`.
 *
 * Sequential on purpose: these run against the same API the live upload uses,
 * and a site on a mobile link does not benefit from racing them.
 */
async function uploadPendingSessions(
  reason: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> {
  for (const s of getSessions()) {
    if (s.status !== 'ended' && s.status !== 'partial') continue;
    if (getSessionReadingCount(s.id) === 0) continue;
    log.info('%s — auto-uploading session %d ("%s")', reason, s.id, s.element_name);
    await tryAutoUpload(s.id, onProgress);
  }
}

/**
 * Watch connectivity and upload any sessions waiting in `ended` or `partial`
 * status when the kiosk comes back online.
 */
export function autoUploadOnConnectivity(
  onProgress?: (progress: UploadProgress) => void,
): void {
  connectivity.on('online', () => {
    void uploadPendingSessions('Connectivity restored', onProgress);
  });
}

/**
 * Upload sessions left waiting by a restart, once at boot.
 *
 * The connectivity watcher only fires on a transition, so a kiosk that was
 * already online when it started would otherwise sit on a finished element
 * until the link happened to drop and come back. That session also blocks the
 * recording bar, so waiting for a coincidence is the wrong default.
 *
 * Not awaited by the caller: boot must not block on the network.
 */
export function uploadPendingSessionsAtBoot(
  onProgress?: (progress: UploadProgress) => void,
): void {
  if (!connectivity.isOnline()) return;
  void uploadPendingSessions('Pending upload found at startup', onProgress);
}
