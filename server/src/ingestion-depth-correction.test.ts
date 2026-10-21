import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Manual depth correction through the whole pipeline, against real SQLite.
 *
 * The arithmetic is covered by `depth-correction.test.ts`. What this one is
 * for is everything around it: that the corrected depth is what gets recorded
 * and what the screens are shown, that the correction survives a restart, that
 * it works on a kiosk with no Klemmbacke configured, and that the `Kommentar`
 * explaining the step in the depth series actually reaches the upload.
 *
 * DB_PATH must be set before db.js is imported, hence the dynamic imports.
 */

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let mqttMod: typeof import('./mqtt.js');
let sensorMeta: typeof import('./sensor-meta.js');
let rwConfig: typeof import('./rohrwechsel-config.js');
let resolver: typeof import('./topic-resolver.js');

const DEPTH_TOPIC = 'machine/Tiefe';
const CLAMP_TOPIC = 'machine/Klemmbacke';

const sensorMap = () =>
  new Map([
    ['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }],
    ['kommentar', { sensorId: 's-comment', sensorType: 'string' }],
  ]);

function publish(topic: string, payload: string): void {
  mqttMod.mqttSource.emit('reading', { topic, payload, receivedAt: Date.now() });
}

function setRohrwechsel(clampTopic: string | null, depthMode: 'absolut' | 'inkrementell'): void {
  rwConfig.setRohrwechselConfig({
    clampTopic, depthMode, pipeLength: 2, closeThreshold: 100, openThreshold: 50, tolerance: 0.3,
  });
}

/** The depth values that would be uploaded or exported, in order. */
function depths(sessionId: number): (number | null)[] {
  return db.getAllSessionReadings(sessionId)
    .filter((r) => r.topic === DEPTH_TOPIC)
    .map((r) => r.valueNumeric);
}

function comments(sessionId: number): string[] {
  return db.getSessionReadingsDetailed(sessionId)
    .filter((r) => r.valueText !== null && r.topic === 'kiosk/kommentar')
    .map((r) => r.valueText as string);
}

beforeAll(async () => {
  db = await import('./db.js');
  sensorMeta = await import('./sensor-meta.js');
  rwConfig = await import('./rohrwechsel-config.js');
  resolver = await import('./topic-resolver.js');
  ingestionMod = await import('./ingestion.js');
  mqttMod = await import('./mqtt.js');

  // Ankerbohren defines "Bohrtiefe [m]" with role `depth`, and a `Kommentar`
  // text sensor. The role, not the name, is what the depth path keys off.
  sensorMeta.setActiveVerfahren('ankerbohren');
  db.setTopicOverride(DEPTH_TOPIC, 'Bohrtiefe [m]');
  resolver.clearResolverCache();

  ingestionMod.ingestion.setSource(mqttMod.mqttSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

describe('depth correction through the ingestion pipeline', () => {
  it('records the corrected depth from then on, and nothing before', () => {
    const { ingestion } = ingestionMod;
    setRohrwechsel(CLAMP_TOPIC, 'absolut');

    const sessionId = db.createSession('A-40', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(DEPTH_TOPIC, '23.5');
    publish(DEPTH_TOPIC, '23.7');

    // The worker counts the pipes: the hole is 21,4 m, not 23,7 m.
    const applied = ingestion.correctDepth(-2.3);
    expect(applied.to).toBe(21.4);

    publish(DEPTH_TOPIC, '23.8');
    publish(DEPTH_TOPIC, '24.0');
    ingestion.stopRecording();

    // Forward-only: the wheel slips, so the error grew over the hole and the
    // early readings are closer to the truth than a constant shift would make
    // them. See applyDepthCorrection.
    expect(depths(sessionId)).toEqual([23.5, 23.7, 21.5, 21.7]);
  });

  it('keeps the raw value, so the uncorrected series is reconstructable', () => {
    const sessionId = db.getSessions()[0].id;
    // Newest first, as the detail view wants it.
    const rows = db.getSessionReadingsDetailed(sessionId)
      .filter((r) => r.topic === DEPTH_TOPIC)
      .reverse();

    const corrected = rows.filter((r) => r.valueRaw !== null);
    expect(corrected.map((r) => [r.valueRaw, r.valueNumeric]))
      .toEqual([[23.8, 21.5], [24.0, 21.7]]);
  });

  it('writes a German Kommentar that explains the step', () => {
    const sessionId = db.getSessions()[0].id;
    expect(comments(sessionId)).toEqual([
      'Tiefe korrigiert: 23,70 m → 21,40 m (-2,30 m; Korrektur auf diesem Element insgesamt -2,30 m)',
    ]);
  });

  it('uploads the Kommentar with the element', () => {
    // A live API call would be lost on a site with no connectivity. As a
    // session reading it goes up with everything else, whenever that happens.
    const sessionId = db.getSessions()[0].id;
    const group = db.getSessionUploadGroups(sessionId).find((g) => g.sensorId === 's-comment');
    expect(group?.readings.map((r) => r.valueText)).toHaveLength(1);
  });

  it('shows the corrected depth without waiting for the next reading', () => {
    // A worker corrects the depth while the rig stands still — which is
    // exactly when they have time to count pipes. The next reading may be
    // minutes away, and until then the screen would show the old value.
    const { ingestion } = ingestionMod;
    setRohrwechsel(CLAMP_TOPIC, 'absolut');

    const sessionId = db.createSession('A-41', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    publish(DEPTH_TOPIC, '8.0');

    ingestion.correctDepth(-1.5);

    const shown = ingestion.latestReadings().find((r) => r.topic === DEPTH_TOPIC);
    expect(shown?.payload).toBe('6.5');

    // ...and it is not recorded: the rig sent one reading, not two. A
    // synthetic depth reading is what geology boundaries would be dated on.
    ingestion.stopRecording();
    expect(depths(sessionId)).toEqual([8.0]);
  });

  it('survives a restart mid-element', () => {
    const { ingestion } = ingestionMod;
    setRohrwechsel(CLAMP_TOPIC, 'absolut');

    const sessionId = db.createSession('A-42', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    publish(DEPTH_TOPIC, '12.0');
    ingestion.correctDepth(-0.8);

    // PM2 restarts the process: an auto-update, a crash. `drill_state` is
    // written by the correction itself and not only at the next phase change,
    // which may be a pipe away or may never come.
    ingestion.stopRecording();
    ingestion.startRecording(sessionId, sensorMap());

    publish(DEPTH_TOPIC, '12.5');
    ingestion.stopRecording();

    expect(depths(sessionId)).toEqual([12.0, 11.7]);
  });

  it('updates the screen after a restart, before the rig publishes again', () => {
    // The combination this is for: a kiosk that auto-updated mid-element and a
    // rig standing still. The depth on screen was restored from the session's
    // own readings, and until the rig publishes again nothing would move it.
    const { ingestion } = ingestionMod;
    setRohrwechsel(CLAMP_TOPIC, 'absolut');

    const sessionId = db.createSession('A-46', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    publish(DEPTH_TOPIC, '30.0');
    ingestion.correctDepth(-1);          // persists the drill state
    ingestion.stopRecording();

    ingestion.startRecording(sessionId, sensorMap());
    ingestion.correctDepth(-2);

    const shown = ingestion.latestReadings().find((r) => r.topic === DEPTH_TOPIC);
    expect(shown?.payload).toBe('27');
    ingestion.stopRecording();
  });

  it('works on a kiosk with no Klemmbacke configured', () => {
    // A slipping wheel is not the retrofit's problem alone, and Rohrverlängerung
    // tracking is off whenever no clamp topic is set.
    const { ingestion } = ingestionMod;
    setRohrwechsel(null, 'absolut');

    const sessionId = db.createSession('A-43', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(DEPTH_TOPIC, '5.0');
    ingestion.correctDepth(0.4);
    publish(DEPTH_TOPIC, '5.2');
    ingestion.stopRecording();

    expect(depths(sessionId)).toEqual([5.0, 5.6]);
    // Still nothing clipped — no clamp signal, no phase.
    expect(db.getSessionStats(sessionId).clipped).toBe(0);
  });

  it('stops clipping when the Klemmbacke topic is removed mid-element', () => {
    // The depth now runs through the state machine whether or not a clamp is
    // configured. A phase left behind by a clamp topic that was removed has
    // nothing left to end it, and readings tagged `rohrwechsel` are dropped
    // from the upload and from the geology depth series.
    const { ingestion } = ingestionMod;
    setRohrwechsel(CLAMP_TOPIC, 'absolut');

    const sessionId = db.createSession('A-47', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    publish(CLAMP_TOPIC, '2');      // open — arms the clipping
    publish(DEPTH_TOPIC, '4.0');
    publish(CLAMP_TOPIC, '180');    // closed: a pipe change is under way

    setRohrwechsel(null, 'absolut');
    ingestion.refreshRohrwechselConfig();

    publish(DEPTH_TOPIC, '4.5');
    ingestion.stopRecording();

    const tiefen = db.getSessionReadingsDetailed(sessionId)
      .filter((r) => r.topic === DEPTH_TOPIC);
    expect(tiefen.every((r) => r.phase === 'bohren')).toBe(true);
    expect(depths(sessionId)).toEqual([4.0, 4.5]);

    // The Klemmbacke reading that closed the clamp is still clipped — it was
    // recorded while the feature was on, and that is what it was.
    expect(db.getSessionStats(sessionId).clipped).toBe(1);
  });

  it('refuses when nothing is being recorded, and says where to go instead', () => {
    // The path, not the word: this message exists to send somebody somewhere,
    // and it named "Einstellungen → Kalibrierung" for a screen that no longer
    // exists. Pinning the destination is what makes the next rename fail here.
    const { ingestion } = ingestionMod;
    expect(() => ingestion.correctDepth(-1)).toThrow(/Datenstrom/);
  });

  it('corrects the depth even when the element has no Kommentar sensor', () => {
    // The comment is how the platform learns why the series steps, but losing
    // it must not cost the correction itself.
    const { ingestion } = ingestionMod;
    setRohrwechsel(null, 'absolut');

    const sessionId = db.createSession('A-44', '{}');
    ingestion.startRecording(
      sessionId,
      new Map([['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }]]),
    );

    publish(DEPTH_TOPIC, '9.0');
    expect(ingestion.correctDepth(-1).to).toBe(8);
    publish(DEPTH_TOPIC, '9.2');
    ingestion.stopRecording();

    expect(depths(sessionId)).toEqual([9.0, 8.2]);
    expect(comments(sessionId)).toEqual([]);
  });

  it('reports the running total, which is the slip diagnosis', () => {
    const { ingestion } = ingestionMod;
    setRohrwechsel(null, 'absolut');

    const sessionId = db.createSession('A-45', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(DEPTH_TOPIC, '10.0');
    expect(ingestion.correctDepth(-0.4).total).toBe(-0.4);
    publish(DEPTH_TOPIC, '20.0');
    expect(ingestion.correctDepth(-0.6).total).toBe(-1);
    expect(ingestion.depthCorrection).toBe(-1);

    ingestion.stopRecording();
    // Per hole: the next element starts from a depth of its own.
    expect(ingestion.depthCorrection).toBeNull();
  });
});
