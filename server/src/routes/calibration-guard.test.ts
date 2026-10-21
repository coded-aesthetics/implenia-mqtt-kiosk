import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * What may be given a calibration.
 *
 * `checkKnownSensor` answers only "is this a sensor of this Verfahren", which
 * is the right question for binding a topic and not for scaling one. A factor
 * stored against an Integer *mode* flag would be applied to every reading by
 * `applyCalibration` and change what the number means — and `Status`'s
 * numbering is a contract shared with implenia-web, where it segments every KPI
 * on the Herstellprotokoll.
 *
 * `GET /api/config/calibration` has always filtered its list to `Double`, so no
 * screen ever offered the others. These tests close the write while that is
 * still true.
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
  meta.setActiveVerfahren('injektionsbohren');
});

const put = (sensorName: string, scale = 2, offset = 0) =>
  app.inject({
    method: 'PUT', url: '/api/config/calibration',
    payload: { sensorName, scale, offset },
  });

describe('PUT /api/config/calibration', () => {
  it('accepts a Double sensor', async () => {
    const res = await put('Bohrtiefe', 0.3793);
    expect(res.statusCode).toBe(200);
    expect(db.getCalibrations().map((c) => c.sensorName)).toContain('bohrtiefe');
  });

  it('refuses an Integer sensor, in German, naming the type', async () => {
    const res = await put('Status');
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain('Status');
    expect(error).toContain('Integer');
    expect(db.getCalibrations()).toHaveLength(0);
  });

  it('refuses a Text sensor', async () => {
    // Ausführungsdatum is the element-completion stamp. Scaling a string is
    // meaningless, and an empty one un-completes an element.
    const res = await put('Ausführungsdatum');
    expect(res.statusCode).toBe(400);
    expect(db.getCalibrations()).toHaveLength(0);
  });

  it('still refuses a sensor this Verfahren does not have', async () => {
    const res = await put('Gibtsnicht');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('Gibtsnicht');
  });

  it('refuses a DSV Integer mode flag too', async () => {
    db.resetKiosk();
    meta.clearVerfahrenCache();
    meta.setActiveVerfahren('dsv');
    // `Bohren/Düsen` is Quelle=mqtt, so unlike `Status` it does arrive on the
    // live path and would actually be scaled.
    const res = await put('Bohren/Düsen');
    expect(res.statusCode).toBe(400);
    expect(db.getCalibrations()).toHaveLength(0);
  });
});

describe('POST /api/config/calibration/:sensorName/tare', () => {
  it('refuses an Integer sensor before it ever looks at a live value', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/config/calibration/Status/tare', payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('Integer');
  });
});
