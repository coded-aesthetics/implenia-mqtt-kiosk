import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Installing an update restarts the process.
 *
 * A recording survives that now — the session is re-attached on boot — but the
 * seconds the kiosk is down are still a hole in the measurements, and the
 * button offering it sat in the banner with nothing to say a recording was
 * running. So the route refuses while an element is being recorded, in German,
 * naming the element and what to do about it.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');
let updaterMod: typeof import('../updater.js');

beforeAll(async () => {
  db = await import('../db.js');
  updaterMod = await import('../updater.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }

  const { registerDataRoutes } = await import('./data.js');
  app = Fastify();
  registerDataRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.resetKiosk();
  applied = [];
  // The route is what is under test, not the download. Stubbed so the suite
  // never reaches for GitHub — and never depends on GITHUB_OWNER being unset
  // on the machine running it, which is what otherwise keeps it offline.
  (updaterMod.updater as unknown as { downloadAndApply: () => Promise<void> })
    .downloadAndApply = async () => { applied.push('applied'); };
});

let applied: string[] = [];

/** Pretend a release was found, without reaching for GitHub or a USB stick. */
function pendingUpdate(version: string): void {
  (updaterMod.updater as unknown as {
    _pendingUpdate: { version: string; source: string } | null;
  })._pendingUpdate = { version, source: 'github' };
}

describe('installing an update', () => {
  it('is refused while an element is being recorded', async () => {
    pendingUpdate('9.9.9');
    db.createSession('A-42', '{}');

    const res = await app.inject({ method: 'POST', url: '/api/update' });

    expect(res.statusCode).toBe(409);
    expect(applied).toEqual([]);
    const body = res.json() as { error: string };
    // German, names the element, and says what to do — the worker cannot
    // call IT about a button that did nothing.
    expect(body.error).toContain('A-42');
    expect(body.error).toContain('Aufzeichnung beenden');
  });

  it('goes ahead once the recording has ended', async () => {
    pendingUpdate('9.9.9');
    const sessionId = db.createSession('A-42', '{}');
    db.endSession(sessionId);

    const res = await app.inject({ method: 'POST', url: '/api/update' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'applying', version: '9.9.9' });
    expect(applied).toEqual(['applied']);
  });
});
