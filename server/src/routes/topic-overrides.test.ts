import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The topic-override routes, against a real Fastify instance and real SQLite.
 *
 * Fastify hands route params over already percent-decoded. Decoding them a
 * second time used to either throw URIError (a topic containing a literal '%')
 * or silently rewrite the topic (a literal '%20'), so the delete matched
 * nothing and the assignment simply reappeared in the UI.
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

function del(topic: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/config/topic-overrides/${encodeURIComponent(topic)}`,
  });
}

describe('DELETE /api/config/topic-overrides/:topic', () => {
  it('removes a plain topic', async () => {
    db.setTopicOverride('plc/ch07', 'Anpressdruck');

    const res = await del('plc/ch07');

    expect(res.statusCode).toBe(200);
    expect(db.getTopicOverrides()).toHaveLength(0);
  });

  it('removes a topic containing a literal percent sign', async () => {
    // Double-decoding threw URIError here, which surfaced as a 500.
    db.setTopicOverride('plc/100%/ch07', 'Anpressdruck');

    const res = await del('plc/100%/ch07');

    expect(res.statusCode).toBe(200);
    expect(db.getTopicOverrides()).toHaveLength(0);
  });

  it('removes a topic containing a literal escape sequence', async () => {
    // Double-decoding turned "%20" into a space, so nothing matched and the
    // delete reported success while changing nothing.
    db.setTopicOverride('plc/a%20b', 'Anpressdruck');

    const res = await del('plc/a%20b');

    expect(res.statusCode).toBe(200);
    expect(db.getTopicOverrides()).toHaveLength(0);
  });

  it('leaves other assignments alone', async () => {
    db.setTopicOverride('plc/ch07', 'Anpressdruck');
    db.setTopicOverride('plc/ch08', 'Drehzahl');

    await del('plc/ch07');

    expect(db.getTopicOverrides().map((o) => o.topic)).toEqual(['plc/ch08']);
  });
});

describe('PUT /api/config/topic-overrides', () => {
  it('rejects a sensor the active Verfahren does not define', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/topic-overrides',
      payload: { topic: 'plc/ch07', sensorName: 'Gibtsnicht' },
    });

    expect(res.statusCode).toBe(400);
    // Workers read this: German, and it says what to do.
    expect(res.json().error).toMatch(/kein Sensor dieses Verfahrens/);
    expect(db.getTopicOverrides()).toHaveLength(0);
  });

  it('stores a binding for a sensor the CSV defines', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/topic-overrides',
      payload: { topic: 'plc/ch07', sensorName: 'Anpressdruck' },
    });

    expect(res.statusCode).toBe(200);
    expect(db.getTopicOverrides()).toMatchObject([
      { topic: 'plc/ch07', sensorName: 'Anpressdruck' },
    ]);
  });
});
