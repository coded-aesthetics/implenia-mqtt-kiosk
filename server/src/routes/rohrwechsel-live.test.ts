import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * GET /api/config/rohrwechsel/live — the clamp value the settings screen
 * previews while the thresholds are being set.
 *
 * The screen used to fetch every observed topic and pick the clamp out of the
 * list with its own copy of isClampTopic(). These tests pin the server-side
 * matching to the same rule the ingestion path uses, because a drift between
 * the two would show a technician a value the recorder is not reading — on
 * the one screen whose job is confirming the right topic was picked.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');
let meta: typeof import('../sensor-meta.js');

beforeAll(async () => {
  db = await import('../db.js');
  meta = await import('../sensor-meta.js');
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
  meta.clearVerfahrenCache();
  meta.setActiveVerfahren('dsv');
});

function live(topic?: string) {
  const url = topic === undefined
    ? '/api/config/rohrwechsel/live'
    : `/api/config/rohrwechsel/live?topic=${encodeURIComponent(topic)}`;
  return app.inject({ method: 'GET', url });
}

describe('GET /api/config/rohrwechsel/live', () => {
  it('returns the value of an exactly matching topic', async () => {
    db.insertBuffer('plc/klemmbacke', '142.5');

    const res = await live('plc/klemmbacke');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ topic: 'plc/klemmbacke', raw: 142.5 });
  });

  it('matches on the last segment, like the ingestion path does', async () => {
    db.insertBuffer('rig7/plc/klemmbacke', '88');

    expect((await live('klemmbacke')).json()).toMatchObject({
      topic: 'rig7/plc/klemmbacke',
      raw: 88,
    });
  });

  it('ignores case, like the ingestion path does', async () => {
    db.insertBuffer('PLC/Klemmbacke', '12');

    expect((await live('plc/klemmbacke')).json()).toMatchObject({ raw: 12 });
  });

  it('reports a miss rather than failing when nothing matches', async () => {
    db.insertBuffer('plc/tiefe', '3.2');

    const res = await live('plc/klemmbacke');

    // A rig that is not publishing yet is the normal case while a technician
    // types a topic — it must read as "no value", never as an error.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ topic: null, raw: null, ageMs: null });
  });

  it('reports a miss when no topic is given', async () => {
    db.insertBuffer('plc/klemmbacke', '5');

    expect((await live()).json()).toEqual({ topic: null, raw: null, ageMs: null });
    expect((await live('   ')).json()).toEqual({ topic: null, raw: null, ageMs: null });
  });

  it('carries the age of the value so the screen can mark it stale', async () => {
    db.insertBuffer('plc/klemmbacke', '1');

    const body = (await live('plc/klemmbacke')).json();

    expect(body.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.ageMs).toBeLessThan(60_000);
  });

  it('returns a null value for a payload that is not a number', async () => {
    db.insertBuffer('plc/klemmbacke', 'offen');

    // The topic still resolves — the screen should say "connected but
    // unreadable", not "no topic".
    expect((await live('plc/klemmbacke')).json()).toMatchObject({
      topic: 'plc/klemmbacke',
      raw: null,
    });
  });

  it('reports the latest value when a topic publishes repeatedly', async () => {
    db.insertBuffer('plc/klemmbacke', '10');
    db.insertBuffer('plc/klemmbacke', '20');
    db.insertBuffer('plc/klemmbacke', '30');

    expect((await live('plc/klemmbacke')).json()).toMatchObject({ raw: 30 });
  });
});
