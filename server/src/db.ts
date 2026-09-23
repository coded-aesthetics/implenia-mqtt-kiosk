import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';

// --- Types ---

export interface Session {
  id: number;
  site_id: string;
  element_name: string;
  sensor_map: string; // JSON
  started_at: number;
  ended_at: number | null;
  status: 'recording' | 'ended' | 'uploading' | 'uploaded' | 'partial';
}

export interface SessionStats {
  total: number;
  uploaded: number;
  failed: number;
  pending: number;
  /** Readings recorded during a Rohrwechsel. Kept locally, never uploaded. */
  clipped: number;
}

/**
 * Upload status of a reading recorded while the Klemmbacke was closed.
 *
 * Kept out of every upload and every export: the upload query only picks up
 * 'pending', so these never reach the Implenia API. The rows stay in the
 * database — the measurements are not lost, they are just not drilling data.
 *
 * Not terminal, though. A threshold set slightly wrong clips readings that
 * were drilling data after all, and a worker who cannot undo that has lost a
 * shift they can neither upload nor export. `unclipSessionReadings` is the way
 * back, and the recording bar offers it whenever a session has clipped rows.
 */
export const CLIPPED_STATUS = 'clipped';

export interface SessionUploadGroup {
  sensorId: string;
  sensorType: string;
  readings: { id: number; valueNumeric: number | null; valueText: string | null; receivedAt: number }[];
}

export interface SessionReadingRow {
  topic: string;
  valueNumeric: number | null;
  valueText: string | null;
  receivedAt: number;
}

/** Options for a recorded reading beyond its value. All optional. */
export interface SessionReadingOptions {
  /** Timestamp to record. Defaults to Date.now() — overridden during replay. */
  receivedAt?: number;
  /** The uncorrected value, when `valueNumeric` carries a corrected one. */
  valueRaw?: number | null;
  /** Which drilling phase this reading was taken in. */
  phase?: 'bohren' | 'rohrwechsel';
  /** Record it, but keep it out of every upload and export. */
  clipped?: boolean;
}

export interface BufferRow {
  id: number;
  topic: string;
  payload: string;
  received_at: number;
}

export interface DeviceRow {
  id: number;
  label: string;
  port: string | null;
  baud: number;
  type: 'elvis' | 'simulator';
}

export interface MappingRow {
  device_id: number;
  value_index: number;
  sensor_name: string;
}

// --- Init ---

const DB_PATH = config.DB_PATH ?? path.join(process.cwd(), 'kiosk.db');

/** Which database this process opened. Lets tests refuse to run on a real one. */
export function databasePath(): string {
  return DB_PATH;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations — drop old readings table, create new schema
db.exec(`
  DROP TABLE IF EXISTS readings;

  CREATE TABLE IF NOT EXISTS mqtt_buffer (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mqtt_buffer_time ON mqtt_buffer(received_at);

  CREATE TABLE IF NOT EXISTS recording_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id      TEXT    NOT NULL DEFAULT 'default',
    element_name TEXT    NOT NULL,
    sensor_map   TEXT    NOT NULL,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    status       TEXT    NOT NULL DEFAULT 'recording'
  );

  CREATE TABLE IF NOT EXISTS session_readings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    topic         TEXT    NOT NULL,
    sensor_id     TEXT,
    sensor_type   TEXT,
    value_numeric REAL,
    value_text    TEXT,
    received_at   INTEGER NOT NULL,
    upload_status TEXT    NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_sr_session ON session_readings(session_id);
  CREATE INDEX IF NOT EXISTS idx_sr_upload ON session_readings(session_id, sensor_id, upload_status);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT    NOT NULL,
    port  TEXT,
    baud  INTEGER NOT NULL DEFAULT 9600,
    type  TEXT    NOT NULL DEFAULT 'elvis'
  );

  CREATE TABLE IF NOT EXISTS session_exports (
    session_id  INTEGER NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    stream      TEXT    NOT NULL,
    exported_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, stream)
  );

  CREATE TABLE IF NOT EXISTS topic_overrides (
    topic       TEXT    PRIMARY KEY,
    sensor_name TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sensor_calibration (
    sensor_name TEXT    PRIMARY KEY,
    scale       REAL    NOT NULL DEFAULT 1,
    offset      REAL    NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sensor_mappings (
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    value_index INTEGER NOT NULL CHECK(value_index >= 0 AND value_index < 15),
    sensor_name TEXT    NOT NULL,
    PRIMARY KEY (device_id, value_index)
  );
`);

// --- Additive migrations ---
//
// Columns added after the first release. They live here, ahead of every
// prepared statement, because a statement naming a column that has not been
// added yet throws at import time — which on a kiosk means a boot loop.
{
  const sessionCols = db.prepare('PRAGMA table_info(recording_sessions)').all() as { name: string }[];
  const has = (name: string): boolean => sessionCols.some((c) => c.name === name);

  // A session that has been exported to USB counts as "safe" for the reset
  // guard, even if it was never uploaded.
  if (!has('exported_at')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN exported_at INTEGER');
  }
  // Rohrverlängerung bookkeeping (see rohrwechsel.ts), persisted on every
  // phase change so a PM2 restart mid-element does not lose which phase the
  // rig is in or how many Bohrrohre are down.
  if (!has('drill_state')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN drill_state TEXT');
  }
  // Which operation the rig is performing. Rohrwechsel clipping only applies
  // while drilling — during Verpressen the Klemmbacke holds the string and is
  // closed most of the time, so clipping on it would discard the grouting data.
  if (!has('operating_mode')) {
    db.exec("ALTER TABLE recording_sessions ADD COLUMN operating_mode TEXT NOT NULL DEFAULT 'bohren'");
  }
}

{
  const readingCols = db.prepare('PRAGMA table_info(session_readings)').all() as { name: string }[];
  const has = (name: string): boolean => readingCols.some((c) => c.name === name);

  // Which drilling phase a reading was taken in.
  if (!has('phase')) {
    db.exec("ALTER TABLE session_readings ADD COLUMN phase TEXT NOT NULL DEFAULT 'bohren'");
  }
  // On a rig that publishes the Schlittenweg rather than an absolute depth,
  // `value_numeric` carries the corrected depth so upload and export need no
  // knowledge of the correction, and `value_raw` keeps the reading exactly as
  // it arrived — which is what makes a wrong offset reconstructable instead of
  // lost. Null whenever nothing was corrected.
  if (!has('value_raw')) {
    db.exec('ALTER TABLE session_readings ADD COLUMN value_raw REAL');
  }
}

// --- Prepared statements ---

// Buffer
const insertBufferStmt = db.prepare(
  'INSERT INTO mqtt_buffer (topic, payload, received_at) VALUES (?, ?, ?)'
);
const pruneBufferStmt = db.prepare(
  'DELETE FROM mqtt_buffer WHERE received_at < ?'
);
const getBufferRangeStmt = db.prepare(
  'SELECT * FROM mqtt_buffer WHERE received_at >= ? AND received_at <= ? ORDER BY received_at ASC'
);

// Sessions
const createSessionStmt = db.prepare(
  'INSERT INTO recording_sessions (element_name, sensor_map, started_at, site_id) VALUES (?, ?, ?, ?)'
);
const endSessionStmt = db.prepare(
  'UPDATE recording_sessions SET ended_at = ?, status = ? WHERE id = ?'
);
const getActiveSessionStmt = db.prepare(
  "SELECT * FROM recording_sessions WHERE status = 'recording' LIMIT 1"
);
const getMostRecentSessionStmt = db.prepare(
  'SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT 1'
);
const updateSessionStatusStmt = db.prepare(
  'UPDATE recording_sessions SET status = ? WHERE id = ?'
);
const getSessionsStmt = db.prepare(
  'SELECT * FROM recording_sessions ORDER BY started_at DESC'
);
const getSessionByIdStmt = db.prepare(
  'SELECT * FROM recording_sessions WHERE id = ?'
);

// Session readings
const insertSessionReadingStmt = db.prepare(
  `INSERT INTO session_readings
     (session_id, topic, sensor_id, sensor_type, value_numeric, value_text, received_at,
      phase, upload_status, value_raw)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const getSessionReadingCountStmt = db.prepare(
  'SELECT COUNT(*) as count FROM session_readings WHERE session_id = ?'
);
// Clipped readings are excluded deliberately: the USB export is the offline
// counterpart of the batch upload, and both must hand implenia-web the same
// drilling data. Rohrwechsel readings stay on the kiosk.
const getAllSessionReadingsStmt = db.prepare(`
  SELECT topic, value_numeric, value_text, received_at
  FROM session_readings
  WHERE session_id = ? AND upload_status != 'clipped'
  ORDER BY received_at ASC
`);

// Upload groups: get distinct sensor groups with pending readings
const getUploadGroupsStmt = db.prepare(`
  SELECT sensor_id, sensor_type
  FROM session_readings
  WHERE session_id = ? AND upload_status = 'pending' AND sensor_id IS NOT NULL
  GROUP BY sensor_id, sensor_type
`);
const getGroupReadingsStmt = db.prepare(`
  SELECT id, value_numeric, value_text, received_at
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ? AND upload_status = 'pending'
  ORDER BY received_at ASC
`);

// Stats
const sessionStatsStmt = db.prepare(`
  SELECT upload_status, COUNT(*) as count
  FROM session_readings
  WHERE session_id = ?
  GROUP BY upload_status
`);

// Meta
const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const deleteMetaStmt = db.prepare('DELETE FROM meta WHERE key = ?');

// --- Buffer functions ---

export function insertBuffer(topic: string, payload: string, receivedAt?: number): void {
  insertBufferStmt.run(topic, payload, receivedAt ?? Date.now());
}

export function pruneBuffer(maxAgeMs = 86_400_000): void {
  pruneBufferStmt.run(Date.now() - maxAgeMs);
}

/**
 * Drop the live buffer. Only for when its contents stop meaning anything —
 * a changed broker, a reset. Recorded measurements live in session_readings
 * and are untouched by this.
 */
export function clearBuffer(): void {
  db.prepare('DELETE FROM mqtt_buffer').run();
}

/**
 * Distinct topics observed since `since`, with their most recent payload.
 *
 * Every message is written to mqtt_buffer before any sensor mapping is
 * attempted, so this sees topics the kiosk cannot yet match to a sensor —
 * which is exactly what the setup wizard needs to show.
 */
const getObservedTopicsStmt = db.prepare(`
  SELECT b.topic,
         b.payload      AS last_payload,
         b.received_at  AS last_seen,
         c.n            AS count
  FROM mqtt_buffer b
  JOIN (
    SELECT topic, MAX(id) AS max_id, COUNT(*) AS n
    FROM mqtt_buffer
    WHERE received_at >= ?
    GROUP BY topic
  ) c ON c.max_id = b.id
  ORDER BY b.topic
`);

export interface ObservedTopic {
  topic: string;
  lastPayload: string;
  lastSeen: number;
  count: number;
}

export function getObservedTopics(since: number): ObservedTopic[] {
  const rows = getObservedTopicsStmt.all(since) as {
    topic: string; last_payload: string; last_seen: number; count: number;
  }[];
  return rows.map((r) => ({
    topic: r.topic,
    lastPayload: r.last_payload,
    lastSeen: r.last_seen,
    count: r.count,
  }));
}

export function getBufferRange(from: number, to: number): BufferRow[] {
  return getBufferRangeStmt.all(from, to) as BufferRow[];
}

// --- Session functions ---

export function createSession(elementName: string, sensorMapJson: string, siteId = 'default'): number {
  const result = createSessionStmt.run(elementName, sensorMapJson, Date.now(), siteId);
  return result.lastInsertRowid as number;
}

export function endSession(id: number): void {
  endSessionStmt.run(Date.now(), 'ended', id);
}

export function getActiveSession(): Session | null {
  return (getActiveSessionStmt.get() as Session) ?? null;
}

export function getMostRecentSession(): Session | null {
  return (getMostRecentSessionStmt.get() as Session) ?? null;
}

export function getSessionById(id: number): Session | null {
  return (getSessionByIdStmt.get(id) as Session) ?? null;
}

export function updateSessionStatus(id: number, status: Session['status']): void {
  updateSessionStatusStmt.run(status, id);
}

export function getSessions(): Session[] {
  return getSessionsStmt.all() as Session[];
}

export function deleteSessionWithReadings(id: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM session_readings WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM recording_sessions WHERE id = ?').run(id);
  })();
}

const getDrillStateStmt = db.prepare(
  'SELECT drill_state FROM recording_sessions WHERE id = ?'
);
const setDrillStateStmt = db.prepare(
  'UPDATE recording_sessions SET drill_state = ? WHERE id = ?'
);

/**
 * The persisted Rohrverlängerung state of a session, as raw JSON.
 *
 * Written on every phase change rather than every reading — those are the only
 * moments it moves at all.
 */
export function getDrillState(sessionId: number): string | null {
  const row = getDrillStateStmt.get(sessionId) as { drill_state: string | null } | undefined;
  return row?.drill_state ?? null;
}

export function setDrillState(sessionId: number, json: string): void {
  setDrillStateStmt.run(json, sessionId);
}

const getOperatingModeStmt = db.prepare(
  'SELECT operating_mode FROM recording_sessions WHERE id = ?'
);
const setOperatingModeStmt = db.prepare(
  'UPDATE recording_sessions SET operating_mode = ? WHERE id = ?'
);

export function getOperatingMode(sessionId: number): string | null {
  const row = getOperatingModeStmt.get(sessionId) as { operating_mode: string } | undefined;
  return row?.operating_mode ?? null;
}

export function setOperatingModeRow(sessionId: number, mode: string): void {
  setOperatingModeStmt.run(mode, sessionId);
}

// --- Sensor calibration ---

export interface CalibrationRow {
  sensorName: string;
  scale: number;
  offset: number;
}

const getCalibrationsStmt = db.prepare(
  'SELECT sensor_name, scale, offset FROM sensor_calibration ORDER BY sensor_name'
);
const setCalibrationStmt = db.prepare(
  `INSERT INTO sensor_calibration (sensor_name, scale, offset, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(sensor_name) DO UPDATE SET
     scale = excluded.scale, offset = excluded.offset, updated_at = excluded.updated_at`
);
const deleteCalibrationStmt = db.prepare(
  'DELETE FROM sensor_calibration WHERE sensor_name = ?'
);

/** Every sensor with a calibration stored. Sensors absent from this are neutral. */
export function getCalibrations(): CalibrationRow[] {
  const rows = getCalibrationsStmt.all() as {
    sensor_name: string; scale: number; offset: number;
  }[];
  return rows.map((r) => ({ sensorName: r.sensor_name, scale: r.scale, offset: r.offset }));
}

export function setCalibration(sensorName: string, scale: number, offset: number): void {
  setCalibrationStmt.run(sensorName.toLowerCase(), scale, offset, Date.now());
}

export function deleteCalibration(sensorName: string): void {
  deleteCalibrationStmt.run(sensorName.toLowerCase());
}

// --- Session reading functions ---

export function insertSessionReading(
  sessionId: number,
  topic: string,
  sensorId: string | null,
  sensorType: string | null,
  valueNumeric: number | null,
  valueText: string | null,
  options: SessionReadingOptions = {},
): void {
  insertSessionReadingStmt.run(
    sessionId,
    topic,
    sensorId,
    sensorType,
    valueNumeric,
    valueText,
    options.receivedAt ?? Date.now(),
    options.phase ?? 'bohren',
    options.clipped ? CLIPPED_STATUS : 'pending',
    options.valueRaw ?? null,
  );
}

export function getSessionReadingCount(sessionId: number): number {
  const row = getSessionReadingCountStmt.get(sessionId) as { count: number };
  return row.count;
}

export interface DetailedReadingRow extends SessionReadingRow {
  /** The uncorrected value, when the stored one was corrected. */
  valueRaw: number | null;
  phase: string;
  uploadStatus: string;
}

const getDetailedReadingsStmt = db.prepare(`
  SELECT topic, value_numeric, value_raw, value_text, phase, upload_status, received_at
  FROM session_readings
  WHERE session_id = ?
  ORDER BY received_at DESC, id DESC
  LIMIT ?
`);

/**
 * Readings with their raw values and drilling phase, newest first —
 * *including* the clipped ones, which no other read path returns.
 *
 * This is the diagnostic view: it answers "why is half the drilling data
 * missing from the upload" and "why does the kiosk think the hole is this
 * deep" without anyone driving to the site.
 */
export function getSessionReadingsDetailed(sessionId: number, limit = 500): DetailedReadingRow[] {
  const rows = getDetailedReadingsStmt.all(sessionId, limit) as {
    topic: string; value_numeric: number | null; value_raw: number | null;
    value_text: string | null; phase: string; upload_status: string; received_at: number;
  }[];
  return rows.map((r) => ({
    topic: r.topic,
    valueNumeric: r.value_numeric,
    valueRaw: r.value_raw,
    valueText: r.value_text,
    phase: r.phase,
    uploadStatus: r.upload_status,
    receivedAt: r.received_at,
  }));
}

/**
 * All readings for a session that belong in the exported file — clipped ones
 * excluded, see getAllSessionReadingsStmt.
 */
export function getAllSessionReadings(sessionId: number): SessionReadingRow[] {
  const rows = getAllSessionReadingsStmt.all(sessionId) as {
    topic: string; value_numeric: number | null; value_text: string | null; received_at: number;
  }[];
  return rows.map((r) => ({
    topic: r.topic,
    valueNumeric: r.value_numeric,
    valueText: r.value_text,
    receivedAt: r.received_at,
  }));
}

export function getSessionUploadGroups(sessionId: number): SessionUploadGroup[] {
  const groups = getUploadGroupsStmt.all(sessionId) as { sensor_id: string; sensor_type: string }[];
  return groups.map((g) => {
    const rows = getGroupReadingsStmt.all(sessionId, g.sensor_id) as {
      id: number; value_numeric: number | null; value_text: string | null; received_at: number;
    }[];
    return {
      sensorId: g.sensor_id,
      sensorType: g.sensor_type,
      readings: rows.map((r) => ({
        id: r.id,
        valueNumeric: r.value_numeric,
        valueText: r.value_text,
        receivedAt: r.received_at,
      })),
    };
  });
}

export function markSessionReadingsUploaded(ids: number[]): void {
  const stmt = db.prepare("UPDATE session_readings SET upload_status = 'uploaded' WHERE id = ?");
  const tx = db.transaction(() => { for (const id of ids) stmt.run(id); });
  tx();
}

export function markSessionReadingsFailed(ids: number[]): void {
  const stmt = db.prepare("UPDATE session_readings SET upload_status = 'failed' WHERE id = ?");
  const tx = db.transaction(() => { for (const id of ids) stmt.run(id); });
  tx();
}

export function resetFailedReadings(sessionId: number): void {
  db.prepare("UPDATE session_readings SET upload_status = 'pending' WHERE session_id = ? AND upload_status = 'failed'")
    .run(sessionId);
}

/**
 * Put every clipped reading of a session back in the queue, and return how
 * many were freed.
 *
 * The escape hatch for a wrong Klemmbacke threshold. Clipping is a judgement
 * the kiosk made about which readings are drilling data, and when it got that
 * judgement wrong the readings are otherwise unreachable: not uploaded, not in
 * the exported file, and deleted by a reset. The phase stays on the row, so
 * what was released is still visible afterwards.
 */
export function unclipSessionReadings(sessionId: number): number {
  const result = db
    .prepare(
      `UPDATE session_readings SET upload_status = 'pending'
       WHERE session_id = ? AND upload_status = ?`
    )
    .run(sessionId, CLIPPED_STATUS);
  return result.changes;
}

export function getSessionStats(sessionId: number): SessionStats {
  const rows = sessionStatsStmt.all(sessionId) as { upload_status: string; count: number }[];
  const stats: SessionStats = { total: 0, uploaded: 0, failed: 0, pending: 0, clipped: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.upload_status === 'uploaded') stats.uploaded = row.count;
    else if (row.upload_status === 'failed') stats.failed = row.count;
    else if (row.upload_status === 'pending') stats.pending = row.count;
    else if (row.upload_status === CLIPPED_STATUS) stats.clipped = row.count;
  }
  return stats;
}

// --- Meta functions ---

export function getMeta(key: string): string | undefined {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}

export function deleteMeta(key: string): void {
  deleteMetaStmt.run(key);
}

// --- Device functions ---

const getDevicesStmt = db.prepare('SELECT * FROM devices ORDER BY id');
const getDeviceByIdStmt = db.prepare('SELECT * FROM devices WHERE id = ?');
const createDeviceStmt = db.prepare(
  'INSERT INTO devices (label, port, baud, type) VALUES (?, ?, ?, ?)'
);
const updateDeviceStmt = db.prepare(
  'UPDATE devices SET label = ?, port = ?, baud = ? WHERE id = ?'
);
const deleteDeviceStmt = db.prepare('DELETE FROM devices WHERE id = ?');

export function getDevices(): DeviceRow[] {
  return getDevicesStmt.all() as DeviceRow[];
}

export function getDeviceById(id: number): DeviceRow | null {
  return (getDeviceByIdStmt.get(id) as DeviceRow) ?? null;
}

export function createDevice(label: string, port: string | null, baud: number, type: string): number {
  const result = createDeviceStmt.run(label, port, baud, type);
  return result.lastInsertRowid as number;
}

export function updateDevice(id: number, label: string, port: string | null, baud: number): void {
  updateDeviceStmt.run(label, port, baud, id);
}

export function deleteDevice(id: number): void {
  deleteDeviceStmt.run(id);
}

// --- Sensor mapping functions ---

// Topic overrides: technician-assigned MQTT topic → sensor name
const getTopicOverridesStmt = db.prepare(
  'SELECT topic, sensor_name, created_at FROM topic_overrides ORDER BY topic'
);
const setTopicOverrideStmt = db.prepare(
  `INSERT INTO topic_overrides (topic, sensor_name, created_at) VALUES (?, ?, ?)
   ON CONFLICT(topic) DO UPDATE SET sensor_name = excluded.sensor_name`
);
const deleteTopicOverrideStmt = db.prepare('DELETE FROM topic_overrides WHERE topic = ?');
const deleteOverridesForSensorStmt = db.prepare(
  'DELETE FROM topic_overrides WHERE sensor_name = ?'
);

export interface TopicOverride {
  topic: string;
  sensorName: string;
  createdAt: number;
}

export function getTopicOverrides(): TopicOverride[] {
  const rows = getTopicOverridesStmt.all() as {
    topic: string; sensor_name: string; created_at: number;
  }[];
  return rows.map((r) => ({ topic: r.topic, sensorName: r.sensor_name, createdAt: r.created_at }));
}

/**
 * Bind a topic to a sensor. A sensor can only be bound once — binding it to a
 * new topic releases the old one, so two topics can never feed the same sensor
 * and silently interleave.
 */
export function setTopicOverride(topic: string, sensorName: string): void {
  const tx = db.transaction(() => {
    deleteOverridesForSensorStmt.run(sensorName);
    setTopicOverrideStmt.run(topic, sensorName, Date.now());
  });
  tx();
}

export function deleteTopicOverride(topic: string): void {
  deleteTopicOverrideStmt.run(topic);
}

const getDeviceMappingsStmt = db.prepare(
  'SELECT * FROM sensor_mappings WHERE device_id = ? ORDER BY value_index'
);
const getAllMappingsStmt = db.prepare(
  'SELECT * FROM sensor_mappings ORDER BY device_id, value_index'
);
const deleteDeviceMappingsStmt = db.prepare(
  'DELETE FROM sensor_mappings WHERE device_id = ?'
);
const insertMappingStmt = db.prepare(
  'INSERT INTO sensor_mappings (device_id, value_index, sensor_name) VALUES (?, ?, ?)'
);

export function getDeviceMappings(deviceId: number): MappingRow[] {
  return getDeviceMappingsStmt.all(deviceId) as MappingRow[];
}

export function getAllMappings(): MappingRow[] {
  return getAllMappingsStmt.all() as MappingRow[];
}

export function setDeviceMappings(
  deviceId: number,
  mappings: { valueIndex: number; sensorName: string }[],
): void {
  const tx = db.transaction(() => {
    deleteDeviceMappingsStmt.run(deviceId);
    for (const m of mappings) {
      insertMappingStmt.run(deviceId, m.valueIndex, m.sensorName);
    }
  });
  tx();
}

export function close(): void {
  db.close();
}

// --- Reset ---

const markSessionExportedStmt = db.prepare(
  'UPDATE recording_sessions SET exported_at = ? WHERE id = ?'
);

/**
 * Record that a session's data left the kiosk as a file — *all* of it.
 *
 * A session exports one file per stream, so this may only be called once every
 * stream that has data has been written. Setting it after a single stream
 * would tell the reset guard that the other streams' readings are safe to
 * delete when nothing has saved them. Callers go through markStreamExported()
 * and let getUnexportedStreams() decide.
 */
export function markSessionExported(sessionId: number): void {
  markSessionExportedStmt.run(Date.now(), sessionId);
}

const markStreamExportedStmt = db.prepare(
  `INSERT INTO session_exports (session_id, stream, exported_at) VALUES (?, ?, ?)
   ON CONFLICT(session_id, stream) DO UPDATE SET exported_at = excluded.exported_at`
);
const getExportedStreamsStmt = db.prepare(
  'SELECT stream FROM session_exports WHERE session_id = ?'
);

/** Record that one stream of a session was written to a file. */
export function markStreamExported(sessionId: number, stream: string): void {
  markStreamExportedStmt.run(sessionId, stream, Date.now());
}

/** Streams of this session that have already been written to a file. */
export function getExportedStreams(sessionId: number): string[] {
  return (getExportedStreamsStmt.all(sessionId) as { stream: string }[]).map((r) => r.stream);
}

const unsafeSummaryStmt = db.prepare(`
  SELECT COUNT(DISTINCT s.id) AS sessions, COUNT(r.id) AS readings
  FROM recording_sessions s
  JOIN session_readings r ON r.session_id = s.id
  WHERE s.exported_at IS NULL AND r.upload_status NOT IN ('uploaded', 'clipped')
`);

const clippedSummaryStmt = db.prepare(`
  SELECT COUNT(r.id) AS clipped
  FROM session_readings r
  WHERE r.upload_status = 'clipped'
`);

export interface UnsafeDataSummary {
  sessions: number;
  readings: number;
  /**
   * Readings clipped as a Rohrwechsel. They do not block a reset, but the
   * reset would delete them, so the screen has to say they are there.
   */
  clipped: number;
}

/**
 * Recorded data that exists only on this kiosk: not uploaded, and not
 * exported to a file either. The reset guard refuses while `readings` is
 * non-zero.
 *
 * Exported counts as safe deliberately — otherwise a kiosk with no
 * connectivity could never be reset, which is the dead end the guard exists
 * to prevent. Clipped readings do not block either, for the same reason: they
 * are never uploaded and never exported, so they would block a reset forever
 * on any rig that changes pipes. They are reported separately instead, because
 * a reset destroys them and telling a worker nothing is at risk while a
 * mis-clipped shift sits in the database is how that shift gets lost.
 */
export function getUnsafeDataSummary(): UnsafeDataSummary {
  const unsafe = unsafeSummaryStmt.get() as { sessions: number; readings: number };
  const { clipped } = clippedSummaryStmt.get() as { clipped: number };
  return { ...unsafe, clipped };
}

/** meta keys that survive a reset: the site's credentials, not this machine's setup. */
const RESET_PRESERVED_META = ['implenia_api_key', 'implenia_api_url'];

/**
 * Wipe this machine's setup and its recorded data, leaving the API
 * credentials in place. Callers must check getUnsafeDataSummary() first.
 */
export function resetKiosk(): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM session_readings').run();
    db.prepare('DELETE FROM session_exports').run();
    db.prepare('DELETE FROM recording_sessions').run();
    db.prepare('DELETE FROM mqtt_buffer').run();
    db.prepare('DELETE FROM sensor_mappings').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM topic_overrides').run();
    db.prepare('DELETE FROM sensor_calibration').run();
    db.prepare(
      `DELETE FROM meta WHERE key NOT IN (${RESET_PRESERVED_META.map(() => '?').join(',')})`
    ).run(...RESET_PRESERVED_META);
  });
  tx();
}
