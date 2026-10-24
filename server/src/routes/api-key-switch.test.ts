import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `POST /api/config` is not only a credential write — it is how the kiosk is
 * moved to the next construction site.
 *
 * One key per construction phase per site: a bridge's piers are separate BIM
 * widgets with separate keys, and the key is switched on the way to the next
 * one. So saving a key has to move everything the kiosk remembers per element
 * name with it (site.ts), refuse to happen mid-recording, and say what it is
 * about to strand.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');

const PIER_1 = 'key-for-pier-1';
const PIER_2 = 'key-for-pier-2';

async function saveKey(apiKey: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/config',
    payload: { apiKey, apiUrl: 'http://platform.test' },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  db = await import('../db.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
  const { registerConfigRoutes } = await import('./config.js');
  app = Fastify();
  registerConfigRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.resetKiosk();
  db.deleteMeta('current_site_id');
  db.deleteMeta('implenia_api_key');
  db.deleteMeta('implenia_api_url');
});

describe('saving a key moves the kiosk', () => {
  it('reports the move, and leaves the previous pier\'s elements behind', async () => {
    const first = await saveKey(PIER_1);
    expect(first.status).toBe(200);
    expect(first.body.siteChanged).toBe(true);

    const session = db.createSession('P-01', '{}');
    db.endSession(session, 'ended');
    db.updateSessionStatus(session, 'uploaded');
    expect(db.getCompletedElements()).toHaveLength(1);

    const second = await saveKey(PIER_2);
    expect(second.body.siteChanged).toBe(true);
    expect(db.getCompletedElements()).toEqual([]);
  });

  it('reports no move when the same key is saved again', async () => {
    await saveKey(PIER_1);
    const again = await saveKey(PIER_1);
    expect(again.body.siteChanged).toBe(false);
    expect(again.body.pendingReadings).toBeNull();
  });
});

describe('what the switch would strand', () => {
  it('names the measurements that will be refused by the new key', async () => {
    await saveKey(PIER_1);
    const session = db.createSession('P-01', '{}');
    db.insertSessionReading(session, 'rig/tiefe', 'pier-1-tiefe', 'float', 4.2, null);
    db.insertSessionReading(session, 'rig/tiefe', 'pier-1-tiefe', 'float', 4.4, null);
    db.endSession(session, 'ended');

    const { body } = await saveKey(PIER_2);

    // Not a refusal: switching may be exactly what the operator needs to do,
    // and the data is still exportable and still uploads if the old key comes
    // back. But it is theirs to decide, so it is on screen now.
    expect(body.siteChanged).toBe(true);
    expect(body.pendingReadings).toMatchObject({ sessions: 1, readings: 2 });
  });

  it('says nothing about a session that has been exported to USB', async () => {
    // The other way the data is safe: the xlsx on a stick is the offline
    // counterpart of the upload, and an exported session needs no key.
    await saveKey(PIER_1);
    const session = db.createSession('P-01', '{}');
    db.insertSessionReading(session, 'rig/tiefe', 'pier-1-tiefe', 'float', 4.2, null);
    db.endSession(session, 'ended');
    db.markSessionExported(session);

    const { body } = await saveKey(PIER_2);
    expect(body.siteChanged).toBe(true);
    expect(body.pendingReadings).toBeNull();
  });
});

describe('not while recording', () => {
  it('is refused, in German, naming the element and the way out', async () => {
    await saveKey(PIER_1);
    const onPier1 = db.currentSiteId();
    db.createSession('P-01', '{}');

    const { status, body } = await saveKey(PIER_2);

    expect(status).toBe(409);
    expect(body.error).toContain('P-01');
    expect(body.error).toContain('Aufzeichnung');
    // Nothing half-applied: neither the credential nor the site moved.
    expect(db.getMeta('implenia_api_key')).toBe(PIER_1);
    expect(db.currentSiteId()).toBe(onPier1);
  });
});
