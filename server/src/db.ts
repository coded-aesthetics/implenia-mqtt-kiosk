import Database from 'better-sqlite3';
import path from 'node:path';

export interface Reading {
  id: number;
  topic: string;
  payload: string;
  received_at: number;
  status: 'pending' | 'uploaded' | 'failed';
  uploaded_at: number | null;
}

export interface QueueStats {
  pending: number;
  uploaded: number;
  failed: number;
}

const DB_PATH = path.join(process.cwd(), 'kiosk.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');

// Run migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    received_at INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    uploaded_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_readings_status ON readings(status);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Prepared statements
const insertReadingStmt = db.prepare(
  'INSERT INTO readings (topic, payload, received_at) VALUES (?, ?, ?)'
);

const getPendingStmt = db.prepare(
  'SELECT * FROM readings WHERE status = ? ORDER BY received_at ASC LIMIT ?'
);

const markUploadedStmt = db.prepare(
  'UPDATE readings SET status = ?, uploaded_at = ? WHERE id = ?'
);

const markFailedStmt = db.prepare(
  'UPDATE readings SET status = ? WHERE id = ?'
);

const statsStmt = db.prepare(
  'SELECT status, COUNT(*) as count FROM readings GROUP BY status'
);

const getRecentStmt = db.prepare(
  'SELECT * FROM readings ORDER BY received_at DESC LIMIT ?'
);

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function insertReading(topic: string, payload: string): void {
  insertReadingStmt.run(topic, payload, Date.now());
}

export function getPendingReadings(limit = 50): Reading[] {
  return getPendingStmt.all('pending', limit) as Reading[];
}

export function markUploaded(ids: number[]): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const id of ids) {
      markUploadedStmt.run('uploaded', now, id);
    }
  });
  tx();
}

export function markFailed(ids: number[]): void {
  const tx = db.transaction(() => {
    for (const id of ids) {
      markFailedStmt.run('failed', id);
    }
  });
  tx();
}

export function getStats(): QueueStats {
  const rows = statsStmt.all() as { status: string; count: number }[];
  const stats: QueueStats = { pending: 0, uploaded: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof QueueStats] = row.count;
    }
  }
  return stats;
}

export function getRecentReadings(limit = 100): Reading[] {
  return getRecentStmt.all(limit) as Reading[];
}

export function getMeta(key: string): string | undefined {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}

export function close(): void {
  db.close();
}
