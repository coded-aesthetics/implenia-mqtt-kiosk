import { describe, it, expect } from 'vitest';
import {
  VolumeTracker,
  baselinesFromSession,
  type CumulativeVolumeMapping,
} from './volume-integration.js';
import { createSession, insertSessionReading } from './db.js';

const MAPPINGS: CumulativeVolumeMapping[] = [
  { cumulativeKey: 'q_verpressen', syntheticTopic: 'Q_verpressen' },
  { cumulativeKey: 'q_bohren', syntheticTopic: 'Q_Bohren' },
];

function makeTracker() {
  return new VolumeTracker(MAPPINGS);
}

describe('VolumeTracker', () => {
  it('returns null for unmapped sensors', () => {
    const vt = makeTracker();
    expect(vt.observe('drehzahl', 100)).toBeNull();
  });

  it('returns zero on first reading (baseline)', () => {
    const vt = makeTracker();
    const r = vt.observe('q_verpressen', 98);
    expect(r).toEqual({ topic: 'Q_verpressen', volume: 0 });
  });

  it('computes delta from baseline', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 98);
    const r = vt.observe('q_verpressen', 1168);
    expect(r).toEqual({ topic: 'Q_verpressen', volume: 1070 });
  });

  it('tracks increasing volume', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 100);
    expect(vt.observe('q_verpressen', 200)!.volume).toBe(100);
    expect(vt.observe('q_verpressen', 350)!.volume).toBe(250);
    expect(vt.observe('q_verpressen', 500)!.volume).toBe(400);
  });

  it('handles decreasing cumulative (PLC reset)', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 1000);
    const r = vt.observe('q_verpressen', 50);
    expect(r!.volume).toBe(-950);
  });

  it('tracks multiple volume sensors independently', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 100);
    vt.observe('q_bohren', 200);

    expect(vt.observe('q_verpressen', 600)!.volume).toBe(500);
    expect(vt.observe('q_bohren', 350)!.volume).toBe(150);
  });

  it('resets all baselines', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 100);
    vt.observe('q_verpressen', 500);
    vt.reset();

    const r = vt.observe('q_verpressen', 500);
    expect(r!.volume).toBe(0);
  });

  it('ignores NaN and Infinity', () => {
    const vt = makeTracker();
    expect(vt.observe('q_verpressen', NaN)).toBeNull();
    expect(vt.observe('q_verpressen', Infinity)).toBeNull();
    expect(vt.observe('q_verpressen', -Infinity)).toBeNull();
  });

  it('does not update baseline with non-finite values', () => {
    const vt = makeTracker();
    vt.observe('q_verpressen', 100);
    vt.observe('q_verpressen', NaN);
    expect(vt.observe('q_verpressen', 200)!.volume).toBe(100);
  });
});

/**
 * What a restart mid-element has to recover.
 *
 * The tracker's baselines live in memory, so a resumed session gets them back
 * out of the readings it already holds — the rig's cumulative total, recorded
 * correctly throughout. Without this the worker's slurry volume restarts at
 * zero halfway up a pillar.
 */
describe('baselinesFromSession', () => {
  const sensorMap = new Map([
    ['q_verpressen', { sensorId: 'sensor-v' }],
    ['q_bohren', { sensorId: 'sensor-b' }],
  ]);

  it('is empty for a session that has recorded nothing', () => {
    const id = createSession('P-01', '{}');
    expect(baselinesFromSession(id, sensorMap, MAPPINGS).size).toBe(0);
  });

  it('recovers the first recorded value per sensor', () => {
    const id = createSession('P-02', '{}');
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 98, null, { receivedAt: 1000 });
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 1168, null, { receivedAt: 2000 });
    insertSessionReading(id, 'rig/qb', 'sensor-b', 'float', 200, null, { receivedAt: 1500 });

    expect(baselinesFromSession(id, sensorMap, MAPPINGS)).toEqual(
      new Map([['q_verpressen', 98], ['q_bohren', 200]]),
    );
  });

  it('continues the original delta rather than restarting it', () => {
    const id = createSession('P-03', '{}');
    // Before the restart: baseline 98, so the screen last showed 1070 l.
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 98, null, { receivedAt: 1000 });
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 1168, null, { receivedAt: 2000 });

    const resumed = new VolumeTracker(MAPPINGS, baselinesFromSession(id, sensorMap, MAPPINGS));
    expect(resumed.observe('q_verpressen', 1168)!.volume).toBe(1070);
    expect(resumed.observe('q_verpressen', 1200)!.volume).toBe(1102);
  });

  it('takes a clipped first reading, as the live tracker would have', () => {
    const id = createSession('P-04', '{}');
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 500, null,
      { receivedAt: 1000, clipped: true });
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 600, null, { receivedAt: 2000 });

    expect(baselinesFromSession(id, sensorMap, MAPPINGS).get('q_verpressen')).toBe(500);
  });

  it('skips a reading with no numeric value', () => {
    const id = createSession('P-05', '{}');
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', null, 'nan', { receivedAt: 1000 });
    insertSessionReading(id, 'rig/qv', 'sensor-v', 'float', 300, null, { receivedAt: 2000 });

    expect(baselinesFromSession(id, sensorMap, MAPPINGS).get('q_verpressen')).toBe(300);
  });

  it('skips a cumulative sensor the session map does not cover', () => {
    const id = createSession('P-06', '{}');
    insertSessionReading(id, 'rig/qv', null, null, 98, null, { receivedAt: 1000 });
    expect(baselinesFromSession(id, new Map(), MAPPINGS).size).toBe(0);
  });
});
