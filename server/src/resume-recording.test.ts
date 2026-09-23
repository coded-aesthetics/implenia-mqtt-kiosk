import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * A recording must survive the process restarting under it.
 *
 * PM2 restarts the kiosk mid-element on a crash, on a power cut, and when an
 * update is installed. The session row stays open across that, but nothing
 * used to re-attach the live recording to it — and the failure was silent in
 * the worst way: `insertBuffer` and the WebSocket broadcast both run *before*
 * the recording check in `onReading`, so the bar kept reading "Aufzeichnung
 * läuft" and the tiles kept ticking while nothing was written.
 *
 * "Restart" here is `stopRecording()` — the ingestion layer losing its
 * in-memory session, which is exactly what a process restart does to it —
 * followed by `resumeRecording()`, which is what boot now calls.
 *
 * DB_PATH is forced to ':memory:' by vitest.config.ts, hence the dynamic
 * imports: db.ts opens its connection at import time.
 */

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let recordingMod: typeof import('./recording.js');
let mqttMod: typeof import('./mqtt.js');
let sensorMeta: typeof import('./sensor-meta.js');
let rwConfig: typeof import('./rohrwechsel-config.js');
let resolver: typeof import('./topic-resolver.js');

const DEPTH_TOPIC = 'machine/Tiefe';
const CLAMP_TOPIC = 'machine/Klemmbacke';

const SENSOR_MAP_JSON = JSON.stringify({
  'bohrtiefe [m]': { sensorId: 's-depth', sensorType: 'float', unit: 'm' },
});

function publish(topic: string, payload: string): void {
  mqttMod.mqttSource.emit('reading', { topic, payload, receivedAt: Date.now() });
}

function depths(sessionId: number): (number | null)[] {
  return db
    .getAllSessionReadings(sessionId)
    .filter((r) => r.topic === DEPTH_TOPIC)
    .map((r) => r.valueNumeric);
}

beforeAll(async () => {
  db = await import('./db.js');
  sensorMeta = await import('./sensor-meta.js');
  rwConfig = await import('./rohrwechsel-config.js');
  resolver = await import('./topic-resolver.js');
  ingestionMod = await import('./ingestion.js');
  recordingMod = await import('./recording.js');
  mqttMod = await import('./mqtt.js');

  // Ankerbohren defines "Bohrtiefe [m]" with role `depth`.
  sensorMeta.setActiveVerfahren('ankerbohren');
  db.setTopicOverride(DEPTH_TOPIC, 'Bohrtiefe [m]');
  resolver.clearResolverCache();

  ingestionMod.ingestion.setSource(mqttMod.mqttSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

describe('a recording interrupted by a restart', () => {
  it('keeps recording into the same session afterwards', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('A-12', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, new Map([
      ['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }],
    ]));

    publish(DEPTH_TOPIC, '1');
    publish(DEPTH_TOPIC, '2');

    // The process dies here. The session row stays open.
    ingestion.stopRecording();
    publish(DEPTH_TOPIC, '3');   // lost — nothing is attached
    expect(depths(sessionId)).toEqual([1, 2]);

    // Boot.
    const resumed = recordingMod.resumeRecording();
    expect(resumed).toEqual({ sessionId });

    publish(DEPTH_TOPIC, '4');
    publish(DEPTH_TOPIC, '5');

    // Same session, and the sensor id came back with it — without that the
    // readings would be stored but never uploadable.
    expect(depths(sessionId)).toEqual([1, 2, 4, 5]);
    const groups = db.getSessionUploadGroups(sessionId);
    expect(groups.map((g) => g.sensorId)).toEqual(['s-depth']);
    expect(groups[0].readings.map((r) => r.valueNumeric)).toEqual([1, 2, 4, 5]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  it('picks the Rohrwechsel phase and pipe count back up', () => {
    const { ingestion } = ingestionMod;
    rwConfig.setRohrwechselConfig({
      clampTopic: CLAMP_TOPIC,
      depthMode: 'absolut',
      pipeLength: 2,
      closeThreshold: 100,
      openThreshold: 50,
      tolerance: 0.3,
    });

    const sessionId = db.createSession('A-13', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, new Map([
      ['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }],
    ]));

    publish(CLAMP_TOPIC, '2');     // seen open — arms the detection
    publish(DEPTH_TOPIC, '0');
    publish(DEPTH_TOPIC, '2');
    publish(CLAMP_TOPIC, '180');   // pipe change
    publish(CLAMP_TOPIC, '3');     // new pipe in — the count starts at 1
    expect(ingestion.drillStatus?.pipeCount).toBe(2);

    ingestion.stopRecording();
    recordingMod.resumeRecording();

    // Restored from drill_state, so the screen stays honest and the next
    // pipe is Rohr 3 rather than starting the count over.
    expect(ingestion.drillStatus?.pipeCount).toBe(2);
    expect(ingestion.drillStatus?.phase).toBe('bohren');

    // And clipping still works after the restart.
    publish(CLAMP_TOPIC, '180');
    expect(ingestion.drillStatus?.phase).toBe('rohrwechsel');
    publish(DEPTH_TOPIC, '2');
    publish(CLAMP_TOPIC, '3');
    expect(ingestion.drillStatus?.pipeCount).toBe(3);

    const clipped = db
      .getSessionReadingsDetailed(sessionId, 500)
      .filter((r) => r.uploadStatus === 'clipped');
    expect(clipped.length).toBeGreaterThan(0);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  it('does nothing when no session was left open', () => {
    expect(recordingMod.resumeRecording()).toBeNull();
    expect(ingestionMod.ingestion.drillStatus).toBeNull();
  });

  it('still records when the stored sensor map is damaged', () => {
    const { ingestion } = ingestionMod;
    // A corrupt map must not cost the rest of the element. The readings are
    // kept without a sensor id — not uploadable, but exportable and fixable,
    // which beats recording nothing at all.
    const sessionId = db.createSession('A-14', '{ not json');

    expect(recordingMod.resumeRecording()).toEqual({ sessionId });
    publish(DEPTH_TOPIC, '7');

    expect(depths(sessionId)).toEqual([7]);
    expect(db.getSessionUploadGroups(sessionId)).toEqual([]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });
});
