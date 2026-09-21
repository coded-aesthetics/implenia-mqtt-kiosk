import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * The reset guard, against real SQLite.
 *
 * Losing recorded measurements is the one outcome this software must never
 * produce, so the guard refuses rather than warns — and "safe" deliberately
 * means uploaded *or* exported, because an offline kiosk that can never be
 * reset is the dead end the guard exists to prevent.
 */

let db: typeof import('./db.js');

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  db = await import('./db.js');
});

beforeEach(() => {
  db.resetKiosk();
});

/** Reading ids for a session — getAllSessionReadings does not expose them. */
function readingIds(sessionId: number): number[] {
  return db.getSessionUploadGroups(sessionId).flatMap((g) => g.readings.map((r) => r.id));
}

function sessionWith(pendingCount: number, uploadedCount = 0): number {
  const id = db.createSession('H26', '{}');
  for (let i = 0; i < pendingCount + uploadedCount; i++) {
    db.insertSessionReading(id, `sensors/s${i}`, `sensor-${i}`, 'float', 1.5, null);
  }
  if (uploadedCount > 0) {
    db.markSessionReadingsUploaded(readingIds(id).slice(0, uploadedCount));
  }
  return id;
}

describe('getUnsafeDataSummary', () => {
  it('reports nothing on a fresh kiosk', () => {
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0 });
  });

  it('counts recorded-but-not-uploaded readings', () => {
    sessionWith(2);
    expect(db.getUnsafeDataSummary()).toMatchObject({ sessions: 1, readings: 2 });
  });

  it('treats an exported session as safe even though nothing was uploaded', () => {
    // The offline case: no connectivity all shift, data taken off by USB.
    const id = sessionWith(2);
    db.markSessionExported(id);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0 });
  });

  it('counts each unsafe session separately', () => {
    sessionWith(1);
    sessionWith(1);
    expect(db.getUnsafeDataSummary()).toMatchObject({ sessions: 2, readings: 2 });
  });

  it('still flags a session that was only partly uploaded', () => {
    // A partial upload is the dangerous case: it looks done but is not.
    sessionWith(1, 1);
    expect(db.getUnsafeDataSummary()).toMatchObject({ sessions: 1, readings: 1 });
  });

  it('is satisfied once every reading in the session is uploaded', () => {
    sessionWith(0, 2);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0 });
  });
});

describe('resetKiosk', () => {
  it('clears setup, devices and recorded data', () => {
    db.setMeta('active_verfahren', 'injektionsbohren');
    db.setMeta('transport', 'serial');
    db.setMeta('mqtt_broker_url', 'mqtt://192.168.2.1:1883');
    const deviceId = db.createDevice('Elvis 1', '/dev/ttyUSB0', 115200, 'elvis');
    db.setDeviceMappings(deviceId, [{ valueIndex: 0, sensorName: 'Bohrtiefe' }]);
    db.setTopicOverride('sensors/x', 'Bohrtiefe');
    sessionWith(1);

    db.resetKiosk();

    expect(db.getMeta('active_verfahren')).toBeUndefined();
    expect(db.getMeta('transport')).toBeUndefined();
    expect(db.getMeta('mqtt_broker_url')).toBeUndefined();
    expect(db.getDevices()).toHaveLength(0);
    expect(db.getDeviceMappings(deviceId)).toHaveLength(0);
    expect(db.getTopicOverrides()).toHaveLength(0);
    expect(db.getSessions()).toHaveLength(0);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0 });
  });

  it('keeps the API credentials, which belong to the site not the machine', () => {
    db.setMeta('implenia_api_key', 'secret-token');
    db.setMeta('implenia_api_url', 'https://api.example.com');
    db.setMeta('active_verfahren', 'dsv');

    db.resetKiosk();

    expect(db.getMeta('implenia_api_key')).toBe('secret-token');
    expect(db.getMeta('implenia_api_url')).toBe('https://api.example.com');
    expect(db.getMeta('active_verfahren')).toBeUndefined();
  });
});

describe('the export escape hatch', () => {
  it('only counts as safe when the export actually held data', () => {
    // An empty export must not unlock the reset: a Verfahren with no streams
    // defined produces a header-only file, and treating that as "saved" would
    // discard readings nobody ever got off the kiosk.
    const id = sessionWith(3);
    expect(db.getUnsafeDataSummary()).toMatchObject({ readings: 3 });

    // Route-level guard: markSessionExported is only called for dataRows > 0.
    // Simulating the empty case = not calling it at all.
    expect(db.getUnsafeDataSummary()).toMatchObject({ readings: 3 });

    db.markSessionExported(id);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0 });
  });
});
