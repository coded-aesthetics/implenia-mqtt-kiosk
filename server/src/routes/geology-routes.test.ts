import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The geology HTTP surface: live entry, the confirmation context, and the stop
 * that commits a profile.
 *
 * Two properties matter more than the shapes of the responses, and both are
 * about not blocking a construction site:
 *
 * — **A stop is never refused over its geology.** An operator who cannot close
 *   the confirmation screen has a shift of measurements trapped behind it.
 * — **The geology is in the database before the session ends**, because ending
 *   it is what releases the auto-upload.
 */

vi.mock('../implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('../connectivity.js', () => ({
  connectivity: { isOnline: () => false, on: () => {}, off: () => {} },
}));

vi.mock('../websocket.js', () => ({ broadcastMessage: () => {} }));

let app: FastifyInstance;
let db: typeof import('../db.js');
let meta: typeof import('../sensor-meta.js');
let recording: typeof import('../recording.js');

const DEPTH_ID = 'sensor-tiefe';
const NR_ID = 'sensor-geodin';
const TEXT_ID = 'sensor-geologie';

/** DSV's roles: depth is `Tiefe` here, which is why nothing resolves by name. */
const SENSOR_MAP = JSON.stringify({
  tiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
  geodin: { sensorId: NR_ID, sensorType: 'int' },
  geologie: { sensorId: TEXT_ID, sensorType: 'string' },
});

const T0 = 1_700_000_000_000;
const SAND = 5;
const TON = 10;

beforeAll(async () => {
  db = await import('../db.js');
  meta = await import('../sensor-meta.js');
  recording = await import('../recording.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }

  const { registerRecordingRoutes } = await import('./recording.js');
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
});

/**
 * An open session with a depth series, attached to the live recording the way
 * `resumeRecording` would — the stop route needs an active session.
 */
function activeDrilledSession(to = 6): number {
  const id = db.createSession('P-01', SENSOR_MAP);
  let i = 0;
  for (let d = 0; d <= to + 1e-9; d += 0.5) {
    db.insertSessionReading(
      id, 'rig/tiefe', DEPTH_ID, 'float', Math.round(d * 1e6) / 1e6, null,
      { receivedAt: T0 + i * 1000 },
    );
    i++;
  }
  recording.resumeRecording();
  return id;
}

function geoDin(id: number): number[] {
  return db.getSessionSensorSeries(id, NR_ID).map((p) => Math.round(p.value));
}

describe('POST /api/recording/stop with a geology profile', () => {
  it('commits the profile and stops the session', async () => {
    const id = activeDrilledSession();

    const res = await app.inject({
      method: 'POST',
      url: '/api/recording/stop',
      payload: {
        geology: [
          { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'ist' },
          { tiefe: 3, nr: TON, name: 'Ton', quelle: 'vorgabe' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: id, geology: { geschrieben: 2 } });
    expect(geoDin(id)).toEqual([SAND, TON]);
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('has the geology in the database by the time the session ends', async () => {
    // The auto-upload is released by endSession, so anything committed later
    // would miss it. Asserted via the session's own upload groups, which is
    // what the upload reads.
    const id = activeDrilledSession();
    await app.inject({
      method: 'POST',
      url: '/api/recording/stop',
      payload: { geology: [{ tiefe: 0, nr: SAND }] },
    });

    const groups = db.getSessionUploadGroups(id);
    expect(groups.some((g) => g.sensorId === NR_ID)).toBe(true);
  });

  it('back-fills the plan when no geology is sent at all', async () => {
    // The sign-off screen is a review step, not a gate: a stop that never
    // reached it — by voice, from a second tab, from the recording bar —
    // commits the same complete profile.
    const id = activeDrilledSession();
    db.setElementVorgaben('P-01', {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 12, 'Säulenhöhe': 12 },
    });

    const res = await app.inject({ method: 'POST', url: '/api/recording/stop' });

    expect(res.statusCode).toBe(200);
    expect(res.json().geology).toMatchObject({ geschrieben: 2 });
    expect(geoDin(id)).toEqual([SAND, TON]);
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('keeps live entries when back-filling a stop that sent nothing', async () => {
    const id = activeDrilledSession();
    db.setElementVorgaben('P-01', {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 12, 'Säulenhöhe': 12 },
    });
    await app.inject({
      method: 'POST', url: '/api/recording/geology', payload: { nr: TON },
    });

    await app.inject({ method: 'POST', url: '/api/recording/stop' });
    // The live TON at 6 m moved the planned boundary up from 3 m to where it
    // was actually seen; nothing was duplicated.
    expect(geoDin(id)).toEqual([SAND, TON]);
  });

  it('commits nothing when the element has no plan and nothing was entered', async () => {
    const id = activeDrilledSession();
    const res = await app.inject({ method: 'POST', url: '/api/recording/stop' });
    expect(res.statusCode).toBe(200);
    expect(res.json().geology).toBeUndefined();
    expect(geoDin(id)).toEqual([]);
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('commits nothing for a session that never really drilled', async () => {
    const id = db.createSession('P-01', SENSOR_MAP);
    db.insertSessionReading(id, 'rig/tiefe', DEPTH_ID, 'float', 2, null, { receivedAt: T0 });
    db.insertSessionReading(id, 'rig/tiefe', DEPTH_ID, 'float', 2.1, null, { receivedAt: T0 + 1000 });
    recording.resumeRecording();
    db.setElementVorgaben('P-01', {
      int_sensors: { 'Geologie 1': SAND },
      float_sensors: { 'Tiefe Geologie 1': 9, 'Säulenhöhe': 9 },
    });

    const res = await app.inject({ method: 'POST', url: '/api/recording/stop' });
    expect(res.statusCode).toBe(200);
    expect(geoDin(id)).toEqual([]);
  });

  it('stops normally for an empty profile', async () => {
    const id = activeDrilledSession();
    const res = await app.inject({
      method: 'POST', url: '/api/recording/stop', payload: { geology: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('still stops when the profile is malformed, and says so', async () => {
    const id = activeDrilledSession();
    const res = await app.inject({
      method: 'POST', url: '/api/recording/stop',
      payload: { geology: 'Sand bis 3 m' },
    });

    expect(res.statusCode).toBe(200);
    expect(db.getSessionById(id)?.status).toBe('ended');
    expect(res.json().hinweis).toMatch(/Messwerte sind vollständig/);
  });

  it('keeps the usable layers of a partly broken profile and reports the rest', async () => {
    const id = activeDrilledSession();
    const res = await app.inject({
      method: 'POST', url: '/api/recording/stop',
      payload: {
        geology: [
          { tiefe: 0, nr: SAND },
          { tiefe: 'tief', nr: TON },
          { nr: TON },
          { tiefe: 4, nr: TON },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(geoDin(id)).toEqual([SAND, TON]);
    expect(res.json().hinweis).toContain('2 Schicht(en)');
  });

  it('reports layers below the bottom of the hole without failing', async () => {
    const id = activeDrilledSession(4);
    const res = await app.inject({
      method: 'POST', url: '/api/recording/stop',
      payload: { geology: [{ tiefe: 0, nr: SAND }, { tiefe: 8, nr: TON }] },
    });

    expect(res.json().geology).toMatchObject({ geschrieben: 1, zuTief: [8] });
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('refuses only when there is nothing to stop', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/recording/stop',
      payload: { geology: [{ tiefe: 0, nr: SAND }] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/recording/geology', () => {
  it('records a layer at the current depth and reports it', async () => {
    const id = activeDrilledSession(3);
    const res = await app.inject({
      method: 'POST', url: '/api/recording/geology',
      payload: { nr: SAND, name: 'Sand' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ nr: SAND, tiefe: 3 });
    expect(geoDin(id)).toEqual([SAND]);
  });

  it('rejects an invalid ground type with a German message', async () => {
    activeDrilledSession();
    const res = await app.inject({
      method: 'POST', url: '/api/recording/geology', payload: { nr: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bitte eine gültige Bodenart auswählen.');
  });

  it('refuses when nothing is being recorded', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/recording/geology', payload: { nr: SAND },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Aufzeichnung');
  });

  it('explains itself before the first depth reading', async () => {
    db.createSession('P-02', SENSOR_MAP);
    recording.resumeRecording();
    const res = await app.inject({
      method: 'POST', url: '/api/recording/geology', payload: { nr: SAND },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Tiefe');
  });
});

describe('GET /api/recording/:id/geology-context', () => {
  it('reports a drilled session with its planned profile', async () => {
    const id = activeDrilledSession(6);
    db.setElementVorgaben('P-01', {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 8, 'Säulenhöhe': 8 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/recording/${id}/geology-context` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      verfuegbar: true,
      gebohrt: true,
      gebohrteTiefe: 6,
      maxTiefe: 6,
      vorgabe: {
        schichten: [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON }],
        endTiefe: 8,
      },
      beobachtet: [],
      profil: {
        schichten: [
          { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
          { tiefe: 3, nr: TON, quelle: 'vorgabe' },
        ],
        endTiefe: 8,
      },
    });
  });

  it('includes what the operator already entered live', async () => {
    const id = activeDrilledSession(3);
    await app.inject({
      method: 'POST', url: '/api/recording/geology', payload: { nr: SAND, name: 'Sand' },
    });

    const ctx = (await app.inject({
      method: 'GET', url: `/api/recording/${id}/geology-context`,
    })).json();
    expect(ctx.beobachtet).toEqual([{ tiefe: 3, nr: SAND }]);
  });

  it('404s for a session that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recording/9999/geology-context' });
    expect(res.statusCode).toBe(404);
  });

  it('400s for a non-numeric id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recording/abc/geology-context' });
    expect(res.statusCode).toBe(400);
  });
});

describe('the stop is never refused over its geology', () => {
  it('still ends the session when the geology commit throws', async () => {
    // The commit used to sit inside the handler's own try/catch, so a throw
    // returned 409 without ever calling endRecording — the recording stayed
    // active and the stop button kept failing. better-sqlite3 raises on
    // SQLITE_FULL, and a kiosk with a full disk is exactly when the stop button
    // must still work.
    const id = activeDrilledSession();
    const geology = await import('../geology.js');
    const spy = vi.spyOn(geology, 'commitDefaultGeology').mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });

    const res = await app.inject({ method: 'POST', url: '/api/recording/stop' });

    expect(res.statusCode).toBe(200);
    expect(db.getSessionById(id)?.status).toBe('ended');
    expect(res.json().hinweis).toMatch(/Messwerte sind vollständig/);
    // No English SQLite text on a worker's screen.
    expect(JSON.stringify(res.json())).not.toContain('SQLITE_FULL');
    spy.mockRestore();
  });
});
