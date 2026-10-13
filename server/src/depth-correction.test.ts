import { describe, it, expect } from 'vitest';
import {
  applyClampPressure,
  applyDepthCorrection,
  initialDrillState,
  observeDepth,
  parseDrillState,
  DEFAULT_SETTINGS,
  MAX_DEPTH_CORRECTION_M,
  type DrillState,
  type RohrwechselSettings,
} from './rohrwechsel.js';

/**
 * Manual depth correction — the measuring wheel slips, the worker fixes it.
 *
 * The thing worth testing here is not the arithmetic but what the correction
 * has to survive: a Rohrwechsel afterwards (which rebuilds the offset from
 * `holeDepth` and would otherwise restore the uncorrected one), the per-pipe
 * plausibility check, and a kiosk restart.
 */

const absolut: RohrwechselSettings = { ...DEFAULT_SETTINGS, depthMode: 'absolut' };
const inkrementell: RohrwechselSettings = { ...absolut, depthMode: 'inkrementell' };

function seen(state: DrillState, raw: number, s = absolut): DrillState {
  return observeDepth(state, raw, s).state;
}
function reads(state: DrillState, raw: number, s = absolut): number | null {
  return observeDepth(state, raw, s).depth;
}
function clamp(state: DrillState, pressure: number, s = absolut): DrillState {
  return applyClampPressure(state, pressure, s, 0).state;
}
/** Clamp has been seen open once, which is what arms the state machine. */
function armed(): DrillState {
  return clamp(initialDrillState(), 3);
}
function correct(state: DrillState, delta: number): DrillState {
  const result = applyDepthCorrection(state, delta);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.applied.state;
}

describe('applyDepthCorrection', () => {
  it('shifts the depth the rig reports from then on', () => {
    const s = correct(seen(armed(), 23.7), -2.3);

    expect(s.lastDepth).toBe(21.4);
    // The rig keeps publishing what it always did; the kiosk moves it.
    expect(reads(s, 23.8)).toBe(21.5);
  });

  it('reports what it did, for the comment and the screen', () => {
    const result = applyDepthCorrection(seen(armed(), 23.7), -2.3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.applied.from).toBe(23.7);
    expect(result.applied.to).toBe(21.4);
    expect(result.applied.delta).toBe(-2.3);
    expect(result.applied.total).toBe(-2.3);
  });

  it('accumulates, because slip comes back', () => {
    let s = correct(seen(armed(), 10), -0.4);
    s = correct(seen(s, 20), -0.5);

    expect(s.manualCorrection).toBe(-0.9);
    expect(reads(s, 30)).toBe(29.1);
  });

  it('moves the hole depth with it', () => {
    // Without this the next reading is below `holeDepth` and `accumulateDepth`'s
    // max() would keep the uncorrected depth of the hole.
    const s = correct(seen(armed(), 23.7), -2.3);
    expect(s.holeDepth).toBe(21.4);
  });

  it('survives the next Rohrwechsel', () => {
    // The rebuild takes `holeDepth - lastRaw`. If the correction had not moved
    // `holeDepth`, this is where it would silently come back.
    let s = seen(armed(), 6.0, inkrementell);
    s = correct(s, -1.5);
    expect(s.lastDepth).toBe(4.5);

    s = clamp(s, 180, inkrementell);              // Klemmbacke closes
    s = seen(s, 1.4, inkrementell);               // drive travelling back up
    s = seen(s, 0.05, inkrementell);              // ...at the top of the mast
    s = clamp(s, 3, inkrementell);                // new pipe in, drilling on

    // Carriage back at the top, bit still at 4,5 m.
    expect(reads(s, 0.05, inkrementell)).toBeCloseTo(4.5, 3);
    expect(reads(s, 1.05, inkrementell)).toBeCloseTo(5.5, 3);
  });

  it('does not make the next Rohrwechsel look implausible', () => {
    // `depthAtLastChange` is the per-pipe baseline. Left behind, the correction
    // itself would be measured as drilling progress and warn about a pipe that
    // was fine.
    let s = seen(armed(), 2.0);
    s = clamp(s, 180);                 // first change, at 2 m
    s = clamp(s, 3);
    s = correct(seen(s, 3.0), -0.8);   // creep noticed and corrected
    s = seen(s, 4.0);                  // 2 m of pipe drilled since the change
    s = clamp(s, 180);

    expect(s.warning).toBeNull();
  });

  it('applies on an absolute rig too', () => {
    // `offset` used to be documented as always 0 here. A slipping wheel is not
    // the retrofit's problem alone.
    const s = correct(seen(armed(), 12.0, absolut), 0.6);
    expect(reads(s, 12.5, absolut)).toBe(13.1);
  });

  it('survives a restart', () => {
    const s = correct(seen(armed(), 23.7), -2.3);
    const restored = parseDrillState(JSON.stringify(s));

    expect(restored?.manualCorrection).toBe(-2.3);
    expect(reads(restored as DrillState, 23.8)).toBe(21.5);
  });

  it('reads a state saved before corrections existed as uncorrected', () => {
    const { manualCorrection: _gone, ...legacy } = initialDrillState();
    const restored = parseDrillState(JSON.stringify({ ...legacy, lastDepth: 4 }));
    expect(restored?.manualCorrection).toBe(0);
  });

  it('rounds to centimetres', () => {
    // 0,1 + 0,2 is 0.30000000000000004, and the worker taps these one at a time.
    let s = seen(armed(), 5);
    s = correct(s, 0.1);
    s = correct(s, 0.2);
    expect(s.manualCorrection).toBe(0.3);
    expect(s.lastDepth).toBe(5.3);
  });

  it('refuses before any depth has arrived', () => {
    // Nothing to correct, and the screen would be showing a 0 that is not a
    // measurement. The message says where to look.
    const result = applyDepthCorrection(armed(), -2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('state');
    expect(result.error).toContain('kein Tiefenmesswert');
  });

  it('refuses a depth above the ground', () => {
    const result = applyDepthCorrection(seen(armed(), 2.0), -3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('input');
    expect(result.error).toContain('über dem Boden');
  });

  it('refuses a runaway correction, and says it can be split', () => {
    const result = applyDepthCorrection(seen(armed(), 20), MAX_DEPTH_CORRECTION_M + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('input');
    expect(result.error).toContain('zwei Schritten');
  });

  it('refuses nothing at all', () => {
    const result = applyDepthCorrection(seen(armed(), 20), 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('input');
  });

  it('refuses a value that is not a number', () => {
    const result = applyDepthCorrection(seen(armed(), 20), Number.NaN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('input');
  });

  it('leaves the state alone when it refuses', () => {
    const before = seen(armed(), 2.0);
    applyDepthCorrection(before, -3);
    expect(before.lastDepth).toBe(2.0);
    expect(before.manualCorrection).toBe(0);
  });
});
