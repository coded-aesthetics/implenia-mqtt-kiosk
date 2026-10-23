import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * How deep an element got, which is what the element list labels its tiles
 * with.
 *
 * The phase cannot answer that question — it is a flag the operator sets, so a
 * session that says Auffüllen may hold nothing at all — and a tile that looks
 * exactly like an untouched one is how a worker re-drills a hole somebody is
 * halfway through.
 *
 * Two things here are easy to get wrong and silent when they are:
 * a depth resolved by sensor *name* (it is `Bohrtiefe` for Injektionsbohren and
 * `Tiefe` for DSV), and a depth taken from a Rohrverlängerung, where the
 * reading stands still at a value the hole never had.
 */

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => null,
}));

let db: typeof import('./db.js');
let meta: typeof import('./sensor-meta.js');
let progress: typeof import('./element-progress.js');

/** A session's map as `beginRecording` writes it: lowercased keys, role pinned. */
const MAP = JSON.stringify({
  bohrtiefe: {
    sensorId: 'sid-tiefe', sensorType: 'float', name: 'Bohrtiefe', role: 'depth',
  },
  klemmdruck: { sensorId: 'sid-klemm', sensorType: 'float', name: 'Klemmdruck' },
});

/** The same, under a spelling no CSV knows — the role is what resolves it. */
const ODD_NAME_MAP = JSON.stringify({
  'tiefe sonde 2': {
    sensorId: 'sid-tiefe', sensorType: 'float', name: 'Tiefe Sonde 2', role: 'depth',
  },
});

/** A session from before roles were persisted: the CSVs are the only clue. */
const LEGACY_MAP = JSON.stringify({
  tiefe: { sensorId: 'sid-tiefe', sensorType: 'float' },
});

beforeAll(async () => {
  db = await import('./db.js');
  meta = await import('./sensor-meta.js');
  progress = await import('./element-progress.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  db.resetKiosk();
  meta.clearVerfahrenCache();
});

function session(element: string, map = MAP): number {
  const id = db.createSession(element, map);
  db.endSession(id);
  return id;
}

describe('the depth a session reached', () => {
  it('is the deepest drilling reading of the role-depth sensor', () => {
    const id = session('P-01');
    for (const d of [0.5, 3.2, 6.4, 6.1]) {
      db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', d, null);
    }
    // Another channel's numbers are larger and must not be mistaken for depth.
    db.insertSessionReading(id, 'rig/clamp', 'sid-klemm', 'float', 4200, null);

    expect(progress.recordMaxDepth(db.getSessionById(id)!)).toBe(6.4);
    expect(db.getSessionById(id)!.max_depth).toBe(6.4);
  });

  it('finds the sensor by role, whatever it is called', () => {
    const id = session('P-02', ODD_NAME_MAP);
    db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', 4.25, null);

    expect(progress.recordMaxDepth(db.getSessionById(id)!)).toBe(4.25);
  });

  it('falls back to the sensor CSVs for a session recorded before roles were persisted', () => {
    // DSV's depth sensor is `Tiefe`, and the legacy map is keyed by that name.
    meta.setActiveVerfahren('dsv');
    const id = session('P-03', LEGACY_MAP);
    db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', 2.75, null);

    expect(progress.recordMaxDepth(db.getSessionById(id)!)).toBe(2.75);
  });

  it('ignores the frozen depth of a Rohrverlängerung, and clipped readings', () => {
    const id = session('P-04');
    db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', 3.0, null);
    // The pipe change: the wheel stands still at a depth the hole never had,
    // and those readings are held back from every upload and export.
    db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', 9.9, null, { phase: 'rohrwechsel' });
    db.insertSessionReading(id, 'rig/depth', 'sid-tiefe', 'float', 9.9, null, { clipped: true });

    expect(progress.recordMaxDepth(db.getSessionById(id)!)).toBe(3.0);
  });

  it('is 0, not null, for a session that recorded no depth at all', () => {
    // Somebody tapped start, fiddled, and paused again. Storing 0 rather than
    // leaving it null is what keeps the backfill from coming back to it.
    const id = session('P-05');

    expect(progress.recordMaxDepth(db.getSessionById(id)!)).toBe(0);
    expect(db.getSessionById(id)!.max_depth).toBe(0);
    expect(db.getSessionsWithoutMaxDepth(10)).toEqual([]);
  });
});

describe('the backfill for sessions recorded before the depth was stored', () => {
  it('fills them in, newest first, and leaves a running session alone', () => {
    const alt = db.createSession('P-10', MAP);
    db.insertSessionReading(alt, 'rig/depth', 'sid-tiefe', 'float', 1.0, null);
    db.endSession(alt);
    const neu = db.createSession('P-11', MAP);
    db.insertSessionReading(neu, 'rig/depth', 'sid-tiefe', 'float', 7.5, null);
    db.endSession(neu);
    // Still recording: its depth is not final, so it is not this function's
    // business — the stop computes it.
    const laufend = db.createSession('P-12', MAP);
    db.insertSessionReading(laufend, 'rig/depth', 'sid-tiefe', 'float', 2.0, null);

    expect(progress.backfillMaxDepth()).toBe(2);
    expect(db.getSessionById(alt)!.max_depth).toBe(1.0);
    expect(db.getSessionById(neu)!.max_depth).toBe(7.5);
    expect(db.getSessionById(laufend)!.max_depth).toBeNull();
  });

  it('is capped, so a machine with months of sessions does not pay for all of them', () => {
    for (let i = 0; i < 5; i++) session(`P-2${i}`);

    expect(progress.backfillMaxDepth(2)).toBe(2);
    expect(db.getSessionsWithoutMaxDepth(10)).toHaveLength(3);
  });
});

describe('what the element list is told', () => {
  it('reports the deepest session per element, whatever became of it', () => {
    // A pillar drilled to 6 m, paused and uploaded, then resumed and paused
    // again at a shallower-reading second session: the hole is 6 m deep.
    const erste = session('P-30');
    db.insertSessionReading(erste, 'rig/depth', 'sid-tiefe', 'float', 6.0, null);
    progress.recordMaxDepth(db.getSessionById(erste)!);
    db.setSessionPaused(erste, true);
    db.updateSessionStatus(erste, 'uploaded');

    const zweite = session('P-30');
    db.insertSessionReading(zweite, 'rig/depth', 'sid-tiefe', 'float', 2.0, null);
    progress.recordMaxDepth(db.getSessionById(zweite)!);

    const elements = db.getStartedElements();
    expect(elements).toHaveLength(1);
    expect(elements[0].elementName).toBe('P-30');
    expect(elements[0].tiefe).toBe(6.0);
  });

  it('lists an element whose session recorded nothing, with no depth', () => {
    // The whole point: "somebody started here" is worth saying even when there
    // is no number to say it with.
    const id = session('P-31');
    progress.recordMaxDepth(db.getSessionById(id)!);

    expect(db.getStartedElements()).toEqual([
      { elementName: 'P-31', tiefe: 0, letzteAufzeichnung: expect.any(Number) },
    ]);
  });

  it('reports a session whose depth was never computed as having none', () => {
    // A session recorded before the column existed and not yet backfilled:
    // null and 0 have to read the same, or the tile says nothing at all.
    session('P-32');

    expect(db.getStartedElements()[0].tiefe).toBe(0);
  });
});
