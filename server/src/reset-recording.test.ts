import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from './data-source.js';

/**
 * Resetting while a recording is running, against real SQLite.
 *
 * The reset deletes `recording_sessions`, but the ingestion layer holds the
 * session id in memory. With `foreign_keys = ON` the next reading is an insert
 * against a parent row that no longer exists — and that throw happens inside
 * the data source's *synchronous* 'reading' handler, so nothing catches it and
 * the process dies.
 *
 * It is reachable in exactly the situation the reset exists for: a recording
 * was started, no data arrived because the broker was misconfigured, the reset
 * is allowed because nothing was recorded — and then the broker starts
 * working.
 */

class FakeSource extends DataSource {
  start(): void {}
  stop(): void {}
  get connected(): boolean { return true; }
  get sourceType(): string { return 'fake'; }
  emitReading(topic: string, payload: string): void {
    this.emit('reading', { topic, payload, receivedAt: Date.now() });
  }
}

let db: typeof import('./db.js');
let ingestionMod: typeof import('./ingestion.js');
let recordingMod: typeof import('./recording.js');
let source: FakeSource;

beforeAll(async () => {
  db = await import('./db.js');
  ingestionMod = await import('./ingestion.js');
  recordingMod = await import('./recording.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }

  source = new FakeSource();
  ingestionMod.ingestion.setSource(source);
  ingestionMod.ingestion.start();
});

afterAll(() => {
  ingestionMod.ingestion.stop();
});

beforeEach(() => {
  ingestionMod.ingestion.stopRecording();
  db.resetKiosk();
});

describe('a reading after the session row is gone', () => {
  it('is rejected by the foreign key — which is why the reset must detach first', () => {
    const sessionId = db.createSession('H26', '{}');
    db.resetKiosk();

    expect(() =>
      db.insertSessionReading(sessionId, 'sensors/x', 'sensor-1', 'float', 1.5, null),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('reset while recording', () => {
  it('does not throw on the next reading once the recording is detached', () => {
    const sessionId = db.createSession('H26', '{}');
    ingestionMod.ingestion.startRecording(
      sessionId,
      new Map([['x', { sensorId: 'sensor-1', sensorType: 'float' }]]),
    );

    // What the reset route does, in order.
    recordingMod.abortRecording();
    db.resetKiosk();

    // Data starts arriving again — the broker was fixed, or the machine was
    // switched on. This is the moment that used to kill the process.
    expect(() => source.emitReading('sensors/x', '1.5')).not.toThrow();
  });

  it('keeps buffering live data after the reset', () => {
    const sessionId = db.createSession('H26', '{}');
    ingestionMod.ingestion.startRecording(sessionId, new Map());

    recordingMod.abortRecording();
    db.resetKiosk();
    source.emitReading('sensors/x', '1.5');

    // Still ingesting: the live view and the wizard's topic list keep working.
    expect(db.getObservedTopics(0).map((t) => t.topic)).toEqual(['sensors/x']);
  });

  it('records nothing into the deleted session', () => {
    const sessionId = db.createSession('H26', '{}');
    ingestionMod.ingestion.startRecording(sessionId, new Map());

    recordingMod.abortRecording();
    db.resetKiosk();
    source.emitReading('sensors/x', '1.5');

    expect(db.getSessions()).toHaveLength(0);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0, clipped: 0 });
  });
});
