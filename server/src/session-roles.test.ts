import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * A sensor's role is pinned to the session that recorded it.
 *
 * A role (`depth`, `is_completed`, `geology_profile`, …) is a property of the
 * *element*: implenia-web's wizard stamps it into the sensor's `meta` when the
 * element is created, and the platform serves it back with
 * `include_meta=true`. The kiosk's copies of those same CSVs are whatever its
 * last release shipped, synced by hand.
 *
 * So two snapshots drift apart independently, and resolving a role against the
 * CSVs *at the moment of use* reads the wrong one in three situations:
 *
 * — an element created before a role moved to a different sensor,
 * — an element created before a sensor was renamed,
 * — any session that outlives an auto-update, since a kiosk takes one every
 *   hour and a recording can run for a day.
 *
 * The session's own `sensor_map` is therefore the authority, the same way it
 * already is for sensor ids, with the CSVs as the fallback for sessions
 * recorded before roles were persisted.
 */

/*
 * Offline throughout, so every session is started from the cached definitions
 * — the path where an element's own meta is all the kiosk has. A mock that
 * *resolved* would have the fetch succeed with no sensors at all and overwrite
 * the cache with that.
 */
vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn(async () => { throw new TypeError('fetch failed'); }),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./connectivity.js', () => ({
  connectivity: { isOnline: () => false, on: () => {}, off: () => {} },
}));

/**
 * What the kiosk's *current* sensor CSVs say — the snapshot that drifts.
 * Mutable so a test can make it disagree with an element on purpose.
 */
let csvRoles: Record<string, string | null> = {
  depth: 'Bohrtiefe',
  geology_profile: 'Geologieprofil',
  is_completed: 'Ausführungsdatum',
};

vi.mock('./sensor-meta.js', () => ({
  findSensorNameByRole: (role: string) => csvRoles[role] ?? null,
  getSensorMetaLookup: () => new Map(),
  getSensorRole: () => null,
  getActiveVerfahren: () => 'injektionsbohren',
  loadSensorCsv: () => [],
  getStreamSensors: () => [],
  getAvailableStreams: () => [],
  STREAM_LABELS: {},
}));

let db: typeof import('./db.js');
let recording: typeof import('./recording.js');
let herstellen: typeof import('./herstellen-sensors.js');
let geology: typeof import('./geology.js');

const T0 = 1_700_000_000_000;

/**
 * An element whose sensors are spelled the way the platform spells them, with
 * the roles the platform stamped at creation. `Bohrtiefe alt` is the renamed
 * sensor: no CSV the kiosk holds mentions it.
 */
const ELEMENT_SENSORS = {
  sensors_float: [
    {
      id: 'sf-depth', name: 'Bohrtiefe alt', unit: 'm',
      meta: { source: 'mqtt', role: 'depth' },
    },
  ],
  sensors_int: [
    { id: 'si-status', name: 'Status', meta: { source: 'user', role: 'mode' } },
  ],
  sensors_string: [
    {
      id: 'ss-profil', name: 'Geologieprofil Alt',
      meta: { source: 'kiosk', role: 'geology_profile' },
    },
    {
      id: 'ss-done', name: 'Ausführungsdatum Alt',
      meta: { source: 'user', role: 'is_completed' },
    },
  ],
};

beforeAll(async () => {
  db = await import('./db.js');
  recording = await import('./recording.js');
  herstellen = await import('./herstellen-sensors.js');
  geology = await import('./geology.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
});

beforeEach(() => {
  recording.abortRecording();
  db.resetKiosk();
  csvRoles = {
    depth: 'Bohrtiefe',
    geology_profile: 'Geologieprofil',
    is_completed: 'Ausführungsdatum',
  };
});

/** Start a session for an element whose definitions are only in the cache. */
async function startFromCache(elementName: string): Promise<number> {
  herstellen.cacheImportedSensors([
    { name: elementName, sensors: ELEMENT_SENSORS, vorgaben_sensor_ids: [] },
  ]);
  const { sessionId } = await recording.beginRecording(elementName);
  return sessionId;
}

describe('what a session records about its sensors', () => {
  it('persists each role and the platform spelling of each name', async () => {
    const sessionId = await startFromCache('P-01');
    const map = JSON.parse(db.getSessionById(sessionId)!.sensor_map);

    // Keyed lowercase, because that is all a resolved topic gives.
    expect(map['bohrtiefe alt']).toMatchObject({
      sensorId: 'sf-depth', sensorType: 'float',
      name: 'Bohrtiefe alt', role: 'depth',
    });
    expect(map['ausführungsdatum alt'].role).toBe('is_completed');
    expect(map['geologieprofil alt'].role).toBe('geology_profile');
  });

  it('returns the real spelling, never the lowercased key', async () => {
    const sessionId = await startFromCache('P-02');
    const map = recording.parseSensorMap(db.getSessionById(sessionId)!.sensor_map);

    /*
     * This is the one that would silently write to the wrong place. A
     * completion is addressed to the platform as
     * `string_sensors: { Ausführungsdatum Alt: … }`; the lowercased key is a
     * different sensor, or a newly created one nothing reads.
     */
    expect(recording.sensorNameByRole(map, 'is_completed')).toBe('Ausführungsdatum Alt');
    expect(recording.sensorNameByRole(map, 'depth')).toBe('Bohrtiefe alt');
  });

  it('prefers the session over a CSV that has since disagreed', async () => {
    const sessionId = await startFromCache('P-03');
    const map = recording.parseSensorMap(db.getSessionById(sessionId)!.sensor_map);

    // The kiosk updates mid-session and its CSVs now name a different sensor.
    csvRoles.depth = 'Ganz Anderer Sensor';

    expect(recording.sensorNameByRole(map, 'depth')).toBe('Bohrtiefe alt');
  });

  it('falls back to the CSVs for a session recorded before roles were persisted', () => {
    const legacy = recording.parseSensorMap(JSON.stringify({
      bohrtiefe: { sensorId: 'sf-old', sensorType: 'float' },
    }));

    expect(recording.sensorNameByRole(legacy, 'depth')).toBe('Bohrtiefe');
    expect(recording.sensorNameByRole(legacy, 'geology_profile')).toBe('Geologieprofil');
  });

  it('reports no role where neither the session nor the CSVs have one', () => {
    csvRoles = {};
    const map = recording.parseSensorMap(JSON.stringify({
      irgendwas: { sensorId: 'sf-x', sensorType: 'float', name: 'Irgendwas' },
    }));

    expect(recording.sensorNameByRole(map, 'depth')).toBeNull();
  });
});

describe('geology on an element the current CSVs no longer describe', () => {
  it('still finds the depth sensor, and reports the drilled depth', async () => {
    const sessionId = await startFromCache('P-04');

    // Drill 6 m on the sensor the CSVs do not know about.
    for (let i = 0; i <= 12; i++) {
      db.insertSessionReading(
        sessionId, 'rig/depth', 'sf-depth', 'float', i * 0.5, null,
        { receivedAt: T0 + i * 1000 },
      );
    }

    const session = db.getSessionById(sessionId)!;
    const context = geology.getGeologyContext(session);

    /*
     * Before roles were pinned, this resolved `depth` to `Bohrtiefe` from the
     * CSVs, found no such sensor in this session's map, and answered with
     * „Der Sensor „Bohrtiefe" fehlt in dieser Aufzeichnung" — costing the
     * element its geology while the measurements uploaded fine.
     */
    expect(context.hinweis).toBeUndefined();
    expect(context.verfuegbar).toBe(true);
    expect(context.gebohrt).toBe(true);
    expect(context.gebohrteTiefe).toBeCloseTo(6);
  });

  it('names the missing sensor with its real spelling when one is absent', async () => {
    // An element that declares geology but whose depth readings never arrived
    // under a mapped sensor: the session map is built from the definitions, so
    // drop the depth sensor from them.
    herstellen.cacheImportedSensors([{
      name: 'P-05',
      sensors: { ...ELEMENT_SENSORS, sensors_float: [] },
      vorgaben_sensor_ids: [],
    }]);
    const { sessionId } = await recording.beginRecording('P-05');

    const context = geology.getGeologyContext(db.getSessionById(sessionId)!);

    expect(context.verfuegbar).toBe(false);
    // The CSV fallback supplies the name here, since the session has no
    // depth-role sensor at all — and the message has to name something.
    expect(context.hinweis).toContain('Bohrtiefe');
  });
});
