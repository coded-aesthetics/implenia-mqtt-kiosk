import { fetchImplenia } from './implenia-api.js';
import { fetchHerstellenSensors, type SensorDefs } from './herstellen-sensors.js';
import { ingestion, isOperatingMode, type OperatingMode, type SensorMapEntry } from './ingestion.js';
import type { DrillStatus } from './rohrwechsel.js';
import { createLogger, onLogEntry, type LogEntry } from './logger.js';
import { config } from './config.js';
import { connectivity } from './connectivity.js';
import {
  completionStamp,
  findCompletionSensorName,
  writeElementCompletion,
} from './element-completion.js';
import {
  createSession,
  deleteClippedReadings,
  endSession,
  getActiveSession,
  getMostRecentSession,
  getSessionById,
  getSessionUploadGroups,
  getSessionReadingCount,
  getSessionStats,
  getSessions,
  insertSessionReading,
  markSessionReadingsUploaded,
  markSessionReadingsFailed,
  resetFailedReadings,
  updateSessionStatus,
  type Session,
} from './db.js';

const log = createLogger('recording');

const LOG_SENSOR_NAME = 'logs';
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
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
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

export async function beginRecording(elementName: string): Promise<{ sessionId: number }> {
  const existing = getActiveSession();
  if (existing) {
    throw new Error(`Aufzeichnung ${existing.id} für „${existing.element_name}" läuft bereits.`);
  }

  // Fetch herstellen sensors (all element sensors minus vorgaben sensors)
  const defs = await fetchHerstellenSensors(elementName);

  // Build sensor map: { topicSuffix (lowercase) -> { sensorId, sensorType, unit } }
  const sensorMap = new Map<string, SensorMapEntry>();
  const sensorMapJson: Record<string, { sensorId: string; sensorType: string; unit: string }> = {};

  for (const [key, type] of Object.entries(SENSOR_TYPE_MAP)) {
    const sensors = defs[key as keyof SensorDefs];
    if (!sensors) continue;
    for (const s of sensors) {
      const suffix = s.name.toLowerCase();
      const entry = { sensorId: s.id, sensorType: type };
      sensorMap.set(suffix, entry);
      sensorMapJson[suffix] = { ...entry, unit: s.unit ?? '' };
    }
  }

  const sessionId = createSession(elementName, JSON.stringify(sensorMapJson));
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
 */
function parseSensorMap(json: string): Map<string, SensorMapEntry> {
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
    const entry = value as { sensorId?: unknown; sensorType?: unknown };
    if (typeof entry?.sensorId === 'string' && typeof entry?.sensorType === 'string') {
      map.set(key, { sensorId: entry.sensorId, sensorType: entry.sensorType });
    }
  }
  return map;
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

export async function uploadSession(
  sessionId: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ status: Session['status'] }> {
  const session = getSessionById(sessionId);
  if (!session) throw new Error(`Aufzeichnung ${sessionId} nicht gefunden.`);

  // Reset any previously failed readings so they get retried
  resetFailedReadings(sessionId);
  updateSessionStatus(sessionId, 'uploading');

  // Build reverse map: sensorId → human-readable name from the persisted sensor map
  const sensorNames = new Map<string, string>();
  if (session.sensor_map) {
    try {
      const map = JSON.parse(session.sensor_map) as Record<string, { sensorId?: string }>;
      for (const [name, entry] of Object.entries(map)) {
        if (entry?.sensorId) sensorNames.set(entry.sensorId, name);
      }
    } catch {}
  }
  const sensorName = (id: string) => sensorNames.get(id) ?? id;

  const groups = getSessionUploadGroups(sessionId);
  const sensorsTotal = groups.length;
  let sensorsCompleted = 0;
  let sensorsFailed = 0;

  for (const group of groups) {
    const progress: UploadProgress = {
      sessionId,
      sensorsTotal,
      sensorsCompleted,
      sensorsFailed,
      currentSensor: group.sensorId,
    };
    onProgress?.(progress);

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

  if (finalStatus === 'uploaded') {
    const deleted = deleteClippedReadings(sessionId);
    if (deleted > 0) {
      log.info('Deleted %d clipped (Rohrwechsel) readings for session %d', deleted, sessionId);
    }
    await autoMarkComplete(session.element_name);
  }

  // Final progress
  onProgress?.({
    sessionId,
    sensorsTotal,
    sensorsCompleted,
    sensorsFailed,
    currentSensor: null,
  });

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
      };
    }
  }

  return {
    active: false, sessionId: null, elementName: null, startedAt: null,
    readingCount: 0, rohrwechsel: null, operatingMode: null,
  };
}

async function autoMarkComplete(elementName: string): Promise<void> {
  const completionSensor = findCompletionSensorName();
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
