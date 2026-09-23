import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Integration test for Rohrverlängerung handling, against real SQLite.
 *
 * Covers the whole chain a Klemmbacke signal travels: MQTT reading → topic
 * resolution → phase tagging → session_readings → what the upload and the
 * export actually get handed.
 *
 * DB_PATH must be set before db.js is imported, hence the dynamic imports.
 */

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let mqttMod: typeof import('./mqtt.js');
let sensorMeta: typeof import('./sensor-meta.js');
let rwConfig: typeof import('./rohrwechsel-config.js');
let resolver: typeof import('./topic-resolver.js');
let calibration: typeof import('./calibration.js');

const DEPTH_TOPIC = 'machine/Tiefe';
const CLAMP_TOPIC = 'machine/Klemmbacke';
const RPM_TOPIC = 'machine/Drehzahl [1/min]';

const sensorMap = () =>
  new Map([
    ['bohrtiefe [m]', { sensorId: 's-depth', sensorType: 'float' }],
    ['drehzahl [1/min]', { sensorId: 's-rpm', sensorType: 'float' }],
  ]);

function publish(topic: string, payload: string): void {
  mqttMod.mqttSource.emit('reading', { topic, payload, receivedAt: Date.now() });
}

function enableRohrwechsel(): void {
  rwConfig.setRohrwechselConfig({
    clampTopic: CLAMP_TOPIC,
    depthMode: 'absolut',
    pipeLength: 2,
    closeThreshold: 100,
    openThreshold: 50,
    tolerance: 0.3,
  });
}

beforeAll(async () => {
  db = await import('./db.js');
  sensorMeta = await import('./sensor-meta.js');
  rwConfig = await import('./rohrwechsel-config.js');
  resolver = await import('./topic-resolver.js');
  calibration = await import('./calibration.js');
  ingestionMod = await import('./ingestion.js');
  mqttMod = await import('./mqtt.js');

  // Ankerbohren defines "Bohrtiefe [m]" with role `depth` — the role, not the
  // name, is what the per-pipe check keys off.
  sensorMeta.setActiveVerfahren('ankerbohren');
  db.setTopicOverride(DEPTH_TOPIC, 'Bohrtiefe [m]');
  resolver.clearResolverCache();

  // No broker is configured, so start() logs a warning and connects to
  // nothing. Readings are emitted on the source by hand below.
  ingestionMod.ingestion.setSource(mqttMod.mqttSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

describe('Rohrverlängerung through the ingestion pipeline', () => {
  it('clips the Rohrwechsel window and passes every value through unchanged', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-35', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(CLAMP_TOPIC, '2');
    publish(DEPTH_TOPIC, '0');
    publish(DEPTH_TOPIC, '2');
    // Klemmbacke closes: everything from here until it opens is a pipe change.
    publish(CLAMP_TOPIC, '180');
    publish(RPM_TOPIC, '40');     // Linkslauf — the drive unscrewing itself
    publish(DEPTH_TOPIC, '2');    // absolute: the bit has not moved
    publish(DEPTH_TOPIC, '2');
    publish(CLAMP_TOPIC, '3');    // new pipe in, drilling resumes
    publish(DEPTH_TOPIC, '2');
    publish(DEPTH_TOPIC, '3.97');

    ingestion.stopRecording();

    // What implenia-web gets, by upload or by exported file: the drilling
    // readings, exactly as the rig sent them, with the pipe change removed.
    const exported = db.getAllSessionReadings(sessionId);
    expect(exported.filter((r) => r.topic === DEPTH_TOPIC).map((r) => r.valueNumeric))
      .toEqual([0, 2, 2, 3.97]);

    // The phantom Drehzahl never reaches the export...
    expect(exported.some((r) => r.topic === RPM_TOPIC)).toBe(false);
    // ...nor the upload. No readings left for that sensor means no group.
    const groups = db.getSessionUploadGroups(sessionId);
    expect(groups.map((g) => g.sensorId).sort()).toEqual(['s-depth']);
    expect(groups[0].readings.map((r) => r.valueNumeric)).toEqual([0, 2, 2, 3.97]);

    // Nothing was thrown away: all ten readings are still on the kiosk.
    const stats = db.getSessionStats(sessionId);
    expect(stats.total).toBe(10);
    expect(stats.clipped).toBe(4);
  });

  it('records which phase each reading was taken in', () => {
    const sessionId = db.getSessions()[0].id;
    const detailed = db.getSessionReadingsDetailed(sessionId);

    const clipped = detailed.filter((r) => r.phase === 'rohrwechsel');
    // Every clipped reading carries the status that keeps it out of the upload.
    expect(clipped.every((r) => r.uploadStatus === 'clipped')).toBe(true);
    expect(clipped.map((r) => r.topic).sort()).toEqual(
      [CLAMP_TOPIC, DEPTH_TOPIC, DEPTH_TOPIC, RPM_TOPIC].sort(),
    );

    // ...and the drilling ones are still queued for it.
    expect(detailed.filter((r) => r.phase === 'bohren').every((r) => r.uploadStatus === 'pending'))
      .toBe(true);
  });

  it('never uploads the Klemmbacke itself — it is a machine signal', () => {
    const sessionId = db.getSessions()[0].id;
    const clampRows = db
      .getSessionReadingsDetailed(sessionId)
      .filter((r) => r.topic === CLAMP_TOPIC);
    expect(clampRows.length).toBeGreaterThan(0);
    // It matches no sensor of the Verfahren, so it has no sensor id and the
    // upload query cannot see it.
    expect(db.getSessionUploadGroups(sessionId).map((g) => g.sensorId)).not.toContain('klemmbacke');
  });

  it('uploads everything when no Klemmbacke is configured', () => {
    const { ingestion } = ingestionMod;
    rwConfig.setRohrwechselConfig({
      clampTopic: null,
      depthMode: 'absolut',
      pipeLength: 2,
      closeThreshold: 100,
      openThreshold: 50,
      tolerance: 0.3,
    });

    const sessionId = db.createSession('A-36', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(DEPTH_TOPIC, '1.5');
    publish(CLAMP_TOPIC, '180');
    publish(DEPTH_TOPIC, '1.5');
    publish(RPM_TOPIC, '40');

    ingestion.stopRecording();

    // A rig without a clamp signal behaves exactly as it did before this
    // existed: nothing clipped, everything uploaded.
    expect(db.getSessionStats(sessionId).clipped).toBe(0);
    expect(db.getAllSessionReadings(sessionId).some((r) => r.topic === RPM_TOPIC)).toBe(true);
  });

  it('keeps clipping across a restart mid-Rohrwechsel', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-37', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(CLAMP_TOPIC, '2');     // open: this is what arms the clipping
    publish(DEPTH_TOPIC, '2.0');
    publish(CLAMP_TOPIC, '180');

    // PM2 restarts the process — an auto-update, a crash. The in-memory state
    // is gone; only what was persisted survives.
    ingestion.stopRecording();
    ingestion.startRecording(sessionId, sensorMap());

    publish(RPM_TOPIC, '40');
    publish(CLAMP_TOPIC, '3');
    publish(DEPTH_TOPIC, '4.0');
    ingestion.stopRecording();

    // Without the persisted phase, that Drehzahl would have been recorded as
    // drilling data and uploaded.
    const rpm = db.getSessionReadingsDetailed(sessionId).filter((r) => r.topic === RPM_TOPIC);
    expect(rpm.map((r) => r.phase)).toEqual(['rohrwechsel']);
    expect(db.getAllSessionReadings(sessionId).some((r) => r.topic === RPM_TOPIC)).toBe(false);

    // ...and the pipe count carried over, so the screen says "Rohr 3 einbauen"
    // rather than starting again at one.
    expect(db.getAllSessionReadings(sessionId).map((r) => r.valueNumeric)).toContain(4.0);
  });

  it('does not read a blank Klemmbacke payload as an open clamp', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-38', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(CLAMP_TOPIC, '2');
    publish(DEPTH_TOPIC, '2.0');
    publish(CLAMP_TOPIC, '180');
    publish(CLAMP_TOPIC, '');     // must not end the Rohrwechsel
    publish(RPM_TOPIC, '40');

    // Still clipping: a missing clamp reading says nothing about the clamp.
    const rpm = db.getSessionReadingsDetailed(sessionId).filter((r) => r.topic === RPM_TOPIC);
    expect(rpm.map((r) => r.phase)).toEqual(['rohrwechsel']);

    ingestion.stopRecording();
  });

  it('applies a sensor calibration and keeps the reading as it arrived', () => {
    const { ingestion } = ingestionMod;
    rwConfig.setRohrwechselConfig({
      clampTopic: null, depthMode: 'absolut', pipeLength: 2,
      closeThreshold: 100, openThreshold: 50, tolerance: 0.3,
    });

    // A channel reading twice what it should.
    // "Drehzahl [1/min]" contains a slash, so its topic only resolves because
    // the resolver matches known sensor names rather than splitting on '/'.
    db.setCalibration('Drehzahl [1/min]', 0.5, -2);
    calibration.clearCalibrationCache();

    const sessionId = db.createSession('A-40', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    publish(RPM_TOPIC, '100');
    ingestion.stopRecording();

    const [row] = db.getSessionReadingsDetailed(sessionId).filter((r) => r.topic === RPM_TOPIC);
    // 100 × 0.5 − 2
    expect(row.valueNumeric).toBe(48);
    // ...and the reading as the rig sent it is still there, so a wrong factor
    // can be undone instead of having destroyed the measurement.
    expect(row.valueRaw).toBe(100);

    db.deleteCalibration('Drehzahl [1/min]');
    calibration.clearCalibrationCache();
  });

  it('does not clip during Verpressen, when the Klemmbacke simply holds the string', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-41', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    ingestion.setOperatingMode('verpressen');

    publish(DEPTH_TOPIC, '12.0');
    publish(CLAMP_TOPIC, '180');   // closed — but it is holding, not changing a pipe
    publish(RPM_TOPIC, '40');
    publish(DEPTH_TOPIC, '12.0');

    ingestion.stopRecording();

    // On the G08 capture the clamp is closed for 81% of Verpressen. Clipping on
    // it here would discard most of the grouting data — the data
    // Injektionsbohren exists to record.
    expect(db.getSessionStats(sessionId).clipped).toBe(0);
    expect(db.getAllSessionReadings(sessionId).some((r) => r.topic === RPM_TOPIC)).toBe(true);
  });

  it('clips again as soon as the worker switches back to Bohren', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-42', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    ingestion.setOperatingMode('verpressen');

    publish(CLAMP_TOPIC, '2');
    publish(CLAMP_TOPIC, '180');
    publish(RPM_TOPIC, '40');        // kept: grouting
    ingestion.setOperatingMode('bohren');
    publish(RPM_TOPIC, '41');        // clipped: the clamp is still closed
    ingestion.stopRecording();

    const rpm = db.getSessionReadingsDetailed(sessionId).filter((r) => r.topic === RPM_TOPIC);
    expect(rpm.map((r) => `${r.valueNumeric}:${r.uploadStatus}`).sort())
      .toEqual(['40:pending', '41:clipped']);
  });

  it('gives clipped readings back when the threshold was wrong', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-43', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    publish(CLAMP_TOPIC, '2');
    publish(DEPTH_TOPIC, '2.0');
    publish(CLAMP_TOPIC, '180');
    publish(RPM_TOPIC, '40');
    publish(DEPTH_TOPIC, '2.0');
    ingestion.stopRecording();

    expect(db.getSessionStats(sessionId).clipped).toBe(3);
    // Clipped readings are in no upload and in no exported file, and a reset
    // deletes them — so without a way back, a threshold typed one digit off
    // costs a shift of measurements sitting right there in the database.
    expect(db.getAllSessionReadings(sessionId).some((r) => r.topic === RPM_TOPIC)).toBe(false);

    expect(db.unclipSessionReadings(sessionId)).toBe(3);

    const stats = db.getSessionStats(sessionId);
    expect(stats.clipped).toBe(0);
    expect(stats.pending).toBe(stats.total);
    expect(db.getAllSessionReadings(sessionId).some((r) => r.topic === RPM_TOPIC)).toBe(true);
    expect(db.getSessionUploadGroups(sessionId).map((g) => g.sensorId).sort())
      .toEqual(['s-depth', 's-rpm']);

    // What was released is still recognisable afterwards — the phase stays on
    // the row, so a diagnosis is still possible.
    expect(
      db.getSessionReadingsDetailed(sessionId).some((r) => r.phase === 'rohrwechsel'),
    ).toBe(true);
  });

  it('does not freeze the depth while the rig is grouting', () => {
    const { ingestion } = ingestionMod;
    rwConfig.setRohrwechselConfig({
      clampTopic: CLAMP_TOPIC,
      depthMode: 'inkrementell',
      pipeLength: 2,
      closeThreshold: 100,
      openThreshold: 50,
      tolerance: 0.3,
    });

    const sessionId = db.createSession('A-44', '{}');
    ingestion.startRecording(sessionId, sensorMap());
    ingestion.setOperatingMode('verpressen');

    publish(CLAMP_TOPIC, '2');
    publish(DEPTH_TOPIC, '12.0');
    publish(CLAMP_TOPIC, '180');    // holding the string, as it does all through Verpressen
    publish(DEPTH_TOPIC, '10.5');   // string being pulled: the depth really is changing
    publish(DEPTH_TOPIC, '9.0');
    publish(CLAMP_TOPIC, '3');
    publish(DEPTH_TOPIC, '7.5');
    ingestion.stopRecording();

    // Nothing is clipped during Verpressen, so every one of these is uploaded.
    // Frozen at the hole bottom they would be a flat 12 m line, and the pipe
    // count and the offset would have walked up with each clamp cycle.
    expect(
      db.getAllSessionReadings(sessionId)
        .filter((r) => r.topic === DEPTH_TOPIC)
        .map((r) => r.valueNumeric),
    ).toEqual([12.0, 10.5, 9.0, 7.5]);
    expect(db.getSessionStats(sessionId).clipped).toBe(0);

    enableRohrwechsel();
  });

  it('reads a payload the recording path would accept as a number', () => {
    const { ingestion } = ingestionMod;
    enableRohrwechsel();

    const sessionId = db.createSession('A-45', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    // Some boxes append the unit. The recording path parses this with
    // parseFloat and stores 180; if clamp detection used a stricter parse it
    // would read NaN, and the Klemmbacke would silently never fire.
    publish(CLAMP_TOPIC, '2 bar');
    publish(DEPTH_TOPIC, '2.0');
    publish(CLAMP_TOPIC, '180 bar');
    publish(RPM_TOPIC, '40');
    ingestion.stopRecording();

    const rpm = db.getSessionReadingsDetailed(sessionId).filter((r) => r.topic === RPM_TOPIC);
    expect(rpm.map((r) => r.phase)).toEqual(['rohrwechsel']);
  });

  it('does not count clipped readings as data at risk', () => {
    // Clipped readings are never uploaded and never exported, so counting them
    // would make the reset guard refuse forever on any rig that changes pipes.
    const totals = db.getSessions().map((s) => db.getSessionStats(s.id));
    const atRisk = totals.reduce((n, t) => n + t.pending + t.failed, 0);
    const clipped = totals.reduce((n, t) => n + t.clipped, 0);

    expect(clipped).toBeGreaterThan(0);
    expect(db.getUnsafeDataSummary().readings).toBe(atRisk);
    // ...but they are reported, because a reset deletes them and telling a
    // worker nothing is at risk is how a mis-clipped shift gets lost.
    expect(db.getUnsafeDataSummary().clipped).toBe(clipped);
  });
});
