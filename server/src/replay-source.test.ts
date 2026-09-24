import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'test-fixtures');

/**
 * Safety: replay tests exercise the full pipeline, which writes to SQLite.
 * They must only ever run against :memory:. This is the same guard the
 * replay-field-data tests use.
 */
beforeAll(() => {
  expect(databasePath()).toBe(':memory:');
});

// Dynamic imports so DB_PATH from vitest.config.ts is in effect before db.ts loads.
let ReplaySource: typeof import('./replay-source.js').ReplaySource;
let parseDump: typeof import('./mqtt-dump.js').parseDump;

beforeAll(async () => {
  const replayMod = await import('./replay-source.js');
  ReplaySource = replayMod.ReplaySource;
  const dumpMod = await import('./mqtt-dump.js');
  parseDump = dumpMod.parseDump;
});

describe('ReplaySource', () => {
  const FIXTURE = path.join(FIXTURES, 'g8-bohren-verpressen.txt');

  it('loads a fixture and reports correct stats', () => {
    const source = new ReplaySource();
    const result = source.load(FIXTURE);

    expect(result.messages).toBeGreaterThan(100);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(source.connected).toBe(true);
    expect(source.sourceType).toBe('replay');
  });

  it('emits readings with correct topic and payload', async () => {
    const source = new ReplaySource();
    source.load(FIXTURE);

    const readings: { topic: string; payload: string; receivedAt: number }[] = [];
    source.on('reading', (r) => readings.push(r));

    // Fast-forward a small window — first 1000ms of the dump
    source.fastForwardTo(1000);

    expect(readings.length).toBeGreaterThan(0);
    // Topics should match what the fixture contains
    const topics = new Set(readings.map((r) => r.topic));
    expect(topics.size).toBeGreaterThan(0);
    // Every reading must have a receivedAt
    for (const r of readings) {
      expect(r.receivedAt).toBeGreaterThan(0);
    }
  });

  it('state reflects position after fast-forward', () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.fastForwardTo(5000);

    const state = source.state;
    expect(state.position).toBeGreaterThan(0);
    expect(state.currentOffsetMs).toBeLessThanOrEqual(5000);
    expect(state.playing).toBe(false);
    expect(state.fastForwarding).toBe(false);
  });

  it('reset returns to position 0', () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.fastForwardTo(5000);
    expect(source.state.position).toBeGreaterThan(0);

    source.reset();
    expect(source.state.position).toBe(0);
    expect(source.state.currentOffsetMs).toBe(0);
  });

  it('emits fast-forward-start and fast-forward-end events', () => {
    const source = new ReplaySource();
    source.load(FIXTURE);

    const events: string[] = [];
    source.on('fast-forward-start', () => events.push('start'));
    source.on('fast-forward-end', () => events.push('end'));

    source.fastForwardTo(1000);

    expect(events).toEqual(['start', 'end']);
  });

  it('speed defaults to 1 and can be changed', () => {
    const source = new ReplaySource();
    expect(source.speed).toBe(1);

    source.setSpeed(60);
    expect(source.speed).toBe(60);

    source.setSpeed('max');
    expect(source.speed).toBe('max');
  });

  it('timed playback emits readings with delay', async () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.setSpeed(1);

    const readings: unknown[] = [];
    source.on('reading', (r) => readings.push(r));

    source.start();
    expect(source.state.playing).toBe(true);

    // Wait a short time — at 1x speed, only messages within the first ~50ms
    // of the dump should have been emitted
    await new Promise((resolve) => setTimeout(resolve, 80));
    source.pause();

    // We should have some readings but not all
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.length).toBeLessThan(source.state.totalMessages);
  });

  it('max speed emits all readings', async () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.setSpeed('max');

    const readings: unknown[] = [];
    source.on('reading', (r) => readings.push(r));

    source.start();

    // Wait for the event loop to drain — max speed uses setTimeout(0)
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(readings.length).toBe(source.state.totalMessages);
    expect(source.state.playing).toBe(false);
  });

  it('emits finished event when all messages played', async () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.setSpeed('max');

    const finished = new Promise<void>((resolve) => {
      source.on('finished', resolve);
    });

    source.start();
    await finished;

    expect(source.state.position).toBe(source.state.totalMessages);
  });

  it('pause stops playback and preserves position', async () => {
    const source = new ReplaySource();
    source.load(FIXTURE);
    source.setSpeed(10);

    source.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    source.pause();

    const posAfterPause = source.state.position;
    expect(posAfterPause).toBeGreaterThan(0);
    expect(source.state.playing).toBe(false);

    // Position should not change after pause
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(source.state.position).toBe(posAfterPause);
  });

  it('readings carry timestamps based on dump offsets, not wall clock', () => {
    const source = new ReplaySource();
    source.load(FIXTURE);

    const readings: { receivedAt: number }[] = [];
    source.on('reading', (r) => readings.push(r));

    source.fastForwardTo(2000);

    // All timestamps should be near the REPLAY_EPOCH (2026-01-01), not now
    const now = Date.now();
    for (const r of readings) {
      expect(r.receivedAt).toBeLessThan(now - 86_400_000); // At least a day before now
    }

    // Timestamps should be monotonically non-decreasing
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i].receivedAt).toBeGreaterThanOrEqual(readings[i - 1].receivedAt);
    }
  });
});

describe('ReplaySource through ingestion pipeline', () => {
  /**
   * Verify that replay readings actually land in session_readings via the
   * real ingestion path — not a mock. This is the integration test that
   * proves the replay source exercises the same code path as live data.
   */
  it('replayed readings are persisted with dump timestamps', async () => {
    const { ReplaySource } = await import('./replay-source.js');
    const { DataIngestion } = await import('./ingestion.js');
    const db = await import('./db.js');
    const { mqttSource } = await import('./mqtt.js');

    const source = new ReplaySource();
    const fixture = path.join(FIXTURES, 'g8-bohren-verpressen.txt');
    source.load(fixture);

    // Create a fresh ingestion wired to the replay source
    const ingestion = new DataIngestion(source);

    // Start a recording session
    const sessionId = db.createSession('replay-test', JSON.stringify({}));
    ingestion.startRecording(sessionId, new Map());
    ingestion.start();

    // Replay the first 2 seconds
    source.fastForwardTo(2000);

    ingestion.stop();
    ingestion.stopRecording();

    // Verify readings landed in the database
    const count = db.getSessionReadingCount(sessionId);
    expect(count).toBeGreaterThan(0);

    // Verify timestamps are from the replay epoch, not wall clock
    const readings = db.getAllSessionReadings(sessionId);
    const now = Date.now();
    for (const r of readings) {
      expect(r.receivedAt).toBeLessThan(now - 86_400_000);
    }
  });
});
