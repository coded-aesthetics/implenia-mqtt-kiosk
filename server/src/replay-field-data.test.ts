import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDump, topicCounts, type DumpMessage } from './mqtt-dump.js';
import {
  applyClampPressure, initialDrillState, observeDepth, DEFAULT_SETTINGS,
  type DepthMode,
} from './rohrwechsel.js';
import { applyCalibration } from './calibration.js';

/**
 * Replay of real field data through the real pipeline.
 *
 * The fixtures are slices of a two-hour capture from Bohrung G08 in Marktbreit
 * (18.05.2026) — see `assets/reference/README.md` for the capture itself, the
 * screenshots of the old UI taken during the same session, and what is known
 * to be true about both.
 *
 * This is the only test that runs against data nobody invented. The numbers it
 * asserts were measured from the capture, not chosen: one clamp closure lasting
 * 88 seconds, 3127 of 5307 messages inside it.
 *
 * DB_PATH must be set before db.js is imported, hence the dynamic imports.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'test-fixtures');

function loadFixture(name: string): DumpMessage[] {
  return parseDump(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

/** Rig topic → sensor name of the Injektionsbohren Verfahren. Wired on site. */
const TOPIC_BINDINGS: Record<string, string> = {
  'Bohrgeraet/Tiefe': 'Bohrtiefe',
  'Bohrgeraet/Drehzahl': 'Drehzahl',
  'Maschine/Druck_Hammer': 'Druck Hammer',
  'Maschine/Druck_Vorschub': 'Vorschubdruck',
  'Spuelpumpe/Volumen': 'Q_Bohren',
  'Spuelpumpe/Durchfluss': 'DurchflussB',
  'Verpresspumpe/Volumen': 'Q_verpressen',
  'Verpresspumpe/Durchfluss': 'DurchflussV',
};

const CLAMP_TOPIC = 'Bohrgeraet/Klemmdruck';

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let mqttMod: typeof import('./mqtt.js');
let sensorMeta: typeof import('./sensor-meta.js');
let rwConfig: typeof import('./rohrwechsel-config.js');
let resolver: typeof import('./topic-resolver.js');

function sensorMap(): Map<string, { sensorId: string; sensorType: string }> {
  const map = new Map<string, { sensorId: string; sensorType: string }>();
  for (const name of Object.values(TOPIC_BINDINGS)) {
    map.set(name.toLowerCase(), { sensorId: `s-${name.toLowerCase()}`, sensorType: 'float' });
  }
  return map;
}

function replay(messages: DumpMessage[]): void {
  for (const m of messages) {
    mqttMod.mqttSource.emit('reading', {
      topic: m.topic,
      payload: m.payload,
      receivedAt: m.offsetMs,
    });
  }
}

beforeAll(async () => {
  db = await import('./db.js');
  sensorMeta = await import('./sensor-meta.js');
  rwConfig = await import('./rohrwechsel-config.js');
  resolver = await import('./topic-resolver.js');
  ingestionMod = await import('./ingestion.js');
  mqttMod = await import('./mqtt.js');

  sensorMeta.setActiveVerfahren('injektionsbohren');
  for (const [topic, sensorName] of Object.entries(TOPIC_BINDINGS)) {
    db.setTopicOverride(topic, sensorName);
  }
  resolver.clearResolverCache();

  // Thresholds measured from this rig, not the kiosk defaults: Klemmdruck is
  // bimodal at ~1650 open and ~4200 closed, in whatever unit that is — it is
  // certainly not the bar the defaults assume.
  rwConfig.setRohrwechselConfig({
    clampTopic: CLAMP_TOPIC,
    depthMode: 'inkrementell',
    pipeLength: 2,
    closeThreshold: 3500,
    openThreshold: 2500,
    tolerance: 0.3,
  });

  ingestionMod.ingestion.setSource(mqttMod.mqttSource);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

describe('replaying a Rohrwechsel recorded in the field', () => {
  const messages = loadFixture('g8-rohrwechsel.txt');

  it('is the slice of the capture we think it is', () => {
    // Guards the fixture itself: if someone re-cuts it, the numbers below stop
    // meaning anything and this says so first.
    expect(messages).toHaveLength(5307);
    expect(messages[0].time).toBe('15:46:00.044');
    expect(topicCounts(messages).size).toBe(14);
    expect(topicCounts(messages).get(CLAMP_TOPIC)).toBe(514);
  });

  it('clips exactly the 88 seconds the Klemmbacke was closed', () => {
    const { ingestion } = ingestionMod;
    const sessionId = db.createSession('G08', '{}');
    ingestion.startRecording(sessionId, sensorMap());

    replay(messages);
    ingestion.stopRecording();

    const stats = db.getSessionStats(sessionId);
    expect(stats.total).toBe(5307);
    // Measured from the capture: the clamp closes at 15:46:31.425 and opens
    // again at 15:47:59.751, and 3127 messages fall in between.
    expect(stats.clipped).toBe(3127);
    expect(stats.pending).toBe(5307 - 3127);
  });

  it('counts one pipe, from a signal nobody designed for us', () => {
    // 43% of the drilling phase of this capture is the clamp being closed.
    // That is how much of a recorded element is not drilling data.
    const sessionId = db.getSessions()[0].id;
    const clipped = db
      .getSessionReadingsDetailed(sessionId, 6000)
      .filter((r) => r.phase === 'rohrwechsel');

    expect(clipped).toHaveLength(3127);
    expect(clipped.every((r) => r.uploadStatus === 'clipped')).toBe(true);
    // Every topic keeps producing through a pipe change, so all of them are
    // represented in what gets held back — not just the depth.
    expect(new Set(clipped.map((r) => r.topic)).size).toBe(14);
  });

  it('holds back the Drehzahl the rig reports while it unscrews itself', () => {
    const sessionId = db.getSessions()[0].id;
    const uploaded = db.getSessionUploadGroups(sessionId);
    const rpm = uploaded.find((g) => g.sensorId === 's-drehzahl');
    expect(rpm).toBeDefined();

    // Left in, the Linkslauf and the idle stretches of a pipe change drag the
    // average down. This is the whole point of the exercise.
    const mean = (rs: { valueNumeric: number | null }[]) =>
      rs.reduce((a, r) => a + (r.valueNumeric ?? 0), 0) / rs.length;
    const uploadedMean = mean(rpm!.readings);

    const allRpm = messages
      .filter((m) => m.topic === 'Bohrgeraet/Drehzahl')
      .map((m) => ({ valueNumeric: Number(m.payload) }));
    expect(uploadedMean).toBeGreaterThan(mean(allRpm) * 1.5);
  });

  it('never uploads the Klemmdruck — it is not a sensor of this Verfahren', () => {
    const sessionId = db.getSessions()[0].id;
    // Injektionsbohren defines no clamp sensor, so the topic resolves to
    // nothing and the upload query cannot see it. It is still recorded.
    expect(db.getSessionUploadGroups(sessionId).map((g) => g.sensorId))
      .not.toContain('s-klemmdruck');
    expect(
      db.getSessionReadingsDetailed(sessionId, 6000).some((r) => r.topic === CLAMP_TOPIC),
    ).toBe(true);
  });
});

/**
 * Replay just the depth signal through the pure state machine, and report how
 * the recorded depth behaved.
 */
function depthTrace(messages: DumpMessage[], depthMode: DepthMode, scale = 1) {
  const settings = {
    ...DEFAULT_SETTINGS, depthMode, pipeLength: 2,
    closeThreshold: 3500, openThreshold: 2500, tolerance: 0.3,
  };
  // What the calibration layer does to every reading before ingestion hands it
  // to the state machine.
  const calibration = { scale, offset: 0 };
  let state = initialDrillState();
  let first: number | null = null;
  let previous: number | null = null;
  let last = 0;
  let worstBackwardsStep = 0;

  for (const m of messages) {
    if (m.topic === CLAMP_TOPIC && m.payload !== 'nan') {
      state = applyClampPressure(state, Number(m.payload), settings, m.offsetMs).state;
      continue;
    }
    if (m.topic !== 'Bohrgeraet/Tiefe') continue;

    const { state: next, depth } = observeDepth(
      state, applyCalibration(Number(m.payload), calibration), settings,
    );
    state = next;
    // Only what actually gets recorded as drilling data.
    if (depth === null || state.phase !== 'bohren') continue;
    if (first === null) first = depth;
    if (previous !== null) worstBackwardsStep = Math.min(worstBackwardsStep, depth - previous);
    previous = depth;
    last = depth;
  }
  return { first: first!, last, worstBackwardsStep, offset: state.offset };
}

describe('the two kinds of rig, on the same recorded Rohrwechsel', () => {
  const messages = loadFixture('g8-rohrwechsel.txt');

  it('leaves a gap of metres in the depth when read as absolute', () => {
    // G08 is a retrofitted rig, so this is the wrong setting for it — and the
    // capture shows exactly what wrong looks like. The Drehantrieb travels
    // back up the mast and the recorded depth follows it, so the hole appears
    // to get 5.6 m shallower in a single step and then ends shallower than it
    // started.
    const trace = depthTrace(messages, 'absolut');
    expect(trace.worstBackwardsStep).toBeLessThan(-5);
    expect(trace.last).toBeLessThan(trace.first + 2);
    expect(trace.offset).toBe(0);
  });

  it('runs continuously when read as a Schlittenweg', () => {
    const trace = depthTrace(messages, 'inkrementell');
    // Not one backwards step: the depth is held while the string is clamped
    // and picks up from the hole bottom when it is released.
    expect(trace.worstBackwardsStep).toBe(0);
    expect(trace.last).toBeGreaterThan(trace.first);
    // The offset the rig's own geometry produced, not one we chose.
    expect(trace.offset).toBeCloseTo(5.635, 2);
  });

  it('matches the depth the operator saw once the rig is calibrated', () => {
    // G08's depth sensor sits on the feed, not in the hole: the carriage
    // travels about 2.6 m per metre drilled. The factor was measured by reading
    // the old UI's own depth display off the session video frame by frame and
    // joining it to this capture — see assets/reference/README.md. On a real
    // kiosk it is the Bohrtiefe sensor's calibration factor.
    //
    // Over this window the operator watched the depth go 30,16 m -> ~32,9 m.
    const calibrated = depthTrace(messages, 'inkrementell', 0.3793);
    expect(calibrated.last - calibrated.first).toBeCloseTo(2.75, 1);

    // Uncalibrated, the same readings claim two and a half times the hole.
    const uncalibrated = depthTrace(messages, 'inkrementell');
    expect(uncalibrated.last - uncalibrated.first).toBeCloseTo(7.26, 1);
  });
});

describe('replaying the switch from Bohren to Verpressen', () => {
  const messages = loadFixture('g8-bohren-verpressen.txt');

  it('is the slice of the capture we think it is', () => {
    expect(messages).toHaveLength(5309);
    expect(messages[0].time).toBe('16:01:30.061');
  });

  it('shows the switch as one pump stopping and the other starting', () => {
    const lastSpuel = [...messages]
      .filter((m) => m.topic === 'Spuelpumpe/Volumen')
      .reduce((prev, m) => (Number(m.payload) > Number(prev.payload) ? m : prev));
    const firstVerpress = messages
      .filter((m) => m.topic === 'Verpresspumpe/Volumen')
      .find((m) => Number(m.payload) > 98)!;

    // The operator switched at 16:03 — visible in the data to the second,
    // with no message announcing it.
    expect(lastSpuel.time.startsWith('16:03:33')).toBe(true);
    expect(firstVerpress.time.startsWith('16:03:55')).toBe(true);
  });

  it('shows the Klemmbacke staying closed right through the switch', () => {
    // This is the finding that matters most in this capture: during Verpressen
    // the clamp holds the string, so it is closed 81% of that phase — against
    // 43% while drilling. A clamp-only gate would therefore discard most of
    // the grouting data, which is exactly the data Injektionsbohren exists to
    // record. Clipping has to know which mode the rig is in.
    const clamp = messages
      .filter((m) => m.topic === CLAMP_TOPIC && m.payload !== 'nan')
      .map((m) => Number(m.payload));

    expect(clamp).toHaveLength(515);
    expect(Math.min(...clamp)).toBeGreaterThan(3500);
  });
});
