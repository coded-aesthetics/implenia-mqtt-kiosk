import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `GET /api/shift-assignment` when the platform is not there.
 *
 * The scenario, from a real morning on site: a kiosk listed its elements
 * yesterday, the backend is down today, and the element list — the screen a
 * worker starts from — showed „Verbindungsproblem" and an import button for a
 * list the kiosk had successfully read fifteen hours earlier.
 *
 * What is tested here is the distinction that makes that safe: a platform that
 * *said nothing* is answered from the cache, a platform that *answered* is
 * not. Serving yesterday's list over a 404 would invent a shift; serving it
 * over a 401 would hide the only message that leads anywhere.
 */

const fetchImplenia = vi.fn();

vi.mock('../implenia-api.js', () => ({
  fetchImplenia: (...args: unknown[]) => fetchImplenia(...args),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

let app: FastifyInstance;
let db: typeof import('../db.js');

const DEVICES = [
  { id: '1', name: 'P-01', vorgaben: { float_sensors: { Tiefe: 12 } } },
  { id: '2', name: 'P-02', vorgaben: { float_sensors: { Tiefe: 14 } } },
];

function apiError(statusCode: number): Error {
  const err = new Error(`Implenia API ${statusCode}: nope`);
  (err as Error & { statusCode: number }).statusCode = statusCode;
  return err;
}

async function get() {
  const res = await app.inject({ method: 'GET', url: '/api/shift-assignment' });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** One successful platform answer, which is what fills the cache. */
async function seedCache() {
  fetchImplenia.mockResolvedValueOnce({ unfinished_elements: DEVICES });
  const first = await get();
  expect(first.body.source).toBe('api');
}

beforeAll(async () => {
  db = await import('../db.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
  const { registerImpleniaRoutes } = await import('./implenia.js');
  app = Fastify();
  registerImpleniaRoutes(app);
  await app.ready();
});

beforeEach(() => {
  fetchImplenia.mockReset();
  db.deleteMeta('last_shift_assignment');
  db.deleteMeta('imported_shift_assignment');
  for (const s of db.getSessions()) db.deleteSessionWithReadings(s.id);
});

describe('no answer from the platform', () => {
  it('serves yesterday\'s list, with the time it was taken', async () => {
    await seedCache();

    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.source).toBe('cache');
    expect(body.measuring_devices).toEqual(DEVICES);
    expect(typeof body.cachedAt).toBe('number');
  });

  it('keeps the vorgaben, so a cached element still has its Soll values', async () => {
    await seedCache();
    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    const { body } = await get();
    const devices = body.measuring_devices as typeof DEVICES;
    expect(devices[0].vorgaben).toEqual({ float_sensors: { Tiefe: 12 } });
  });

  it('serves it on a 5xx too — a broken backend is not an answer', async () => {
    await seedCache();
    fetchImplenia.mockRejectedValueOnce(apiError(502));
    expect((await get()).body.source).toBe('cache');
  });

  it('falls back to the error when there is no cache at all', async () => {
    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    expect((await get()).status).toBe(502);
  });

  /*
   * The cache must only ever be written from a platform response. Written
   * from the fallback as well, `fetchedAt` would move forward on every page
   * load and a week-old list would claim to be from this morning.
   */
  it('does not re-date the cache by serving it', async () => {
    await seedCache();
    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    const first = await get();
    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    const second = await get();
    expect(second.body.cachedAt).toBe(first.body.cachedAt);
  });
});

describe('the platform answered', () => {
  it('still says „kein Schichtauftrag für heute" on a 404', async () => {
    await seedCache();
    fetchImplenia.mockRejectedValueOnce(apiError(404));
    expect((await get()).status).toBe(404);
  });

  it('still reports a refused key', async () => {
    await seedCache();
    fetchImplenia.mockRejectedValueOnce(apiError(401));
    expect((await get()).status).toBe(401);
  });
});

describe('what the kiosk knows by itself', () => {
  it('drops an element it finished after the list was taken', async () => {
    // Only the clock is faked, and only to put the upload an hour after the
    // list: both timestamps come from Date.now(), so in real time the two
    // land in the same millisecond here and nothing is being tested.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T07:12:00Z'));
      await seedCache();

      // An upload completes the element, which takes it off the platform's
      // unfinished list — the cached copy cannot know that, but the kiosk can.
      vi.setSystemTime(new Date('2026-10-20T08:12:00Z'));
      const id = db.createSession('P-01', '{}');
      db.endSession(id);
      db.updateSessionStatus(id, 'uploaded');

      fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
      const devices = (await get()).body.measuring_devices as typeof DEVICES;
      expect(devices.map((d) => d.name)).toEqual(['P-02']);
    } finally {
      vi.useRealTimers();
    }
  });

  // Not merely hidden: the element list's „Begonnene Elemente" row is built
  // from the same local completions, so a dropped element is still reachable.
  it('leaves an element finished before the list was taken on it', async () => {
    const id = db.createSession('P-01', '{}');
    db.endSession(id);
    db.updateSessionStatus(id, 'uploaded');

    await seedCache();
    fetchImplenia.mockRejectedValueOnce(new Error('fetch failed'));
    const devices = (await get()).body.measuring_devices as typeof DEVICES;
    expect(devices.map((d) => d.name)).toEqual(['P-01', 'P-02']);
  });
});

describe('an import outranks the cache', () => {
  it('serves the imported file without asking the platform', async () => {
    await seedCache();
    db.setMeta('imported_shift_assignment', JSON.stringify({
      measuring_devices: [{ id: '9', name: 'I-09' }],
    }));

    const { body } = await get();
    expect(body.source).toBe('import');
    expect(fetchImplenia).toHaveBeenCalledTimes(1); // only the seeding call
  });
});
