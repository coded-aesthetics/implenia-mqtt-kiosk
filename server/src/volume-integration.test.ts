import { describe, it, expect } from 'vitest';
import { VolumeTracker, type CumulativeVolumeMapping } from './volume-integration.js';

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
