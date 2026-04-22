import Database from 'better-sqlite3';
import path from 'node:path';

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
}

export interface SessionUploadGroup {
  sensorId: string;
  sensorType: string;
  readings: { id: number; valueNumeric: number | null; valueText: string | null; receivedAt: number }[];
}

export interface BufferRow {
  id: number;
  topic: string;
  payload: string;
  received_at: number;
}

// --- Init ---

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'kiosk.db');

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
`);

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
  'INSERT INTO session_readings (session_id, topic, sensor_id, sensor_type, value_numeric, value_text, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const getSessionReadingCountStmt = db.prepare(
  'SELECT COUNT(*) as count FROM session_readings WHERE session_id = ?'
);

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

export function insertBuffer(topic: string, payload: string): void {
  insertBufferStmt.run(topic, payload, Date.now());
}

export function pruneBuffer(maxAgeMs = 86_400_000): void {
  pruneBufferStmt.run(Date.now() - maxAgeMs);
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

// --- Session reading functions ---

export function insertSessionReading(
  sessionId: number,
  topic: string,
  sensorId: string | null,
  sensorType: string | null,
  valueNumeric: number | null,
  valueText: string | null,
): void {
  insertSessionReadingStmt.run(sessionId, topic, sensorId, sensorType, valueNumeric, valueText, Date.now());
}

export function getSessionReadingCount(sessionId: number): number {
  const row = getSessionReadingCountStmt.get(sessionId) as { count: number };
  return row.count;
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

export function getSessionStats(sessionId: number): SessionStats {
  const rows = sessionStatsStmt.all(sessionId) as { upload_status: string; count: number }[];
  const stats: SessionStats = { total: 0, uploaded: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.upload_status === 'uploaded') stats.uploaded = row.count;
    else if (row.upload_status === 'failed') stats.failed = row.count;
    else if (row.upload_status === 'pending') stats.pending = row.count;
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

export function close(): void {
  db.close();
}
