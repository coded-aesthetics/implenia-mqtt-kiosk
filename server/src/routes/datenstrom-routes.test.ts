import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * GET /api/config/datenstrom and its history route.
 *
 * The screen these feed exists to make an unresolved topic visible, so the
 * tests that matter here are the ones about what the kiosk does *not* know:
 * a topic bound to nothing, a payload that is not a number, a channel that
 * stopped publishing, and the Klemmbacke — which is not a sensor of any
 * Verfahren and would otherwise read as unassigned.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');
let meta: typeof import('../sensor-meta.js');
let resolver: typeof import('../topic-resolver.js');
let calibration: typeof import('../calibration.js');

interface Channel {
  topic: string;
  lastPayload: string;
  ageMs: number;
  count: number;
  sensor: string | null;
  boundBy: string;
  unit: string;
  type: string;
  source: string;
  scale: number;
  offset: number;
  raw: number | null;
  calibrated: number | null;
  isClamp: boolean;
}

beforeAll(async () => {
  db = await import('../db.js');
  meta = await import('../sensor-meta.js');
  resolver = await import('../topic-resolver.js');
  calibration = await import('../calibration.js');
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
  resolver.clearResolverCache();
  calibration.clearCalibrationCache();
  meta.setActiveVerfahren('injektionsbohren');
});

/** Seed one message, `agoMs` in the past. */
function seen(topic: string, payload: string, agoMs = 0): void {
  db.insertBuffer(topic, payload, Date.now() - agoMs);
}

async function datenstrom(minutes?: number) {
  const url = minutes === undefined
    ? '/api/config/datenstrom'
    : `/api/config/datenstrom?minutes=${minutes}`;
  const res = await app.inject({ method: 'GET', url });
  return res.json() as {
    verfahren: string | null;
    windowMs: number;
    channels: Channel[];
    missing: { sensor: string; unit: string; type: string }[];
  };
}

function channel(body: { channels: Channel[] }, topic: string): Channel {
  const found = body.channels.find((c) => c.topic === topic);
  if (!found) throw new Error(`No channel for ${topic} in ${body.channels.map((c) => c.topic)}`);
  return found;
}

describe('GET /api/config/datenstrom', () => {
  it('reports a topic that resolves to no sensor as bound to nothing', async () => {
    // resolveSensorKey answers this with its last segment, 'ch07', whether or
    // not a sensor is called that. Reporting that as the sensor would tell a
    // technician the channel is wired when nothing reads it.
    seen('plc/ch07', '42.5');
    const body = await datenstrom();
    const c = channel(body, 'plc/ch07');
    expect(c.sensor).toBeNull();
    expect(c.boundBy).toBe('none');
  });

  it('resolves a topic whose last segment is a sensor name', async () => {
    // Not one of the twelve in the shipped map, so this exercises the
    // no-configuration layer rather than the map.
    seen('Bohrgeraet/Richtung X', '1.4');
    const c = channel(await datenstrom(), 'Bohrgeraet/Richtung X');
    expect(c.sensor).toBe('Richtung X');
    expect(c.boundBy).toBe('name');
    expect(c.unit).toBe('\u00b0');
    expect(c.raw).toBe(1.4);
  });

  it('reports a topic from the shipped map, under the sensor it names', async () => {
    // The map renames: `Bohrgeraet/Ziehgeschwindigkeit` feeds `Vorschubgeschw.`,
    // so the tile cannot just show the topic's last segment and call it done.
    seen('Bohrgeraet/Ziehgeschwindigkeit', '31');
    const c = channel(await datenstrom(), 'Bohrgeraet/Ziehgeschwindigkeit');
    expect(c.sensor).toBe('Vorschubgeschw.');
    expect(c.boundBy).toBe('shipped');
    expect(c.unit).toBe('cm/min');
  });

  it('splits a topic into the group and the name the screen shows', async () => {
    seen('Bohrgeraet/Ziehgeschwindigkeit', '31');
    const c = channel(await datenstrom(), 'Bohrgeraet/Ziehgeschwindigkeit');
    expect(c.prefix).toBe('Bohrgeraet');
    expect(c.leaf).toBe('Ziehgeschwindigkeit');
  });

  it('reports a wired topic as an override, in the sensor CSV spelling', async () => {
    db.setTopicOverride('plc/ch07', 'Bohrtiefe');
    resolver.clearResolverCache();
    seen('plc/ch07', '12.47');
    const c = channel(await datenstrom(), 'plc/ch07');
    expect(c.sensor).toBe('Bohrtiefe');
    expect(c.boundBy).toBe('override');
  });

  it('keeps a non-numeric payload verbatim and does not read it as zero', async () => {
    // `Bohrgeraet/Klemmdruck nan` is in the G08 capture. A screen that showed
    // 0,00 for it would be reporting a pressure the rig never published.
    seen('Bohrgeraet/Klemmdruck', 'nan');
    const c = channel(await datenstrom(), 'Bohrgeraet/Klemmdruck');
    expect(c.lastPayload).toBe('nan');
    expect(c.raw).toBeNull();
    expect(c.calibrated).toBeNull();
  });

  it('still lists a channel that stopped publishing, with its age', async () => {
    seen('Spuelpumpe/Durchfluss', '0', 50 * 60_000);
    const c = channel(await datenstrom(), 'Spuelpumpe/Durchfluss');
    expect(c.ageMs).toBeGreaterThan(49 * 60_000);
  });

  it('drops a channel older than the window', async () => {
    seen('Spuelpumpe/Durchfluss', '0', 70 * 60_000);
    const body = await datenstrom();
    expect(body.channels.map((c) => c.topic)).not.toContain('Spuelpumpe/Durchfluss');
  });

  it('caps the window at an hour', async () => {
    const body = await datenstrom(600);
    expect(body.windowMs).toBe(60 * 60_000);
  });

  it('applies the stored calibration to the live value', async () => {
    db.setCalibration('Bohrtiefe', 0.3793, 0);
    calibration.clearCalibrationCache();
    seen('Bohrgeraet/Bohrtiefe', '10');
    const c = channel(await datenstrom(), 'Bohrgeraet/Bohrtiefe');
    expect(c.scale).toBe(0.3793);
    expect(c.raw).toBe(10);
    expect(c.calibrated).toBeCloseTo(3.793, 4);
  });

  describe('the Klemmbacke', () => {
    it('is flagged rather than reported as unassigned', async () => {
      db.setMeta('rohrwechsel_clamp_topic', 'Bohrgeraet/Klemmdruck');
      seen('Bohrgeraet/Klemmdruck', '4212');
      const c = channel(await datenstrom(), 'Bohrgeraet/Klemmdruck');
      expect(c.isClamp).toBe(true);
      expect(c.sensor).toBeNull();
    });

    it('matches on the last segment, as the ingestion path does', async () => {
      // isClampTopic matches a bare segment so that one setting covers both
      // `Bohrgeraet/Klemmdruck` (MQTT) and `device/1/Klemmdruck` (serial). A
      // screen comparing strings would call the serial one unassigned.
      db.setMeta('rohrwechsel_clamp_topic', 'Klemmdruck');
      seen('device/1/Klemmdruck', '4212');
      expect(channel(await datenstrom(), 'device/1/Klemmdruck').isClamp).toBe(true);
    });

    it('is not flagged while the feature is off', async () => {
      seen('Bohrgeraet/Klemmdruck', '4212');
      expect(channel(await datenstrom(), 'Bohrgeraet/Klemmdruck').isClamp).toBe(false);
    });
  });

  describe('missing', () => {
    it('lists an mqtt sensor nothing is feeding', async () => {
      const body = await datenstrom();
      expect(body.missing.map((m) => m.sensor)).toContain('Bohrtiefe');
    });

    it('drops a sensor once its topic arrives', async () => {
      seen('Bohrgeraet/Bohrtiefe', '12.47');
      const body = await datenstrom();
      expect(body.missing.map((m) => m.sensor)).not.toContain('Bohrtiefe');
    });

    it('excludes derived sensors, which is most of the DSV list', async () => {
      // The calibration screen this replaces filters on `Typ = Double` alone,
      // so DSV renders 50 rows of which 13 are MQTT channels. The other 37 are
      // server- and kiosk-derived results with no raw value to compare against
      // anything, and they must not come back in through this list.
      db.resetKiosk();
      meta.clearVerfahrenCache();
      resolver.clearResolverCache();
      meta.setActiveVerfahren('dsv');

      const body = await datenstrom();
      const names = body.missing.map((m) => m.sensor);
      expect(names).toContain('Tiefe');
      expect(names).not.toContain('Azimut');
      expect(names).not.toContain('Mittlere Drehzahl');
      expect(names).not.toContain('Volumen Vorschnitt');
      expect(body.missing.length).toBeLessThan(20);
    });
  });
});

describe('GET /api/config/datenstrom/history', () => {
  async function history(topic: string, minutes?: number) {
    const q = minutes === undefined ? '' : `&minutes=${minutes}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/config/datenstrom/history?topic=${encodeURIComponent(topic)}${q}`,
    });
    return {
      status: res.statusCode,
      body: res.json() as { points: { ts: number; value: number }[]; bucketMs: number },
    };
  }

  it('refuses a request with no topic, in German', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/datenstrom/history' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/Topic/);
  });

  it('answers an unknown topic with no points rather than an error', async () => {
    const { status, body } = await history('nothing/here');
    expect(status).toBe(200);
    expect(body.points).toEqual([]);
  });

  it('takes the last value in each second, never a mean', async () => {
    // Klemmdruck is bimodal at ~1650 open / ~4200 closed. A mean of the two
    // lands at ~2900 — a pressure the clamp cannot produce.
    // Aligned to a second, or the two readings straddle a bucket boundary
    // whenever the clock happens to sit in the last 300 ms of one.
    const base = Math.floor((Date.now() - 30_000) / 1000) * 1000;
    db.insertBuffer('Bohrgeraet/Klemmdruck', '1650', base);
    db.insertBuffer('Bohrgeraet/Klemmdruck', '4200', base + 300);
    const { body } = await history('Bohrgeraet/Klemmdruck');
    expect(body.points).toHaveLength(1);
    expect(body.points[0].value).toBe(4200);
  });

  it('dates a point at a real reading, not at the bucket boundary', async () => {
    const at = Date.now() - 30_000;
    db.insertBuffer('Bohrgeraet/Tiefe', '12.47', at);
    const { body } = await history('Bohrgeraet/Tiefe');
    expect(body.points[0].ts).toBe(at);
  });

  it('leaves a gap where nothing arrived', async () => {
    const base = Date.now() - 60_000;
    db.insertBuffer('Bohrgeraet/Tiefe', '1', base);
    db.insertBuffer('Bohrgeraet/Tiefe', '2', base + 10_000);
    const { body } = await history('Bohrgeraet/Tiefe');
    expect(body.points).toHaveLength(2);
    expect(body.points[1].ts - body.points[0].ts).toBeGreaterThan(9000);
  });

  it('drops a non-numeric payload instead of charting it as zero', async () => {
    db.insertBuffer('Bohrgeraet/Klemmdruck', 'nan', Date.now() - 30_000);
    const { body } = await history('Bohrgeraet/Klemmdruck');
    expect(body.points).toEqual([]);
  });

  it('serves only its own topic', async () => {
    const at = Date.now() - 30_000;
    db.insertBuffer('Bohrgeraet/Tiefe', '1', at);
    db.insertBuffer('Bohrgeraet/Drehzahl', '99', at);
    const { body } = await history('Bohrgeraet/Tiefe');
    expect(body.points.map((p) => p.value)).toEqual([1]);
  });

  it('does not serve more than an hour', async () => {
    db.insertBuffer('Bohrgeraet/Tiefe', '1', Date.now() - 90 * 60_000);
    const { body } = await history('Bohrgeraet/Tiefe', 600);
    expect(body.points).toEqual([]);
  });
});
