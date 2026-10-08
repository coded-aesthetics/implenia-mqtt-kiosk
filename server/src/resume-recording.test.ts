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
// Ankerbohren's cumulative slurry total. The rig publishes a running sum; the
// kiosk sensor of the same name is the per-element delta.
const VOLUME_TOPIC = 'machine/Q';

const SENSOR_MAP_JSON = JSON.stringify({
  'bohrtiefe [m]': { sensorId: 's-depth', sensorType: 'float', unit: 'm' },
  'q_suspension': { sensorId: 's-vol', sensorType: 'float', unit: 'l' },
});

const SENSOR_MAP = new Map([
  ['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }],
  ['q_suspension', { sensorId: 's-vol', sensorType: 'float' }],
]);

function publish(topic: string, payload: string): void {
  mqttMod.mqttSource.emit('reading', { topic, payload, receivedAt: Date.now() });
}

/**
 * The per-element volumes the UI was sent, in order.
 *
 * The delta is display-only — it is emitted, never recorded — so the WebSocket
 * broadcast is the only place it can be observed, which is also why a wrong
 * baseline corrupts nothing but is invisible to every other test.
 */
function emittedVolumes(run: () => void): number[] {
  const seen: number[] = [];
  const onReading = (r: { topic: string; payload: string }): void => {
    if (r.topic === 'Q_Suspension') seen.push(Number(r.payload));
  };
  ingestionMod.ingestion.on('reading', onReading);
  try {
    run();
  } finally {
    ingestionMod.ingestion.off('reading', onReading);
  }
  return seen;
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
  db.setTopicOverride(VOLUME_TOPIC, 'Q_Suspension');
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
    ingestion.startRecording(sessionId, SENSOR_MAP);

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
    ingestion.startRecording(sessionId, SENSOR_MAP);

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

  /**
   * The slurry volume is the number that tells a worker whether the pillar has
   * had its charge. It is a delta against the first cumulative total seen, and
   * that baseline lived only in memory: a restart re-baselined on whatever the
   * rig's totalizer read at boot, so the display fell back to zero mid-pillar
   * and counted up again. Nothing recorded was wrong, which is why this needed
   * looking for.
   */
  it('keeps the slurry volume counting from where the element started', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('A-15', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);

    const before = emittedVolumes(() => {
      publish(VOLUME_TOPIC, '100');    // baseline — the element starts at 0 l
      publish(VOLUME_TOPIC, '1170');
    });
    expect(before).toEqual([0, 1070]);

    ingestion.stopRecording();
    expect(recordingMod.resumeRecording()).toEqual({ sessionId });

    // 1200 on the rig's totalizer is still 1100 l into this element.
    const after = emittedVolumes(() => publish(VOLUME_TOPIC, '1200'));
    expect(after).toEqual([1100]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  it('starts a volume baseline from scratch for a fresh session', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('A-16', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);

    // Nothing recorded yet, so the next total is the baseline — the new
    // element must not inherit the previous one's.
    const seen = emittedVolumes(() => {
      publish(VOLUME_TOPIC, '1200');
      publish(VOLUME_TOPIC, '1250');
    });
    expect(seen).toEqual([0, 50]);

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  /**
   * The server knows the depth and the volume after a restart; the browser
   * does not. It holds no readings of its own, and the WebSocket only pushes
   * values as they arrive — so on a rig standing still (a Rohrwechsel, a pause,
   * a shift change) every tile reads 0 for a pillar that is half drilled, for
   * as long as the rig stays quiet.
   */
  it('offers the last known depth and volume to a screen that has just loaded', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('A-17', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);

    publish(DEPTH_TOPIC, '4.2');
    publish(VOLUME_TOPIC, '100');
    publish(VOLUME_TOPIC, '1170');

    // The process dies, boots, and a browser connects before the rig has
    // published anything new.
    ingestion.stopRecording();
    expect(recordingMod.resumeRecording()).toEqual({ sessionId });

    const byTopic = new Map(ingestion.latestReadings().map((r) => [r.topic, r.payload]));
    expect(byTopic.get(DEPTH_TOPIC)).toBe('4.2');
    // The delta, not the rig's running total — the screen shows what this
    // element has had.
    expect(byTopic.get('Q_Suspension')).toBe('1070');

    ingestion.stopRecording();
    db.endSession(sessionId);
  });

  it('does not let the snapshot overwrite a newer live reading', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('A-18', SENSOR_MAP_JSON);
    ingestion.startRecording(sessionId, SENSOR_MAP);
    publish(DEPTH_TOPIC, '4.2');

    ingestion.stopRecording();
    recordingMod.resumeRecording();
    publish(DEPTH_TOPIC, '4.5');

    const byTopic = new Map(ingestion.latestReadings().map((r) => [r.topic, r.payload]));
    expect(byTopic.get(DEPTH_TOPIC)).toBe('4.5');

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
