import { describe, it, expect } from 'vitest';
import { drilledDepth, type DepthSample } from './depth-timestamp.js';

/** A descent at one sample per second, 0.5 m per sample, starting at t0. */
function descent(t0: number, from: number, to: number, step = 0.5): DepthSample[] {
  const out: DepthSample[] = [];
  let i = 0;
  for (let d = from; d <= to + 1e-9; d += step) {
    out.push({ receivedAt: t0 + i * 1000, depth: Math.round(d * 1e6) / 1e6 });
    i++;
  }
  return out;
}

const T0 = 1_700_000_000_000;

describe('drilledDepth', () => {
  it('measures the span the hole covered', () => {
    expect(drilledDepth(descent(T0, 1, 6))).toBe(5);
  });

  it('is zero for a session that never moved', () => {
    expect(drilledDepth([{ receivedAt: T0, depth: 3 }])).toBe(0);
  });

  it('is zero when nothing was recorded', () => {
    expect(drilledDepth([])).toBe(0);
  });

  it('ignores non-finite readings', () => {
    expect(drilledDepth([
      { receivedAt: T0, depth: 0 },
      { receivedAt: T0 + 1, depth: NaN },
      { receivedAt: T0 + 2, depth: 4 },
    ])).toBe(4);
  });
});
