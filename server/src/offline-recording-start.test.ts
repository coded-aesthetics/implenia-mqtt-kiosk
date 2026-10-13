import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Starting a recording on a site with no connectivity.
 *
 * This is the single most important thing the kiosk does, and it used to be the
 * one part of it that required the Implenia platform: `beginRecording` resolved
 * the session's sensor ids over the network, so a site that had imported a
 * Schichtauftrag from a file could list its elements and then fail to record
 * one with "fetch failed". A worker standing at the rig with a dead screen is
 * exactly the blocking this software does not get to do.
 *
 * The properties pinned here:
 *
 * — **A start never needs the platform twice.** The first successful fetch
 *   caches the definitions; everything afterwards works offline.
 * — **An imported Schichtauftrag is enough on its own**, because implenia-web's
 *   export carries each element's sensors with their platform ids.
 * — **The ids are always real.** A session started offline uploads normally
 *   once the link returns. Nothing here invents an id: a reading stored without
 *   one is kept locally and silently never uploaded.
 * — **When there is genuinely nothing, the refusal says what to do about it**,
 *   in German, and does not masquerade as a conflict.
 */

const fetchImplenia = vi.fn();

// Paths are resolved relative to this file, and these all live in `src/`
// alongside it — the route module under test imports the very same instances.
vi.mock('./implenia-api.js', () => ({
  fetchImplenia: (...args: unknown[]) => fetchImplenia(...args),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./connectivity.js', () => ({
  connectivity: { isOnline: () => false, on: () => {}, off: () => {} },
}));

vi.mock('./websocket.js', () => ({ broadcastMessage: () => {} }));

let db: typeof import('./db.js');
let meta: typeof import('./sensor-meta.js');
let recording: typeof import('./recording.js');
let herstellen: typeof import('./herstellen-sensors.js');
let app: FastifyInstance;

const TIEFE_ID = 'sensor-tiefe-real-id';
const KOMMENTAR_ID = 'sensor-kommentar-real-id';
const VORGABE_ID = 'sensor-soll-tiefe';

/** What the platform answers for a DSV pillar, meta and all. */
const PLATFORM_SENSORS = {
  sensors_float: [
    { id: TIEFE_ID, name: 'Tiefe', unit: 'm', meta: { source: 'mqtt', role: 'depth' } },
  ],
  sensors_string: [
    { id: KOMMENTAR_ID, name: 'Kommentar', meta: { source: 'user' } },
  ],
};

/**
 * What the platform answers for that pillar's `vorgaben` child.
 *
 * `sensors_binary` and `sensors_int_float` are here because the element screen
 * reads all six keys to label its Soll values — anything caching this response
 * has to keep them.
 */
const PLATFORM_VORGABEN = {
  sensors_float: [{ id: VORGABE_ID, name: 'Tiefe', unit: 'm', meta: null }],
  sensors_int_float: [{ id: 'soll-paar', name: 'Düsenpaar', unit: 'mm', meta: null }],
  sensors_binary: [{ id: 'soll-bin', name: 'Anlage', meta: null }],
};

/**
 * One element out of implenia-web's shift assignment export, carrying the
 * `sensors` and `vorgaben_sensor_ids` fields the kiosk needs offline.
 */
function exportedElement(name: string) {
  return {
    id: 'md-1',
    name,
    description: '',
    sensors: PLATFORM_SENSORS,
    vorgaben_sensors: PLATFORM_VORGABEN,
    vorgaben_sensor_ids: [VORGABE_ID],
    vorgaben: { float_sensors: { Tiefe: 12 } },
  };
}

/** The platform answering normally: element sensors, then its vorgaben. */
function platformOnline(): void {
  fetchImplenia.mockImplementation(async (path: string) =>
    path.includes('name:vorgaben') ? PLATFORM_VORGABEN : PLATFORM_SENSORS,
  );
}

/** The platform unreachable the way an offline site sees it. */
function platformOffline(): void {
  fetchImplenia.mockImplementation(async () => {
    throw new TypeError('fetch failed');
  });
}

function sensorMapOf(sessionId: number): Record<string, { sensorId: string; sensorType: string }> {
  const session = db.getSessionById(sessionId);
  return JSON.parse(session!.sensor_map);
}

beforeAll(async () => {
  db = await import('./db.js');
  meta = await import('./sensor-meta.js');
  recording = await import('./recording.js');
  herstellen = await import('./herstellen-sensors.js');
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
});

describe('a start that reaches the platform', () => {
  it('caches the definitions so the next one does not have to', async () => {
    platformOnline();
    const first = await recording.beginRecording('P-01');
    await recording.endRecording();

    expect(sensorMapOf(first.sessionId).tiefe.sensorId).toBe(TIEFE_ID);

    // The link drops, and the same element is resumed.
    platformOffline();
    const second = await recording.beginRecording('P-01');

    expect(sensorMapOf(second.sessionId)).toEqual(sensorMapOf(first.sessionId));
  });

  it('refreshes the element sensors when the Vorgabe half is already on record', async () => {
    // The guard below must not also stop a *known* Vorgabe set from being
    // kept: the merge preserves it, so the entry stays safe.
    herstellen.cacheImportedSensors([exportedElement('P-40')]);
    fetchImplenia.mockImplementation(async (path: string) => {
      if (path.includes('name:vorgaben')) throw new TypeError('fetch failed');
      return { sensors_float: [{ id: 'neu', name: 'Neu', meta: { source: 'mqtt' } }] };
    });

    await recording.beginRecording('P-40');
    await recording.endRecording();

    platformOffline();
    const { sessionId } = await recording.beginRecording('P-40');
    const ids = Object.values(sensorMapOf(sessionId)).map((e) => e.sensorId);
    expect(ids).toContain('neu');
    expect(herstellen.cachedVorgabenSensors('P-40')).not.toBeNull();
  });

  it('does not cache a vorgaben set it only assumed was empty', async () => {
    // The element's sensors arrive; the vorgaben request dies on the network.
    // Caching `vorgabenIds: []` here would later have a legacy pillar record
    // and upload its Soll values as if they were measurements.
    fetchImplenia.mockImplementation(async (path: string) => {
      if (path.includes('name:vorgaben')) throw new TypeError('fetch failed');
      return PLATFORM_SENSORS;
    });

    await recording.beginRecording('P-01');
    await recording.endRecording();

    expect(herstellen.cachedHerstellenSensors('P-01')).toBeNull();
  });

  it('does cache when the element simply has no vorgaben child', async () => {
    // A 404 is the real answer for a pillar predating the `vorgaben` device.
    fetchImplenia.mockImplementation(async (path: string) => {
      if (path.includes('name:vorgaben')) {
        const err = new Error('Implenia API 404: not found') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return PLATFORM_SENSORS;
    });

    await recording.beginRecording('P-01');
    expect(herstellen.cachedHerstellenSensors('P-01')).not.toBeNull();
  });
});

describe('a start on a site that has never been online', () => {
  it('works from an imported Schichtauftrag, with the platform ids intact', async () => {
    const cached = herstellen.cacheImportedSensors([exportedElement('P-07')]);
    expect(cached).toBe(1);

    platformOffline();
    const { sessionId } = await recording.beginRecording('P-07');

    const map = sensorMapOf(sessionId);
    // Real ids, not placeholders — this session uploads normally once the link
    // comes back. `/api/v1/sensor-float/<id>/batch` is the destination.
    expect(map.tiefe.sensorId).toBe(TIEFE_ID);
    expect(map.tiefe.sensorType).toBe('float');
    expect(map.kommentar.sensorId).toBe(KOMMENTAR_ID);
    expect(map.kommentar.sensorType).toBe('string');
  });

  it('leaves the Vorgabe sensor out of the recorded map', async () => {
    // Legacy shape: the Soll sensor sits on the pillar itself, with no meta to
    // distinguish it, and is identified only by `vorgaben_sensor_ids`.
    herstellen.cacheImportedSensors([{
      id: 'md-2',
      name: 'P-08',
      description: '',
      sensors: {
        sensors_float: [
          { id: TIEFE_ID, name: 'Tiefe', unit: 'm', meta: null },
          { id: VORGABE_ID, name: 'Soll-Tiefe', unit: 'm', meta: null },
        ],
      },
      vorgaben_sensor_ids: [VORGABE_ID],
    }]);

    platformOffline();
    const { sessionId } = await recording.beginRecording('P-08');

    const ids = Object.values(sensorMapOf(sessionId)).map((e) => e.sensorId);
    expect(ids).toContain(TIEFE_ID);
    expect(ids).not.toContain(VORGABE_ID);
  });

  it('ignores an export made before implenia-web carried the sensors', () => {
    expect(herstellen.cacheImportedSensors([
      { id: 'md-3', name: 'P-09', description: '', vorgaben: { float_sensors: {} } },
    ])).toBe(0);
  });

  it('survives a malformed import without caching nonsense', () => {
    expect(herstellen.cacheImportedSensors(null)).toBe(0);
    expect(herstellen.cacheImportedSensors([
      { name: '', sensors: PLATFORM_SENSORS },
      { name: 'P-10', sensors: 'not an object' },
      { name: 'P-11', sensors: PLATFORM_SENSORS, vorgaben_sensor_ids: 'nope' },
    ])).toBe(1);
    // The one usable element still made it, with no vorgaben to subtract.
    expect(herstellen.cachedHerstellenSensors('P-11')).not.toBeNull();
  });
});

describe('a start with nothing to go on', () => {
  it('refuses with an actionable German message, not a conflict', async () => {
    platformOffline();

    await expect(recording.beginRecording('P-99')).rejects.toBeInstanceOf(
      herstellen.SensorDefsUnavailableError,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/recording/start',
      payload: { elementName: 'P-99' },
    });

    // 503: nothing about this kiosk's state is in the way, the thing needed
    // to start just is not there. A 409 said "conflict" and showed the worker
    // the words "fetch failed".
    expect(res.statusCode).toBe(503);
    const { error } = res.json();
    expect(error).toContain('P-99');
    expect(error).toContain('Schichtauftrag');
    expect(error).not.toMatch(/fetch failed/i);
  });

  it('still answers 409 when a recording is genuinely already running', async () => {
    platformOnline();
    await recording.beginRecording('P-01');

    const res = await app.inject({
      method: 'POST',
      url: '/api/recording/start',
      payload: { elementName: 'P-02' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('läuft bereits');
  });

  it('treats a cache holding no recordable sensors as no cache', async () => {
    // Every sensor is computed by the platform, so there is nothing to record.
    // Starting anyway would store each reading with a null sensor id, upload
    // none of them, and look perfectly healthy doing it.
    herstellen.cacheImportedSensors([{
      name: 'P-12',
      sensors: { sensors_float: [{ id: 'x', name: 'Rechenwert', meta: { source: 'server' } }] },
      vorgaben_sensor_ids: [],
    }]);

    platformOffline();
    await expect(recording.beginRecording('P-12')).rejects.toBeInstanceOf(
      herstellen.SensorDefsUnavailableError,
    );
  });
});

describe('the import route takes a file the size this field made it', () => {
  it('accepts a shift assignment well past Fastify\'s 1 MiB default', async () => {
    const { registerImpleniaRoutes } = await import('./routes/implenia.js');
    const importApp = Fastify();
    registerImpleniaRoutes(importApp);
    await importApp.ready();

    /*
     * A DSV element carries 59 sensor definitions, ~15 KB of pretty-printed
     * JSON. At around seventy pillars the file passes 1 MiB, and before the
     * route raised its limit the import answered 413 — on the one path that
     * exists for a site with no connectivity.
     */
    const sensors_float = Array.from({ length: 59 }, (_, i) => ({
      id: `sensor-${i}`.padEnd(25, 'x'),
      name: `Sensorname Nummer ${i}`,
      unit: 'm',
      meta: { source: 'mqtt', role: null, priority: 'secondary' },
    }));
    const devices = Array.from({ length: 120 }, (_, i) => ({
      id: `md-${i}`, name: `P-${i}`, description: 'Säule',
      sensors: { sensors_float }, vorgaben_sensor_ids: [],
    }));
    const payload = JSON.stringify({ measuring_devices: devices }, null, 2);
    expect(payload.length).toBeGreaterThan(1024 * 1024);

    const res = await importApp.inject({
      method: 'POST',
      url: '/api/shift-assignment/import',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sensorsCached).toBe(120);

    await importApp.close();
  });
});

describe('the element screens offline', () => {
  it('serves /api/elements/:name/sensors from the cache', async () => {
    const { registerImpleniaRoutes } = await import('./routes/implenia.js');
    const elementApp = Fastify();
    registerImpleniaRoutes(elementApp);
    await elementApp.ready();

    herstellen.cacheImportedSensors([exportedElement('P-20')]);
    platformOffline();

    const res = await elementApp.inject({ url: '/api/elements/P-20/sensors' });

    /*
     * The element screens read this to know which sensors exist and which are
     * hero tiles. `useHerstellenSensors` swallows a failure and returns `[]`,
     * so a 502 here is a screen that silently renders no sensors at all.
     */
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sensors_float[0].id).toBe(TIEFE_ID);
    expect(body.sensors_string[0].id).toBe(KOMMENTAR_ID);

    // Nothing cached and no platform is still a 503 with the same German text.
    const miss = await elementApp.inject({ url: '/api/elements/P-21/sensors' });
    expect(miss.statusCode).toBe(503);
    expect(miss.json().error).toContain('Schichtauftrag');

    await elementApp.close();
  });
});

describe('the Soll units offline', () => {
  async function vorgabenApp(): Promise<FastifyInstance> {
    const { registerImpleniaRoutes } = await import('./routes/implenia.js');
    const a = Fastify();
    registerImpleniaRoutes(a);
    await a.ready();
    return a;
  }

  it('serves the vorgaben sensor list from an imported file, all six keys', async () => {
    const app2 = await vorgabenApp();
    herstellen.cacheImportedSensors([exportedElement('P-30')]);
    platformOffline();

    const res = await app2.inject({ url: '/api/elements/P-30/vorgaben/sensors' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sensors_float[0]).toMatchObject({ id: VORGABE_ID, name: 'Tiefe', unit: 'm' });
    // Dropping these would quietly cost those Soll values their units.
    expect(body.sensors_int_float[0].name).toBe('Düsenpaar');
    expect(body.sensors_binary[0].name).toBe('Anlage');

    await app2.close();
  });

  it('caches them from a successful fetch, for the next time offline', async () => {
    const app2 = await vorgabenApp();
    platformOnline();

    const first = await app2.inject({ url: '/api/elements/P-31/vorgaben/sensors' });
    expect(first.statusCode).toBe(200);

    platformOffline();
    const second = await app2.inject({ url: '/api/elements/P-31/vorgaben/sensors' });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    await app2.close();
  });

  it('does not clobber the element\'s own sensors', async () => {
    // The two halves are written from different requests. A plain overwrite
    // from either would leave the element unable to start a recording, or
    // unable to label its Soll values.
    const app2 = await vorgabenApp();
    herstellen.cacheImportedSensors([exportedElement('P-32')]);
    platformOnline();

    await app2.inject({ url: '/api/elements/P-32/vorgaben/sensors' });

    platformOffline();
    const { sessionId } = await recording.beginRecording('P-32');
    expect(sensorMapOf(sessionId).tiefe.sensorId).toBe(TIEFE_ID);
    expect(herstellen.cachedVorgabenSensors('P-32')).not.toBeNull();

    await app2.close();
  });

  it('answers an empty list for a pillar that has no vorgaben device', async () => {
    const app2 = await vorgabenApp();
    // A 404 is a real answer, not an outage: a pillar predating the `vorgaben`
    // child has none. Telling the operator to re-import would send them after
    // a file that cannot help.
    fetchImplenia.mockImplementation(async () => {
      const err = new Error('Implenia API 404: not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    });

    const res = await app2.inject({ url: '/api/elements/P-33/vorgaben/sensors' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    await app2.close();
  });

  it('says what to do when there is no platform and nothing cached', async () => {
    const app2 = await vorgabenApp();
    platformOffline();

    const res = await app2.inject({ url: '/api/elements/P-34/vorgaben/sensors' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('Schichtauftrag');

    await app2.close();
  });
});

describe('the sensor CSVs enrich, they never decide', () => {
  it('records a sensor the local CSVs have never heard of', async () => {
    // The CSVs are synced by hand from implenia-web and version separately
    // from both the platform and this kiosk. A sensor added there and not yet
    // synced here must still reach the sensor map — one that does not is
    // recorded with a null sensor id and silently never uploaded.
    herstellen.cacheImportedSensors([{
      name: 'P-13',
      sensors: {
        sensors_float: [
          { id: 'brand-new', name: 'Nachträglich Hinzugefügt', meta: { source: 'mqtt' } },
        ],
      },
      vorgaben_sensor_ids: [],
    }]);

    platformOffline();
    const { sessionId } = await recording.beginRecording('P-13');

    expect(sensorMapOf(sessionId)['nachträglich hinzugefügt'].sensorId).toBe('brand-new');
  });
});
