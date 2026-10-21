import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The phase a recording opens in.
 *
 * A resumed element reopens on the phase its last session was in, and the
 * operator may step it before tapping start. That choice has to reach the
 * session, because the opening `Status` reading is written from it — and
 * implenia-web's Herstellprotokoll segments every Injektionsbohren KPI on that
 * value (see "Status numbering" in CLAUDE.md). A screen saying Auffüllen over
 * a session recording `Status = 0` reports the filling as drilling, in a
 * document that is signed and archived, from an upload that reports success.
 *
 * The trap this pins: `operating_mode` is `NOT NULL DEFAULT 'bohren'`, so a
 * fresh session row already carries a mode. `startRecording` reads that first,
 * which is why the opening phase is written onto the row rather than handed
 * through `ingestion.pendingMode` — that one sits behind the stored value and
 * never reaches a new session at all.
 */

const fetchImplenia = vi.fn();

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: (...args: unknown[]) => fetchImplenia(...args),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));
vi.mock('./connectivity.js', () => ({
  connectivity: { isOnline: () => true, on: () => {}, off: () => {} },
}));
vi.mock('./websocket.js', () => ({ broadcastMessage: () => {} }));

let db: typeof import('./db.js');
let meta: typeof import('./sensor-meta.js');
let recording: typeof import('./recording.js');
let geology: typeof import('./geology.js');
let app: FastifyInstance;

/** A DSV pillar with a `Status` sensor, which is what carries the phase. */
const PLATFORM_SENSORS = {
  sensors_float: [
    { id: 's-tiefe', name: 'Tiefe', unit: 'm', meta: { source: 'mqtt', role: 'depth' } },
  ],
  sensors_int: [
    { id: 's-status', name: 'Status', meta: { source: 'user', role: 'mode' } },
    { id: 's-geodin', name: 'GeoDIN', meta: { source: 'kiosk', role: 'geology_nr' } },
  ],
  sensors_string: [
    { id: 's-geologie', name: 'Geologie', meta: { source: 'kiosk', role: 'geology_text' } },
  ],
};

/** The `Status` values recorded for a session, in order. */
function statusValues(sessionId: number): (number | null)[] {
  return db.getAllSessionReadings(sessionId)
    .filter((r) => r.topic === 'kiosk/status')
    .map((r) => r.valueNumeric);
}

async function start(element: string, mode?: 'bohren' | 'austausch' | 'einbauen' | 'auffuellen') {
  const { sessionId } = await recording.beginRecording(element, mode);
  return sessionId;
}

beforeAll(async () => {
  db = await import('./db.js');
  meta = await import('./sensor-meta.js');
  recording = await import('./recording.js');
  geology = await import('./geology.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
  const { registerRecordingRoutes } = await import('./routes/recording.js');
  app = Fastify();
  registerRecordingRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  recording.abortRecording();
  db.resetKiosk();
  meta.clearVerfahrenCache();
  meta.setActiveVerfahren('dsv');
  fetchImplenia.mockReset();
  fetchImplenia.mockImplementation(async (path: string) =>
    path.includes('name:vorgaben') ? { sensors_float: [] } : PLATFORM_SENSORS,
  );
});

describe('a recording started with no phase given', () => {
  it('opens in Bohren, as it always has', async () => {
    const id = await start('P-01');
    expect(db.getSessionById(id)!.operating_mode).toBe('bohren');
    expect(statusValues(id)).toEqual([0]);
  });
});

describe('a recording started from a resumed element', () => {
  it('opens in the phase the screen was showing', async () => {
    const id = await start('P-01', 'auffuellen');

    expect(db.getSessionById(id)!.operating_mode).toBe('auffuellen');
    // 1, not 3: the numbering is not the phase order — see CLAUDE.md.
    expect(statusValues(id)).toEqual([1]);
  });

  it('carries every phase, not just the filling one', async () => {
    expect(statusValues(await start('P-01', 'austausch'))).toEqual([2]);
    await recording.endRecording();
    expect(statusValues(await start('P-02', 'einbauen'))).toEqual([3]);
  });

  /*
   * Persisted rather than held in memory: a PM2 restart one reading in has to
   * resume into the phase the operator chose, not into Bohren. The session row
   * is the only thing that survives that.
   */
  it('persists the phase, so a restart resumes into it', async () => {
    const id = await start('P-01', 'auffuellen');
    expect(db.getOperatingMode(id)).toBe('auffuellen');
  });

  /*
   * The phase belongs to the element the operator was looking at. Left
   * standing anywhere, it would open the *next* element's recording in it — a
   * pillar started from the element list recording its drilling as Auffüllen.
   */
  it('does not leak into the next recording', async () => {
    await start('P-01', 'auffuellen');
    await recording.endRecording();

    const zweite = await start('P-02');
    expect(db.getSessionById(zweite)!.operating_mode).toBe('bohren');
    expect(statusValues(zweite)).toEqual([0]);
  });
});

describe('the start route', () => {
  async function post(body: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/api/recording/start', payload: body });
    return { status: res.statusCode, body: res.json() as { sessionId?: number; error?: string } };
  }

  it('opens the session in the phase the body names', async () => {
    const { status, body } = await post({ elementName: 'P-01', operatingMode: 'auffuellen' });
    expect(status).toBe(200);
    expect(db.getSessionById(body.sessionId!)!.operating_mode).toBe('auffuellen');
  });

  /*
   * A caller that does not know about this — the voice command, a second tab
   * on an older bundle — still starts normally. A refusal here would make a
   * recording depend on the browser being up to date.
   */
  it('ignores a phase it does not recognise instead of refusing the start', async () => {
    const { status, body } = await post({ elementName: 'P-01', operatingMode: 'verpressen' });
    expect(status).toBe(200);
    expect(db.getSessionById(body.sessionId!)!.operating_mode).toBe('bohren');
  });
});

/**
 * The geology window of a session that opens past `bohren`.
 *
 * Such a session never makes the step out of `bohren`, which is what stamps
 * `drilling_ended_at` — and without that bound every depth reading it holds
 * reads as drilling data, because `session_readings.phase` is only ever
 * `bohren` or `rohrwechsel` and never the operating mode. The rig pulling its
 * pipes back out of a finished hole therefore looked like a 6 m bore, so the
 * stop's back-fill committed the whole Schichtauftrag profile a second time,
 * dated against retraction instants, over the profile the drilling session had
 * already signed off: a corrupted Herstellprotokoll out of an upload that
 * reports success.
 */
describe('a recording opened past Bohren', () => {
  const VORGABEN = {
    int_sensors: { 'Geologie 1': 5, 'Geologie 2': 9 },
    float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 6, 'Säulenhöhe': 6 },
  };

  /** Depth readings a second apart, as the rig reports them. */
  function feedDepths(sessionId: number, depths: number[]): void {
    const t0 = Date.now();
    depths.forEach((d, i) => {
      db.insertSessionReading(
        sessionId, 'rig/tiefe', 's-tiefe', 'float', d, null, { receivedAt: t0 + i * 1000 },
      );
    });
  }

  it('closes its geology window at the start', async () => {
    const id = await start('P-01', 'auffuellen');
    expect(db.getSessionById(id)!.drilling_ended_at).not.toBeNull();
  });

  it('leaves it open for a session that opens in Bohren', async () => {
    const id = await start('P-01');
    expect(db.getSessionById(id)!.drilling_ended_at).toBeNull();
  });

  /*
   * The series is one reading at rest and then the pipes coming out of a 6 m
   * hole, which is what makes the fabrication reachable rather than merely
   * possible: `alignBoundaries` drops a boundary shallower than the session's
   * first reading, so a *pure* retraction loses every planned boundary to
   * `aboveHole` — one reading before the rig moves is enough for both to
   * align, the 3 m boundary onto the reading at 6 m.
   */
  it('commits no profile at the stop, however far the rig retracts', async () => {
    db.setElementVorgaben('P-01', VORGABEN);
    const id = await start('P-01', 'auffuellen');
    feedDepths(id, [0, 6, 5.5, 5, 4, 3, 2, 1, 0]);

    expect(geology.commitDefaultGeology(db.getSessionById(id)!)).toBeNull();
    expect(db.getSessionSensorSeries(id, 's-geodin')).toEqual([]);
  });

  /* The same readings, from a session that did the drilling, still commit. */
  it('does not stop a drilling session from committing one', async () => {
    db.setElementVorgaben('P-01', VORGABEN);
    const id = await start('P-01');
    feedDepths(id, [0, 1, 2, 3, 4, 5, 6]);

    expect(geology.commitDefaultGeology(db.getSessionById(id)!)?.geschrieben).toBeGreaterThan(0);
    expect(db.getSessionSensorSeries(id, 's-geodin').length).toBeGreaterThan(0);
  });
});
