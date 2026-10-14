import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * A replay seek rebuilds a session, and must rebuild all of it.
 *
 * Seeking is how the replay server fast-forwards a dump: it tells the kiosk to
 * throw the session's readings away and streams them again from position 0.
 * `resetForSeek` does that — and it also used to drop the one reading the
 * session was *born* with rather than received.
 *
 * `startRecording` writes the current operating mode as a `Status` reading,
 * because a mode is otherwise only recorded when it changes. Clear it and a
 * session that drills in the mode it already had carries no `Status = 0` row
 * at all, which empties every phase-segmented value implenia-web derives — the
 * drilling duration, the averages, the depth chart and every observed geology
 * layer — while the depth series itself uploads complete. The one flow that
 * reaches it is "hit record, then start the replay", i.e. every QA run.
 *
 * DB_PATH is forced to ':memory:' by vitest.config.ts, hence the dynamic
 * imports: db.ts opens its connection at import time.
 */

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let mqttMod: typeof import('./mqtt.js');
let sensorMeta: typeof import('./sensor-meta.js');
let resolver: typeof import('./topic-resolver.js');

const DEPTH_TOPIC = 'Bohrgeraet/Tiefe';

const SENSOR_MAP = new Map([
  ['bohrtiefe', { sensorId: 's-depth', sensorType: 'float', name: 'Bohrtiefe', role: 'depth', source: 'mqtt' }],
  ['status', { sensorId: 's-status', sensorType: 'int', name: 'Status', role: 'mode', source: 'user' }],
]);
const SENSOR_MAP_JSON = JSON.stringify(Object.fromEntries(SENSOR_MAP));

function publish(topic: string, payload: string): void {
  mqttMod.mqttSource.emit('reading', { topic, payload, receivedAt: Date.now() });
}

/** What the replay server sends when it starts fast-forwarding. */
function seek(): void {
  mqttMod.mqttSource.emit('seek-start');
}

function statusValues(sessionId: number): (number | null)[] {
  return db
    .getAllSessionReadings(sessionId)
    .filter((r) => r.topic === 'kiosk/status')
    .map((r) => r.valueNumeric);
}

beforeAll(async () => {
  db = await import('./db.js');
  sensorMeta = await import('./sensor-meta.js');
  resolver = await import('./topic-resolver.js');
  ingestionMod = await import('./ingestion.js');
  mqttMod = await import('./mqtt.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }

  sensorMeta.setActiveVerfahren('injektionsbohren');
  resolver.clearResolverCache();
  ingestionMod.ingestion.setSource(mqttMod.mqttSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

describe('a session a replay has seeked', () => {
  it('still carries the mode it is recording in', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('S-01', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);
    expect(statusValues(sessionId)).toEqual([0]);

    publish(DEPTH_TOPIC, '1.5');
    seek();

    // The readings are gone, as intended — the dump is about to stream again.
    expect(db.getAllSessionReadings(sessionId).filter((r) => r.topic === DEPTH_TOPIC)).toEqual([]);
    // The mode is not, because nothing would ever say it again.
    expect(statusValues(sessionId)).toEqual([0]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  it('is not left phaseless when the dump announces the mode it already has', () => {
    // The G08 dump opens with `kiosk/operating-mode bohren`, and the kiosk is
    // already in bohren, so `setOperatingMode` returns early and writes
    // nothing. Before the fix, that left the session with its first Status row
    // at the step *out* of drilling — a series starting at 1, which says the
    // element was never drilled.
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('S-02', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);

    seek();
    publish('kiosk/operating-mode', 'bohren');
    publish(DEPTH_TOPIC, '0.0');
    publish(DEPTH_TOPIC, '2.0');
    publish('kiosk/operating-mode', 'austausch');

    // 0 is drilling, 2 is Austausch — 1 belongs to Auffüllen, which is what
    // the protocol's second column reports. See `recordStatusReading`.
    expect(statusValues(sessionId)).toEqual([0, 2]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });
});
