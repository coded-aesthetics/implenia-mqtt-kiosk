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
  operating_mode: string;
  /**
   * When the rig stopped drilling: the moment the operator stepped out of
   * `bohren`. Null while still drilling, and cleared again by a step back.
   *
   * Geology reads the depth series up to this instant and no further. See
   * `drillingWindowEnd` in geology.ts for why that matters.
   */
  drilling_ended_at: number | null;
  /** When the operator signed the geology profile off, if they have. */
  geology_confirmed_at: number | null;
  /**
   * Whether the operator paused rather than finished this session.
   *
   * A paused session is an ordinary ended session in every respect but one:
   * its upload must not stamp an `Ausführungsdatum`. See `autoMarkComplete`'s
   * caller in recording.ts. Completion hangs off the *upload*, not the stop,
   * so the flag has to live on the row — the upload can run minutes later from
   * `autoUploadOnConnectivity` or a reboot, long after the pause.
   */
  paused: number;
  /**
   * The deepest drilling depth this session recorded, in metres — the one
   * number that says whether work actually happened here.
   *
   * Written once, when the session ends (`recordMaxDepth`), rather than read
   * out of `session_readings` when somebody asks: a shift's sessions hold a
   * few hundred thousand readings each, and a `MAX()` per session is ~20 ms on
   * a developer machine and several times that on the kiosk's Celeron — which
   * the element list would pay on every render.
   *
   * Null means "not computed", which is every session recorded before this
   * column existed until `backfillMaxDepth` reaches it. Readers treat null and
   * 0 alike: both mean "no depth to show", and 0 is a real answer — somebody
   * started a recording, fiddled, and paused again.
   */
  max_depth: number | null;
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

  /*
   * Both element caches are keyed by (site, name), never by name alone: a
   * bridge's piers are separate sites with separate API keys, and every one of
   * them has a P-01. See site.ts, and the rebuild migration below for the
   * tables that predate the site column.
   */
  CREATE TABLE IF NOT EXISTS element_vorgaben (
    site_id      TEXT    NOT NULL DEFAULT 'default',
    element_name TEXT    NOT NULL,
    vorgaben     TEXT    NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (site_id, element_name)
  );

  CREATE TABLE IF NOT EXISTS element_sensors (
    site_id      TEXT    NOT NULL DEFAULT 'default',
    element_name TEXT    NOT NULL,
    defs         TEXT    NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (site_id, element_name)
  );

  /*
   * The credentials of each site this kiosk has been given a key for.
   *
   * Measurements upload to the sensor ids of the site they were recorded on,
   * so they can only be sent with *that site's* key — and the site id is a
   * one-way hash, deliberately, so it cannot produce one. Without this table a
   * pier's unsent data was stranded the moment the crew moved on: every retry
   * went out under the new pier's key and came back 401, for the whole life of
   * the machine, and the only way out was retyping the old key by hand.
   *
   * Keys accumulate rather than being pruned when a site is done. Pruning
   * needs to prove no session of that site has a pending or failed reading
   * left, and getting that wrong restores the exact bug this removes — against
   * a kiosk that already stores the current key in this same table in the
   * clear, on a machine with remote access, which is the real exposure.
   */
  CREATE TABLE IF NOT EXISTS site_credentials (
    site_id    TEXT    PRIMARY KEY,
    api_url    TEXT    NOT NULL,
    api_key    TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  /*
   * Geology the operator entered live, during drilling.
   *
   * The scratchpad between a tap and the commit, and nothing else. The
   * committed profile is one JSON value in a Geologieprofil session reading;
   * these rows are what it gets built from, together with the Schichtauftrag's
   * back-fill.
   *
   * It exists because a layer now carries its own depth. The old shape stored
   * a live entry as a GeoDIN session reading dated at the exact received_at of
   * a depth reading, and recovered the depth by joining the two back together
   * -- so the timestamp *was* the depth, and an instant off by one sample
   * silently cost a layer. Here the depth is read off the latest depth reading
   * once, at the moment of the tap, and stored as a number.
   *
   * The (session_id, depth) primary key is the replace rule: a second entry at
   * the same depth corrects the first rather than stacking on it. Two ground
   * types at one depth is not a profile, and the depth stands still for the
   * whole of a Rohrverlaengerung, which is minutes of taps landing on one
   * value.
   *
   * Nothing back-filled ever goes in here. That is what makes a re-commit keep
   * its provenance for free: the old shape had to read its own committed
   * series back and strip the back-filled rows out again.
   */
  CREATE TABLE IF NOT EXISTS session_geology (
    session_id  INTEGER NOT NULL,
    depth       REAL    NOT NULL,
    nr          INTEGER NOT NULL,
    text        TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, depth)
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
  // When drilling ended, and when the operator signed off the geology — both
  // written by the step out of `bohren`, both cleared by a step back into it.
  // Persisted rather than held in memory because a PM2 restart mid-element
  // must not re-ask for a profile that was already confirmed, nor widen the
  // depth window the profile was built from.
  if (!has('drilling_ended_at')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN drilling_ended_at INTEGER');
  }
  if (!has('geology_confirmed_at')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN geology_confirmed_at INTEGER');
  }
  // Set by Pausieren, which ends the session without finishing the element:
  // no geology commit, and no Ausführungsdatum when the readings upload.
  // Defaults to 0, so every session recorded before this existed keeps
  // completing exactly as it did.
  if (!has('paused')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  }
  // How deep this session drilled, written when it ends. Nullable on purpose:
  // null is "not computed yet", which is every session that predates the
  // column. See `Session.max_depth` and `element-progress.ts`.
  if (!has('max_depth')) {
    db.exec('ALTER TABLE recording_sessions ADD COLUMN max_depth REAL');
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

/*
 * Scope the per-element caches to a site.
 *
 * Both tables were keyed by element name alone, which is not an identity: a
 * bridge's piers each have their own API key and each have a `P-01`. The rows
 * are rebuilt rather than dropped, because `element_sensors` is what lets an
 * offline site record at all — dropping it on an update would leave a kiosk
 * mid-shift unable to start an element until it saw the platform again. They
 * are stamped `default` and adopted by the first key the kiosk is given (see
 * `adoptCurrentSite`), which is the honest reading: they were cached before
 * this machine knew which site it was on.
 */
{
  /*
   * Each rebuild is one transaction. `db.exec` runs its statements one after
   * another with no implicit one, so a power cut between the DROP and the
   * RENAME — a kiosk losing power mid-boot is an ordinary Tuesday — would come
   * back with the real table gone, `…_new` orphaned, and the next boot's
   * CREATE IF NOT EXISTS quietly making an empty one. For `element_sensors`
   * that is an offline site that can no longer start a recording.
   */
  const rebuild = (sql: string): void => { db.transaction(() => db.exec(sql))(); };

  const vorgabenCols = db.prepare('PRAGMA table_info(element_vorgaben)').all() as { name: string }[];
  if (!vorgabenCols.some((c) => c.name === 'site_id')) {
    rebuild(`
      CREATE TABLE element_vorgaben_new (
        site_id      TEXT    NOT NULL DEFAULT 'default',
        element_name TEXT    NOT NULL,
        vorgaben     TEXT    NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (site_id, element_name)
      );
      INSERT INTO element_vorgaben_new (site_id, element_name, vorgaben, updated_at)
        SELECT 'default', element_name, vorgaben, updated_at FROM element_vorgaben;
      DROP TABLE element_vorgaben;
      ALTER TABLE element_vorgaben_new RENAME TO element_vorgaben;
    `);
  }

  const sensorCols = db.prepare('PRAGMA table_info(element_sensors)').all() as { name: string }[];
  if (!sensorCols.some((c) => c.name === 'site_id')) {
    rebuild(`
      CREATE TABLE element_sensors_new (
        site_id      TEXT    NOT NULL DEFAULT 'default',
        element_name TEXT    NOT NULL,
        defs         TEXT    NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (site_id, element_name)
      );
      INSERT INTO element_sensors_new (site_id, element_name, defs, updated_at)
        SELECT 'default', element_name, defs, updated_at FROM element_sensors;
      DROP TABLE element_sensors;
      ALTER TABLE element_sensors_new RENAME TO element_sensors;
    `);
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

/**
 * One topic's raw history. Filtered in SQL rather than by the caller, because
 * the range it sits in holds every other topic too: a 10-minute window on the
 * captured rig is ~21 000 rows for the ~1 500 that belong to one channel.
 *
 * `received_at` carries the only index on this table, and deliberately so —
 * see `getTopicHistory`.
 */
const getTopicHistoryStmt = db.prepare(
  `SELECT * FROM mqtt_buffer
   WHERE topic = ? AND received_at >= ? AND received_at <= ?
   ORDER BY received_at ASC`
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
/*
 * The element's own last session, whatever became of it.
 *
 * `getMostRecentSession` answers "what was this kiosk last doing"; this
 * answers "what was last done *here*", which is a different question as soon
 * as a second element has been recorded since. No status filter: an uploaded
 * session is exactly the case this exists for — a resumed element.
 *
 * `id DESC` behind `started_at DESC` because two sessions started inside one
 * millisecond is a replay, not a fiction, and a tie that resolves arbitrarily
 * would make the restored phase flip between two runs of the same data.
 *
 * Site-scoped: this decides which screen a pillar reopens on and whether it
 * needs aligning, so the previous pier's `P-01` would reopen this one's on
 * Auffüllen with its drilling treated as done.
 */
const getLastSessionForElementStmt = db.prepare(
  `SELECT * FROM recording_sessions WHERE element_name = ? AND site_id = ?
   ORDER BY started_at DESC, id DESC LIMIT 1`
);
const updateSessionStatusStmt = db.prepare(
  'UPDATE recording_sessions SET status = ? WHERE id = ?'
);
const getSessionsStmt = db.prepare(
  'SELECT * FROM recording_sessions ORDER BY started_at DESC'
);
// COALESCE because ended_at is only written by endSession(): a session uploaded
// while it was still open has none, and `new Date(null)` on the resume tile
// would read "01.01.1970".
//
// Scoped to one site, like every element-name question: a bridge's piers each
// carry a `P-01`, so without it the pier the machine just left kept filling
// the next one's „Abgeschlossene Elemente" row. See site.ts.
const getCompletedElementsStmt = db.prepare(`
  SELECT element_name, MAX(COALESCE(ended_at, started_at)) as last_upload
  FROM recording_sessions
  WHERE status = 'uploaded' AND paused = 0 AND site_id = ?
  GROUP BY element_name
  ORDER BY last_upload DESC
`);
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

// Geology needs two reads of one session's readings, both by sensor id rather
// than by topic: `session_readings.topic` holds the raw MQTT topic, which
// differs per rig, while the session's own `sensor_map` resolves a sensor name
// to the id every reading of it carries.
//
// The depth series is restricted the way the geology inversion needs it:
// `phase = 'bohren'` drops the Rohrverlängerung phantom depths (see
// rohrwechsel.ts) and `upload_status != 'clipped'` drops anything recorded
// while the Klemmbacke was closed. A boundary dated against either would sit
// at a depth the hole never had.
const getDepthSamplesStmt = db.prepare(`
  SELECT received_at, value_numeric
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ?
    AND phase = 'bohren' AND upload_status != 'clipped'
    AND value_numeric IS NOT NULL
  ORDER BY received_at ASC
`);
// The same read, bounded to the end of drilling.
//
// A separate statement rather than a `received_at <= COALESCE(?, …)` because
// better-sqlite3 prepares once and the planner is better off with the bound as
// a plain comparison. See `drillingWindowEnd` in geology.ts for what the bound
// is worth: readings taken while the rig retracts are stored with
// `phase = 'bohren'` too, so without it the depth series the geology is bounded
// by contains the whole way back up.
const getDepthSamplesUntilStmt = db.prepare(`
  SELECT received_at, value_numeric
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ?
    AND phase = 'bohren' AND upload_status != 'clipped'
    AND value_numeric IS NOT NULL
    AND received_at <= ?
  ORDER BY received_at ASC
`);
// The text counterpart of getDepthSamplesStmt, without the drilling filters.
// Geology reads the committed `Geologieprofil` value back through it — one
// value at a sentinel instant, not session data — to recover the layers a
// previous sign-off recorded as observed.
const getSensorTextSeriesStmt = db.prepare(`
  SELECT received_at, value_text
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ? AND upload_status != 'clipped'
    AND value_text IS NOT NULL
  ORDER BY received_at ASC
`);
// The same read across every session of one element, for the one value that
// is not session data: the committed `Geologieprofil`.
//
// An element worked over two shifts is two sessions, and both write their
// profile to the same sensor at the same sentinel instant -- so on the
// platform, which upserts on `(sensor_id, date)`, the second *replaces* the
// first. Geology reads the whole element back for exactly that reason: the
// later commit has to carry the earlier one's observations, or resuming an
// element to drill it deeper reports the top of the hole as planned ground
// nobody saw.
//
// Matching on `sensor_id` rather than the name is what makes that precise.
// It is the identity the platform upserts on, so these rows are exactly the
// set that shares one slot there. Two sessions that pinned different ids
// wrote to different slots, neither overwrites the other, and this correctly
// finds nothing to recover.
//
// Ordered by `(session_id, id)`, never by `received_at`: every one of these
// rows carries the same sentinel instant, so that column cannot order them
// and "the latest" would be whatever SQLite happened to return last.
const getElementSensorTextSeriesStmt = db.prepare(`
  SELECT sr.session_id, sr.value_text
  FROM session_readings sr
  JOIN recording_sessions rs ON rs.id = sr.session_id
  WHERE rs.element_name = ? AND sr.sensor_id = ?
    AND sr.upload_status != 'clipped' AND sr.value_text IS NOT NULL
  ORDER BY sr.session_id ASC, sr.id ASC
`);
// The oldest recorded value of one sensor, used to rebuild the volume tracker's
// baseline after a restart. Deliberately unfiltered beyond "has a value": the
// live tracker baselines on the first finite value it sees, clipped or not, so
// any filter here would hand a resumed session a different baseline than the
// original run had — which is the whole thing this query exists to avoid. The
// `id` tiebreak picks the first-inserted of two readings sharing a millisecond,
// which is the one the live tracker would have taken.
const getFirstSessionValueStmt = db.prepare(`
  SELECT value_numeric
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ? AND value_numeric IS NOT NULL
  ORDER BY received_at ASC, id ASC
  LIMIT 1
`);
const getLastSessionValueStmt = db.prepare(`
  SELECT value_numeric
  FROM session_readings
  WHERE session_id = ? AND sensor_id = ? AND value_numeric IS NOT NULL
  ORDER BY received_at DESC, id DESC
  LIMIT 1
`);
// The most recent reading of every topic in a session.
//
// The bare columns belong to the row holding MAX(received_at) — SQLite's
// documented behaviour for a bare column alongside MAX, and the reason this is
// one query rather than one per topic.
//
// Not filtered to unclipped: the last reading is the last reading. A restart
// during a Rohrwechsel should show the frozen hole depth, which is exactly the
// value that was recorded and clipped.
const getLatestPerTopicStmt = db.prepare(`
  SELECT topic, value_numeric, value_text, MAX(received_at) AS received_at
  FROM session_readings
  WHERE session_id = ?
  GROUP BY topic
`);
const deletePendingForSensorStmt = db.prepare(`
  DELETE FROM session_readings
  WHERE session_id = ? AND sensor_id = ? AND upload_status = 'pending'
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
         c.n            AS count,
         c.first_seen   AS first_seen
  FROM mqtt_buffer b
  JOIN (
    SELECT topic, MAX(id) AS max_id, COUNT(*) AS n, MIN(received_at) AS first_seen
    FROM mqtt_buffer
    WHERE received_at >= ?
    GROUP BY topic
  ) c ON c.max_id = b.id
  ORDER BY b.topic
`);

export interface ObservedTopic {
  topic: string;
  /**
   * The oldest message still inside the window.
   *
   * Without it `count` can only be divided by the whole window, which
   * understates a rate by as much as thirty times for a box connected two
   * minutes ago — on the screen whose job is to say whether a box is
   * publishing, in exactly the hour after a rig is connected. Free here: the
   * aggregate is already grouping over the same rows.
   */
  firstSeen: number;
  lastPayload: string;
  lastSeen: number;
  count: number;
}

export function getObservedTopics(since: number): ObservedTopic[] {
  const rows = getObservedTopicsStmt.all(since) as {
    topic: string; last_payload: string; last_seen: number; count: number; first_seen: number;
  }[];
  return rows.map((r) => ({
    topic: r.topic,
    firstSeen: r.first_seen,
    lastPayload: r.last_payload,
    lastSeen: r.last_seen,
    count: r.count,
  }));
}

export function getBufferRange(from: number, to: number): BufferRow[] {
  return getBufferRangeStmt.all(from, to) as BufferRow[];
}

/**
 * Every raw message on one topic in a time range, oldest first.
 *
 * **No index on `topic`, on purpose.** The buffer takes ~35 inserts a second on
 * the captured rig and keeps 24 h, so it reaches around three million rows; a
 * second b-tree would be maintained on the ingest path of every message, on a
 * 4 GB J1900, to speed up a query a technician opens occasionally. The window
 * is bounded instead and rides the `received_at` index — which is why the
 * caller must bound it rather than asking for the whole retention.
 */
export function getTopicHistory(topic: string, from: number, to: number): BufferRow[] {
  return getTopicHistoryStmt.all(topic, from, to) as BufferRow[];
}

// --- Session functions ---

export function createSession(
  elementName: string,
  sensorMapJson: string,
  siteId = currentSiteId(),
): number {
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

export function getLastSessionForElement(elementName: string): Session | null {
  return (getLastSessionForElementStmt.get(elementName, currentSiteId()) as Session) ?? null;
}

export function getSessionById(id: number): Session | null {
  return (getSessionByIdStmt.get(id) as Session) ?? null;
}

export function updateSessionStatus(id: number, status: Session['status']): void {
  updateSessionStatusStmt.run(status, id);
}

/**
 * Hand sessions stuck mid-upload back to the retry path. Returns how many.
 *
 * `uploading` is set for the duration of a call to uploadSession() and nowhere
 * else, so in a process that has just started it cannot be true: no upload
 * survives a restart. Left alone the row is a dead end — getRecordingState()
 * keeps reporting the session, which pins the recording bar to a reading count
 * with no upload button and no "Aufzeichnung beginnen", so the kiosk can
 * neither finish that element nor start the next one. PM2 restarts mid-upload
 * on a crash, a power cut, and every applied update.
 *
 * Readings already marked `uploaded` stay that way, so the retry resumes where
 * the interrupted attempt stopped instead of sending them twice.
 */
export function reclaimStrandedUploads(): number {
  return db.prepare(
    "UPDATE recording_sessions SET status = 'ended' WHERE status = 'uploading'"
  ).run().changes;
}

export function getSessions(): Session[] {
  return getSessionsStmt.all() as Session[];
}

export interface CompletedElement {
  elementName: string;
  lastUpload: number;
}

export function getCompletedElements(): CompletedElement[] {
  const rows = getCompletedElementsStmt.all(currentSiteId()) as
    { element_name: string; last_upload: number }[];
  return rows.map((r) => ({ elementName: r.element_name, lastUpload: r.last_upload }));
}

/** An element this kiosk has recorded, as `getStartedElements` reports it. */
export interface StartedElement {
  elementName: string;
  /**
   * The deepest drilling depth recorded here across every session, or 0 when
   * there is none to show. 0 covers two cases on purpose — a session that
   * drilled nothing, and one whose depth has not been computed yet (see
   * `Session.max_depth`) — because the honest statement about both is the
   * weaker one: somebody started a recording here.
   */
  tiefe: number;
  /** When the last session for this element ended, or started if it has not. */
  letzteAufzeichnung: number;
}

/*
 * Every element this kiosk holds a session for, deepest depth and last
 * activity.
 *
 * No status filter, deliberately: the question is "has anybody worked here",
 * and a session that is still waiting to upload, was paused, or recorded
 * nothing at all answers yes. That is the difference from
 * `getCompletedElements`, which answers "is this element finished".
 *
 * A site filter, though: "here" is this pier's `P-01`, not the previous
 * pier's. Without it an untouched pillar was marked begun — at the depth the
 * identically-named one on the site before it reached. See site.ts.
 */
const getStartedElementsStmt = db.prepare(`
  SELECT element_name,
         MAX(COALESCE(max_depth, 0)) AS tiefe,
         MAX(COALESCE(ended_at, started_at)) AS letzte
  FROM recording_sessions
  WHERE site_id = ?
  GROUP BY element_name
  ORDER BY letzte DESC
`);

export function getStartedElements(): StartedElement[] {
  const rows = getStartedElementsStmt.all(currentSiteId()) as {
    element_name: string; tiefe: number | null; letzte: number;
  }[];
  return rows.map((r) => ({
    elementName: r.element_name,
    tiefe: r.tiefe ?? 0,
    letzteAufzeichnung: r.letzte,
  }));
}

/**
 * The deepest value a session recorded for one sensor, counting real drilling
 * only.
 *
 * The same two filters every depth read in this kiosk uses: `phase = 'bohren'`
 * drops the Rohrverlängerung phantom depths (see rohrwechsel.ts) and
 * `upload_status != 'clipped'` the readings held back with them. Without them
 * the answer is the frozen depth of a pipe change, which is not a depth the
 * hole ever had.
 *
 * `bis` adds the drilling window, the same bound `getDepthSamplesUntilStmt`
 * carries and for the same reason — see `drillingWindowEnd` in geology.ts. A
 * null answer means the session recorded no value for that sensor at all,
 * which is a different statement from a depth of 0.
 */
const maxSensorValueStmt = db.prepare(`
  SELECT MAX(value_numeric) AS max FROM session_readings
  WHERE session_id = ? AND sensor_id = ?
    AND phase = 'bohren' AND upload_status != 'clipped'
`);
const maxSensorValueUntilStmt = db.prepare(`
  SELECT MAX(value_numeric) AS max FROM session_readings
  WHERE session_id = ? AND sensor_id = ?
    AND phase = 'bohren' AND upload_status != 'clipped'
    AND received_at <= ?
`);

export function maxDrilledValue(
  sessionId: number, sensorId: string, bis?: number | null,
): number | null {
  const row = (bis == null
    ? maxSensorValueStmt.get(sessionId, sensorId)
    : maxSensorValueUntilStmt.get(sessionId, sensorId, bis)) as { max: number | null } | undefined;
  return row?.max ?? null;
}

const setSessionMaxDepthStmt = db.prepare(
  'UPDATE recording_sessions SET max_depth = ? WHERE id = ?'
);

export function setSessionMaxDepth(sessionId: number, tiefe: number): void {
  setSessionMaxDepthStmt.run(tiefe, sessionId);
}

/**
 * Sessions whose depth has never been computed, newest first.
 *
 * `status != 'recording'` because a running session's depth is not final yet —
 * it is written when the session ends.
 */
const getSessionsWithoutMaxDepthStmt = db.prepare(`
  SELECT * FROM recording_sessions
  WHERE max_depth IS NULL AND status != 'recording'
  ORDER BY started_at DESC
  LIMIT ?
`);

export function getSessionsWithoutMaxDepth(limit: number): Session[] {
  return getSessionsWithoutMaxDepthStmt.all(limit) as Session[];
}

export function deleteSessionWithReadings(id: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM session_readings WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_geology WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM recording_sessions WHERE id = ?').run(id);
  })();
}

const clearSessionReadingsStmt = db.prepare(
  'DELETE FROM session_readings WHERE session_id = ?'
);

export function clearSessionReadings(id: number): void {
  clearSessionReadingsStmt.run(id);
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

const setDrillingEndedAtStmt = db.prepare(
  'UPDATE recording_sessions SET drilling_ended_at = ? WHERE id = ?'
);
const setSessionPausedStmt = db.prepare(
  'UPDATE recording_sessions SET paused = ? WHERE id = ?'
);

const setGeologyConfirmedAtStmt = db.prepare(
  'UPDATE recording_sessions SET geology_confirmed_at = ? WHERE id = ?'
);

/**
 * Mark when drilling ended, or clear it with null.
 *
 * Set by the step out of `bohren` and cleared by the step back, so a session
 * that resumes drilling widens its own geology window again rather than
 * keeping a profile built from a hole that has since got deeper.
 */
export function setDrillingEndedAt(sessionId: number, at: number | null): void {
  setDrillingEndedAtStmt.run(at, sessionId);
}

/** Mark the geology profile as signed off, or clear it with null. */
export function setGeologyConfirmedAt(sessionId: number, at: number | null): void {
  setGeologyConfirmedAtStmt.run(at, sessionId);
}

export function setSessionPaused(sessionId: number, paused: boolean): void {
  setSessionPausedStmt.run(paused ? 1 : 0, sessionId);
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

// --- Vorgaben cache ---

const setElementVorgabenStmt = db.prepare(
  `INSERT INTO element_vorgaben (site_id, element_name, vorgaben, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(site_id, element_name) DO UPDATE SET
     vorgaben = excluded.vorgaben, updated_at = excluded.updated_at`
);
const getElementVorgabenStmt = db.prepare(
  'SELECT vorgaben FROM element_vorgaben WHERE site_id = ? AND element_name = ?'
);

/**
 * Remember an element's vorgaben so the element screen still has them once the
 * element drops out of the shift assignment.
 *
 * The shift assignment only carries *unfinished* elements, and setting the
 * Ausführungsdatum after upload takes the element out of it — along with its
 * geology profile and every Soll value. A pillar spanning several days would
 * otherwise be resumed blind. Stored opaque: the shape is the UI's contract,
 * and parsing it here would only add a way to corrupt it.
 */
export function setElementVorgaben(elementName: string, vorgaben: unknown): void {
  setElementVorgabenStmt.run(currentSiteId(), elementName, JSON.stringify(vorgaben), Date.now());
}

/** Cached vorgaben for an element, or null if none were ever seen. */
export function getElementVorgaben(elementName: string): unknown | null {
  const row = getElementVorgabenStmt.get(currentSiteId(), elementName) as
    { vorgaben: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.vorgaben);
  } catch {
    // Unreadable cache is the same as no cache — the screen degrades to live
    // readings without vorgaben rather than failing to open.
    return null;
  }
}

// --- Sensor definition cache ---

const setElementSensorsStmt = db.prepare(
  `INSERT INTO element_sensors (site_id, element_name, defs, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(site_id, element_name) DO UPDATE SET
     defs = excluded.defs, updated_at = excluded.updated_at`
);
const getElementSensorsStmt = db.prepare(
  'SELECT defs FROM element_sensors WHERE site_id = ? AND element_name = ?'
);

/**
 * Remember an element's sensor definitions so a recording can be started for
 * it without the Implenia API.
 *
 * Starting a recording needs the platform's sensor *ids*: readings upload to
 * `/api/v1/sensor-<type>/<id>/batch`, and a reading stored without one is kept
 * locally and never uploadable. Resolving them is the one step of
 * `beginRecording` that used to reach the network, which made starting an
 * element the single most load-bearing thing on a site's connectivity — the
 * thing least likely to be there.
 *
 * Written from two places: every successful fetch from the API, and the
 * imported Schichtauftrag, which carries the same definitions for exactly this
 * reason. Stored unfiltered and opaque — which of them the kiosk records is
 * decided by `filterHerstellenSensors` at the moment of use, so a later sensor
 * CSV sync or a fix to that filter applies to everything already cached.
 */
export function setElementSensors(elementName: string, defs: unknown): void {
  setElementSensorsStmt.run(currentSiteId(), elementName, JSON.stringify(defs), Date.now());
}

/** Cached sensor definitions for an element, or null if none were ever seen. */
export function getElementSensors(elementName: string): unknown | null {
  const row = getElementSensorsStmt.get(currentSiteId(), elementName) as
    { defs: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.defs);
  } catch {
    // An unreadable cache is the same as no cache: the caller reports that it
    // has no definitions, which is a message the operator can act on.
    return null;
  }
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

/** One point of a numeric series recorded in a session. */
export interface SeriesPoint {
  receivedAt: number;
  value: number;
}

const insertSessionGeologyStmt = db.prepare(
  `INSERT OR REPLACE INTO session_geology (session_id, depth, nr, text, observed_at)
   VALUES (?, ?, ?, ?, ?)`,
);
const getSessionGeologyStmt = db.prepare(
  'SELECT depth, nr, text, observed_at FROM session_geology WHERE session_id = ? ORDER BY depth ASC',
);
const clearSessionGeologyStmt = db.prepare(
  'DELETE FROM session_geology WHERE session_id = ?',
);

/** One layer change the operator entered while drilling. */
export interface SessionGeologyEntry {
  /** Depth of the depth reading that was current when they tapped, in metres. */
  depth: number;
  /** DIN 4023 number. */
  nr: number;
  /** The operator's own description, where they gave one. */
  text: string | null;
  /** When the entry was made — diagnostics only; the depth is the datum. */
  observedAt: number;
}

/**
 * Record one live geology entry, replacing any entry at the same depth.
 *
 * The replace is the point: see the `session_geology` DDL. It is also what the
 * operator means — a second tap before the hole has moved is a correction.
 */
export function insertSessionGeology(
  sessionId: number, depth: number, nr: number, text: string | null, observedAt: number,
): void {
  insertSessionGeologyStmt.run(sessionId, depth, nr, text, observedAt);
}

/**
 * Drop every live geology entry of a session.
 *
 * For a replay seek, which rebuilds the session from position 0: these used to
 * be `session_readings` and went with `clearSessionReadings`, so without this
 * the layers of the run that was just discarded survive it and are committed
 * against a hole that no longer has them.
 */
export function clearSessionGeology(sessionId: number): void {
  clearSessionGeologyStmt.run(sessionId);
}

/** Every live geology entry of a session, shallowest first. */
export function getSessionGeology(sessionId: number): SessionGeologyEntry[] {
  const rows = getSessionGeologyStmt.all(sessionId) as {
    depth: number; nr: number; text: string | null; observed_at: number;
  }[];
  return rows.map((r) => ({
    depth: r.depth, nr: r.nr, text: r.text, observedAt: r.observed_at,
  }));
}

/**
 * The session's depth series: real drilling only, nothing clipped, nothing
 * without a value.
 *
 * See getDepthSamplesStmt for why each filter is there.
 */
export function getSessionDepthSamples(
  sessionId: number, sensorId: string, bis?: number | null,
): SeriesPoint[] {
  const rows = (bis == null
    ? getDepthSamplesStmt.all(sessionId, sensorId)
    : getDepthSamplesUntilStmt.all(sessionId, sensorId, bis)) as {
    received_at: number; value_numeric: number;
  }[];
  return rows.map((r) => ({ receivedAt: r.received_at, value: r.value_numeric }));
}

/** Every recorded *text* value of one sensor in a session, oldest first. */
export function getSessionSensorTextSeries(
  sessionId: number, sensorId: string,
): { receivedAt: number; text: string }[] {
  const rows = getSensorTextSeriesStmt.all(sessionId, sensorId) as {
    received_at: number; value_text: string;
  }[];
  return rows.map((r) => ({ receivedAt: r.received_at, text: r.value_text }));
}

/**
 * Every recorded text value of one sensor across an element's sessions.
 *
 * Oldest session first, and within a session oldest write first, so a reader
 * folding them in order ends on the newest assertion. Each row says which
 * session it came from, because that is what tells the caller which of them
 * are its own.
 *
 * See getElementSensorTextSeriesStmt for why this is keyed on the sensor id
 * and ordered the way it is.
 */
export function getElementSensorTextSeries(
  elementName: string, sensorId: string,
): { sessionId: number; text: string }[] {
  const rows = getElementSensorTextSeriesStmt.all(elementName, sensorId) as {
    session_id: number; value_text: string;
  }[];
  return rows.map((r) => ({ sessionId: r.session_id, text: r.value_text }));
}

export interface LatestReading {
  topic: string;
  valueNumeric: number | null;
  valueText: string | null;
  receivedAt: number;
}

/**
 * The last value recorded for each topic in a session.
 *
 * What a screen that has just loaded starts from. These are the *corrected*
 * values — calibrated, and carrying the Schlittenweg offset — because that is
 * what `insertSessionReading` stores and therefore what the browser last
 * displayed; `value_raw` keeps the original separately.
 */
export function getLatestSessionReadings(sessionId: number): LatestReading[] {
  const rows = getLatestPerTopicStmt.all(sessionId) as {
    topic: string; value_numeric: number | null; value_text: string | null; received_at: number;
  }[];
  return rows.map((r) => ({
    topic: r.topic,
    valueNumeric: r.value_numeric,
    valueText: r.value_text,
    receivedAt: r.received_at,
  }));
}

/**
 * The first value recorded for one sensor in a session, or null if it recorded
 * none.
 *
 * See getFirstSessionValueStmt for why it is unfiltered.
 */
export function getFirstSessionValue(sessionId: number, sensorId: string): number | null {
  const row = getFirstSessionValueStmt.get(sessionId, sensorId) as
    { value_numeric: number } | undefined;
  return row ? row.value_numeric : null;
}

/** The last value recorded for one sensor in a session, or null if none. */
export function getLastSessionValue(sessionId: number, sensorId: string): number | null {
  const row = getLastSessionValueStmt.get(sessionId, sensorId) as
    { value_numeric: number } | undefined;
  return row ? row.value_numeric : null;
}

/**
 * Drop a session's not-yet-uploaded readings for one sensor, and say how many
 * went.
 *
 * What makes committing a geology profile repeatable: the operator can reach
 * the confirmation screen, go back to recording, and stop again, and each
 * commit replaces the last rather than appending a second, contradictory set of
 * layers. Restricted to `pending` so it can never touch a reading already on
 * the platform — nothing the backend has would be removed by it.
 */
export function deletePendingSensorReadings(sessionId: number, sensorId: string): number {
  return deletePendingForSensorStmt.run(sessionId, sensorId).changes;
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

// --- Site credentials ---

const setSiteCredentialsStmt = db.prepare(
  `INSERT INTO site_credentials (site_id, api_url, api_key, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(site_id) DO UPDATE SET
     api_url = excluded.api_url, api_key = excluded.api_key, updated_at = excluded.updated_at`
);
const getSiteCredentialsStmt = db.prepare(
  'SELECT api_url, api_key FROM site_credentials WHERE site_id = ?'
);

export interface SiteCredentials {
  apiUrl: string;
  apiKey: string;
}

/**
 * Remember the key a site is reached with, so its measurements can still be
 * uploaded after the kiosk has moved on. Written on every `syncSite`.
 */
export function setSiteCredentials(siteId: string, apiUrl: string, apiKey: string): void {
  setSiteCredentialsStmt.run(siteId, apiUrl, apiKey, Date.now());
}

/**
 * The credentials for a site, or null if this kiosk never held them.
 *
 * Null for every session recorded before this table existed, and for one
 * recorded with no key configured at all — both of which upload under whatever
 * key is current, exactly as they did before.
 */
export function getSiteCredentials(siteId: string): SiteCredentials | null {
  const row = getSiteCredentialsStmt.get(siteId) as
    { api_url: string; api_key: string } | undefined;
  return row ? { apiUrl: row.api_url, apiKey: row.api_key } : null;
}

// --- Site scoping ---

/**
 * The site id of a kiosk that has never been given an API key.
 *
 * Also what every row recorded before sites existed carries, until the first
 * key adopts them — see `adoptCurrentSite`.
 */
export const DEFAULT_SITE = 'default';

const SITE_META_KEY = 'current_site_id';

/**
 * Which site this kiosk is working on. See site.ts for what identifies one.
 *
 * Read from meta on every call rather than cached in a module variable: it is
 * one indexed row and the alternative is a cache that goes stale in exactly
 * the situation this exists to handle.
 */
export function currentSiteId(): string {
  return getMeta(SITE_META_KEY) ?? DEFAULT_SITE;
}

/**
 * Meta keys that hold a *site's* state rather than this machine's, and so are
 * suffixed with the site id.
 *
 * The shift assignment, fetched or imported, is a list of one site's elements.
 * Served unscoped, an import made for the pier the machine just left kept
 * overriding the element list on the pier it moved to — and an import
 * overrides everything, so that one does not even degrade, it simply stays
 * wrong until somebody notices.
 */
export function siteMetaKey(base: string): string {
  const site = currentSiteId();
  return site === DEFAULT_SITE ? base : `${base}:${site}`;
}

/** The site-scoped meta keys, by their unscoped base name. */
const SITE_SCOPED_META = ['last_shift_assignment', 'imported_shift_assignment'];

/**
 * Move the kiosk to a site, adopting whatever it recorded before it knew it
 * was on one.
 *
 * **Nothing is ever deleted and nothing is re-stamped from one real site to
 * another.** A pier the machine has left keeps its rows under its own id, so
 * switching the key back brings its finished elements, its depths and its
 * cached sensor ids back with it — which is also the only way its
 * still-pending measurements can ever reach the platform.
 *
 * `default` rows are the exception, and adopting them is the honest reading
 * rather than a convenience: that id means "recorded before this kiosk knew
 * which site it was on", and the first key it is given is the answer to that
 * question. It covers both the update that introduced sites and a machine set
 * up offline from an imported Schichtauftrag and keyed afterwards — whose
 * recordings would otherwise vanish from the element list the moment a
 * technician typed the key in.
 */
export function adoptCurrentSite(siteId: string): void {
  const previous = currentSiteId();
  if (siteId === previous) return;

  const tx = db.transaction(() => {
    if (previous === DEFAULT_SITE) {
      db.prepare('UPDATE recording_sessions SET site_id = ? WHERE site_id = ?')
        .run(siteId, DEFAULT_SITE);
      /*
       * Where both exist for one element name, the site's own row wins and the
       * unattributed one is dropped — it is a cache, and a row the platform
       * served *for this site* is the better answer by definition.
       *
       * Reachable only by a kiosk that returned to `default` after holding a
       * key, which nothing currently does. It is handled rather than argued
       * away because the alternative is a UNIQUE violation thrown out of the
       * route that saves the key, which would leave the credential written and
       * the move half-applied — the one outcome worse than either row winning.
       */
      for (const table of ['element_vorgaben', 'element_sensors']) {
        db.prepare(
          `DELETE FROM ${table} WHERE site_id = ? AND element_name IN
             (SELECT element_name FROM ${table} WHERE site_id = ?)`,
        ).run(DEFAULT_SITE, siteId);
        db.prepare(`UPDATE ${table} SET site_id = ? WHERE site_id = ?`)
          .run(siteId, DEFAULT_SITE);
      }
      for (const base of SITE_SCOPED_META) {
        const value = getMeta(base);
        if (value === undefined) continue;
        // Same rule: a list already stored for this site is not overwritten by
        // the unattributed one, which is dropped either way so the next key
        // cannot adopt it a second time.
        if (getMeta(`${base}:${siteId}`) === undefined) setMeta(`${base}:${siteId}`, value);
        deleteMeta(base);
      }
    }
    setMeta(SITE_META_KEY, siteId);
  });
  tx();
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

/**
 * Run a set of writes as one transaction.
 *
 * Geology is committed by deleting the previous commit and writing the new one.
 * Without this, a failure or a PM2 restart between the two leaves the old
 * profile deleted and the new one truncated mid-way — "data integrity over
 * features", and the window is exactly when the disk is full or an update is
 * being applied.
 */
export function inTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
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

/**
 * meta keys that survive a reset: the site's credentials, not this machine's
 * setup.
 *
 * The site id belongs with them because it *is* the key, hashed — leaving it
 * behind would put the kiosk on `default` while still holding the key that
 * identifies the site, and have the next boot adopt it back.
 */
const RESET_PRESERVED_META = ['implenia_api_key', 'implenia_api_url', 'current_site_id'];

/**
 * Wipe this machine's setup and its recorded data, leaving the API
 * credentials in place. Callers must check getUnsafeDataSummary() first.
 */
export function resetKiosk(): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM session_readings').run();
    db.prepare('DELETE FROM session_geology').run();
    db.prepare('DELETE FROM session_exports').run();
    db.prepare('DELETE FROM recording_sessions').run();
    db.prepare('DELETE FROM mqtt_buffer').run();
    db.prepare('DELETE FROM sensor_mappings').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM topic_overrides').run();
    db.prepare('DELETE FROM sensor_calibration').run();
    db.prepare('DELETE FROM element_vorgaben').run();
    db.prepare('DELETE FROM element_sensors').run();
    db.prepare(
      `DELETE FROM meta WHERE key NOT IN (${RESET_PRESERVED_META.map(() => '?').join(',')})`
    ).run(...RESET_PRESERVED_META);
  });
  tx();
}

// ── Explicit transaction control (replay seek batching) ─────────────────

export function beginTransaction(): void { db.exec('BEGIN'); }
export function commitTransaction(): void { db.exec('COMMIT'); }
export function rollbackTransaction(): void { db.exec('ROLLBACK'); }
