import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Integration test for the serial ingestion path, against real SQLite.
 *
 * Serial data used to reach the WebSocket only: it displayed live and was
 * never recorded or uploaded. This asserts the whole chain — device frame →
 * channel mapping → reading → session_readings — with a real in-memory
 * database, real ingestion and the real mapping resolution.
 *
 * DB_PATH must be set before db.js is imported, hence the dynamic imports.
 */

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let deviceSourceMod: typeof import('./device-source.js');
let deviceManagerMod: typeof import('./device-manager.js');

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  db = await import('./db.js');
  ingestionMod = await import('./ingestion.js');
  deviceSourceMod = await import('./device-source.js');
  deviceManagerMod = await import('./device-manager.js');

  // Start ingestion on the serial source while the devices table is empty:
  // deviceManager finds nothing to open, so no real port is touched. Device
  // rows added later supply channel mappings only; frames are emitted by hand.
  ingestionMod.ingestion.setSource(deviceSourceMod.deviceSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

function frame(deviceId: number, values: number[]) {
  return { deviceId, values, receivedAt: Date.now() };
}

describe('serial ingestion', () => {
  it('records a device frame into the active session via its channel mapping', () => {
    const { ingestion } = ingestionMod;
    const { deviceSource } = deviceSourceMod;
    const { deviceManager } = deviceManagerMod;

    // A device with two mapped channels; index 2 is deliberately unmapped.
    const deviceId = db.createDevice('Elvis 1', '/dev/null', 115200, 'elvis');
    db.setDeviceMappings(deviceId, [
      { valueIndex: 0, sensorName: 'Bohrtiefe' },
      { valueIndex: 1, sensorName: 'Suspensionsdruck' },
    ]);
    deviceSource.clearMappingCache();

    // Route ingestion at the serial source without touching real hardware:
    // frames are emitted straight from deviceManager below.

    const sensorMap = new Map([
      ['bohrtiefe', { sensorId: 'sensor-depth', sensorType: 'float' }],
      ['suspensionsdruck', { sensorId: 'sensor-pressure', sensorType: 'float' }],
    ]);
    const sessionId = db.createSession('H26', '{}');
    ingestion.startRecording(sessionId, sensorMap);

    deviceManager.emit('frame', frame(deviceId, [16.04, 45.95, 999]));
    ingestion.stopRecording();

    const readings = db.getAllSessionReadings(sessionId);
    const byTopic = new Map(readings.map((r) => [r.topic, r]));

    expect(readings).toHaveLength(2);
    expect(byTopic.get(`device/${deviceId}/Bohrtiefe`)?.valueNumeric).toBe(16.04);
    expect(byTopic.get(`device/${deviceId}/Suspensionsdruck`)?.valueNumeric).toBe(45.95);
    // The unmapped channel produces nothing at all — not an orphan row.
    expect(readings.some((r) => String(r.valueNumeric) === '999')).toBe(false);
  });

  it('gives mapped readings a sensor id, so they are actually uploaded', () => {
    const { ingestion } = ingestionMod;
    const { deviceSource } = deviceSourceMod;
    const { deviceManager } = deviceManagerMod;

    const deviceId = db.createDevice('Elvis 2', '/dev/null', 115200, 'elvis');
    db.setDeviceMappings(deviceId, [{ valueIndex: 0, sensorName: 'Bohrtiefe' }]);
    deviceSource.clearMappingCache();

    const sessionId = db.createSession('H27', '{}');
    ingestion.startRecording(
      sessionId,
      new Map([['bohrtiefe', { sensorId: 'sensor-depth', sensorType: 'float' }]]),
    );
    deviceManager.emit('frame', frame(deviceId, [21.5]));
    ingestion.stopRecording();

    // getSessionUploadGroups filters out rows with a null sensor_id, so this
    // is the difference between "recorded" and "actually uploaded".
    const groups = db.getSessionUploadGroups(sessionId);
    expect(groups).toHaveLength(1);
    expect(groups[0].sensorId).toBe('sensor-depth');
    expect(groups[0].readings[0].valueNumeric).toBe(21.5);
  });

  it('records nothing when no session is active', () => {
    const { ingestion } = ingestionMod;
    const { deviceSource } = deviceSourceMod;
    const { deviceManager } = deviceManagerMod;

    const deviceId = db.createDevice('Elvis 3', '/dev/null', 115200, 'elvis');
    db.setDeviceMappings(deviceId, [{ valueIndex: 0, sensorName: 'Bohrtiefe' }]);
    deviceSource.clearMappingCache();

    const sessionId = db.createSession('H28', '{}');
    deviceManager.emit('frame', frame(deviceId, [5.0]));

    expect(db.getAllSessionReadings(sessionId)).toHaveLength(0);
  });
});
