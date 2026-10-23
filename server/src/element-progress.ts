import { parseSensorMap } from './recording.js';
import type { SensorMapEntry } from './ingestion.js';
import { findSensorNameByRole } from './sensor-meta.js';
import {
  getSessionsWithoutMaxDepth, maxDrilledValue, setSessionMaxDepth, type Session,
} from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('element-progress');

/**
 * How far an element actually got here, as one number per session.
 *
 * The element list needs to tell a pillar somebody has drilled from one nobody
 * has touched, and the phase does not answer that: it is a flag the operator
 * sets, so an element whose last session says Auffüllen may have recorded
 * nothing at all. The depth does answer it — a depth of 0 means somebody
 * started a recording, fiddled, and stopped again.
 *
 * It is computed **when the session ends** and stored on the row, rather than
 * read out of `session_readings` when somebody asks. A captured session holds
 * ~276 000 readings, of which ~27 000 are depths, and `MAX(value_numeric)` over
 * those is ~20 ms on a developer machine — several times that on the kiosk's
 * Celeron, per session, on a screen that renders every time a worker comes back
 * to the element list.
 */

/**
 * The sensor whose readings are this session's depth, by **role**.
 *
 * Never by name: it is `Bohrtiefe` for Injektionsbohren and Ankerbohren but
 * `Tiefe` for DSV. The role comes from the session's own map, which is where
 * `beginRecording` pinned it — same reasoning as `sensorNameByRole`, and first
 * match wins there too, because a map carrying one role twice is legal.
 *
 * The fallback covers sessions recorded before roles were persisted: resolve
 * the name from the local CSVs and look the id up under it. A map that answers
 * neither way yields no depth, which reads as "begonnen" on the tile — the
 * weaker claim, and the true one.
 */
function depthSensorId(map: Map<string, SensorMapEntry>): string | null {
  for (const entry of map.values()) {
    if (entry.role === 'depth') return entry.sensorId;
  }
  const name = findSensorNameByRole('depth');
  const entry = name ? map.get(name.toLowerCase()) : undefined;
  return entry?.sensorId ?? null;
}

/**
 * Compute and store how deep a session drilled. Returns the metres.
 *
 * Called when a session ends. A session this never ran for keeps `max_depth`
 * null, and `backfillMaxDepth` picks it up at the next start — which is what
 * makes a missed call site self-healing rather than a permanently blank tile.
 */
export function recordMaxDepth(session: Session): number {
  const sensorId = depthSensorId(parseSensorMap(session.sensor_map));
  const tiefe = sensorId ? maxDrilledValue(session.id, sensorId) : null;
  // 0 rather than leaving it null: null means "not computed" and would have the
  // backfill come back to a session whose answer is simply that nothing was
  // drilled. The two are the same thing to every reader anyway.
  const metres = Number.isFinite(tiefe) ? (tiefe as number) : 0;
  setSessionMaxDepth(session.id, metres);
  return metres;
}

/**
 * Fill in the depth of sessions recorded before it was being stored.
 *
 * Run once at startup, newest first and capped, rather than from the route that
 * reads it: the query is tens of milliseconds per session and better-sqlite3 is
 * synchronous, so doing a shift's worth of them inside a request would stall
 * ingestion and the WebSocket for a second or more. At startup the kiosk is
 * already not recording anything, and an update is a restart — so by the time
 * anybody looks at the element list after this release, every recent session
 * carries its depth.
 *
 * The cap is what keeps a machine that has been on site for months from paying
 * for its whole history at once. The sessions it leaves out are old ones, whose
 * elements are long off the shift assignment; their tiles say "begonnen".
 */
export function backfillMaxDepth(limit = 30): number {
  const sessions = getSessionsWithoutMaxDepth(limit);
  if (sessions.length === 0) return 0;

  const started = Date.now();
  for (const session of sessions) {
    try {
      recordMaxDepth(session);
    } catch (err) {
      // A session whose depth cannot be computed is a tile without a number,
      // which is not worth failing a startup over.
      log.warn('Could not compute the depth of session %d: %s', session.id, (err as Error).message);
    }
  }
  log.info(
    'Computed the drilled depth of %d session(s) in %d ms',
    sessions.length, Date.now() - started,
  );
  return sessions.length;
}
