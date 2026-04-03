import { fetchImplenia } from './implenia-api.js';
import { fetchHerstellenSensors, type SensorDefs } from './herstellen-sensors.js';
import { mqttClient, type SensorMapEntry } from './mqtt.js';
import {
  createSession,
  endSession,
  getActiveSession,
  getMostRecentSession,
  getSessionById,
  getSessionUploadGroups,
  getSessionReadingCount,
  markSessionReadingsUploaded,
  markSessionReadingsFailed,
  resetFailedReadings,
  updateSessionStatus,
  type Session,
} from './db.js';

// --- Types ---

export interface RecordingState {
  active: boolean;
  sessionId: number | null;
  elementName: string | null;
  startedAt: number | null;
  readingCount: number;
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
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
    throw new Error(`Already recording session ${existing.id} for "${existing.element_name}"`);
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
  mqttClient.startRecording(sessionId, sensorMap);

  console.log(`[Recording] Started session ${sessionId} for "${elementName}" with ${sensorMap.size} sensors`);
  return { sessionId };
}

export function endRecording(): { sessionId: number } {
  const session = getActiveSession();
  if (!session) {
    throw new Error('No active recording session');
  }

  mqttClient.stopRecording();
  endSession(session.id);

  console.log(`[Recording] Ended session ${session.id}`);
  return { sessionId: session.id };
}

export async function uploadSession(
  sessionId: number,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ status: Session['status'] }> {
  const session = getSessionById(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Reset any previously failed readings so they get retried
  resetFailedReadings(sessionId);
  updateSessionStatus(sessionId, 'uploading');

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

    // Build batch payload — string sensors must send string values
    const isStringSensor = group.sensorType === 'string';
    const readings = group.readings.map((r) => {
      const raw = r.valueNumeric ?? r.valueText ?? null;
      return {
        date: new Date(r.receivedAt).toISOString(),
        value: isStringSensor && raw !== null ? String(raw) : raw,
      };
    });

    const ids = group.readings.map((r) => r.id);

    try {
      await fetchImplenia(
        `/api/v1/sensor-${group.sensorType}/${group.sensorId}/batch`,
        { method: 'POST', body: { readings } },
      );
      markSessionReadingsUploaded(ids);
      sensorsCompleted++;
    } catch (err) {
      markSessionReadingsFailed(ids);
      sensorsFailed++;
      console.error(`[Recording] Upload failed for sensor ${group.sensorId}:`, (err as Error).message);
    }
  }

  const finalStatus: Session['status'] = sensorsFailed === 0 ? 'uploaded' : 'partial';
  updateSessionStatus(sessionId, finalStatus);

  // Final progress
  onProgress?.({
    sessionId,
    sensorsTotal,
    sensorsCompleted,
    sensorsFailed,
    currentSensor: null,
  });

  console.log(`[Recording] Upload complete for session ${sessionId}: ${sensorsCompleted} ok, ${sensorsFailed} failed`);
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
    };
  }

  // Check for most recent ended session (pending upload) — only if it has readings
  const recent = getMostRecentSession();
  if (recent && (recent.status === 'ended' || recent.status === 'uploading' || recent.status === 'partial')) {
    const count = getSessionReadingCount(recent.id);
    if (count > 0) {
      return {
        active: false,
        sessionId: recent.id,
        elementName: recent.element_name,
        startedAt: recent.started_at,
        readingCount: count,
      };
    }
  }

  return { active: false, sessionId: null, elementName: null, startedAt: null, readingCount: 0 };
}
