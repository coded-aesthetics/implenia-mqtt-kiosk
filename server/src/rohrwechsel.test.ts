import { describe, it, expect } from 'vitest';
import {
  applyClampPressure,
  initialDrillState,
  isClipped,
  isDepthMode,
  observeDepth,
  parseDrillState,
  toStatus,
  DEFAULT_SETTINGS,
  type DrillState,
  type RohrwechselSettings,
} from './rohrwechsel.js';

/** A rig whose depth comes from the manufacturer over CAN. */
const absolut: RohrwechselSettings = {
  ...DEFAULT_SETTINGS, depthMode: 'absolut', pipeLength: 2, tolerance: 0.3,
};
/** A rig Implenia retrofitted, publishing the Schlittenweg. */
const inkrementell: RohrwechselSettings = { ...absolut, depthMode: 'inkrementell' };

function clamp(state: DrillState, pressure: number, s = absolut, now = 0): DrillState {
  return applyClampPressure(state, pressure, s, now).state;
}
function seen(state: DrillState, raw: number, s = absolut): DrillState {
  return observeDepth(state, raw, s).state;
}
function reads(state: DrillState, raw: number, s = absolut): number | null {
  return observeDepth(state, raw, s).depth;
}

/** Clamp closes, pipe goes on, clamp opens. */
function change(state: DrillState, s = absolut, carriageAtTop = 0.05): DrillState {
  let st = clamp(state, 180, s);
  if (s.depthMode === 'inkrementell') {
    st = seen(st, 1.4, s);            // drive on its way up, still clamped
    st = seen(st, carriageAtTop, s);
  }
  return clamp(st, 3, s);
}

describe('rohrwechsel phase detection', () => {
  it('starts out drilling, with nothing clipped', () => {
    const s = initialDrillState();
    expect(s.phase).toBe('bohren');
    expect(isClipped(s)).toBe(false);
    expect(s.pipeCount).toBe(1);
  });

  it('clips everything between the Klemmbacke closing and opening', () => {
    let s = seen(initialDrillState(), 2.0);

    s = clamp(s, 180);
    expect(isClipped(s)).toBe(true);
    s = seen(s, 2.0);
    expect(isClipped(s)).toBe(true);

    s = clamp(s, 3);
    expect(isClipped(s)).toBe(false);
  });

  it('counts a pipe once the change completes, not when it starts', () => {
    let s = seen(initialDrillState(), 2.0);
    s = clamp(s, 180);
    expect(s.pipeCount).toBe(1);
    s = clamp(s, 3);
    expect(s.pipeCount).toBe(2);
  });

  it('does not flap between phases on sensor noise', () => {
    let s = seen(initialDrillState(), 1.0);

    s = clamp(s, 75);          // inside the dead band
    expect(s.phase).toBe('bohren');
    s = clamp(s, 180);
    expect(s.phase).toBe('rohrwechsel');
    s = clamp(s, 75);          // still inside it
    expect(s.phase).toBe('rohrwechsel');
  });

  it('ignores unparseable readings', () => {
    const drilling = seen(initialDrillState(), 2.0);
    expect(reads(drilling, NaN)).toBe(2.0);
    expect(clamp(drilling, NaN).phase).toBe('bohren');
  });
});

describe('a rig that reports an absolute depth', () => {
  it('records the depth exactly as the rig sent it', () => {
    let s = seen(initialDrillState(), 2.0);
    expect(reads(s, 2.0)).toBe(2.0);

    // The bit does not move while the string is clamped, so neither does the
    // value — there is nothing to correct and nothing to freeze.
    s = clamp(s, 180);
    expect(reads(s, 2.0)).toBe(2.0);

    s = clamp(s, 3);
    expect(reads(s, 3.97)).toBe(3.97);
    expect(s.offset).toBe(0);
  });
});

describe('a retrofitted rig that reports the Schlittenweg', () => {
  it('holds the depth while the drive travels back up the mast', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);

    s = clamp(s, 180, inkrementell);
    // The carriage is running backwards; the hole is not getting shallower.
    expect(reads(s, 1.2, inkrementell)).toBe(2.0);
    s = seen(s, 1.2, inkrementell);
    expect(reads(s, 0.05, inkrementell)).toBe(2.0);
  });

  it('keeps the depth continuous across a Rohrwechsel', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);
    s = change(s, inkrementell);

    expect(s.pipeCount).toBe(2);
    expect(s.warning).toBeNull();
    // Back at the top of the mast, the bit is still at the bottom of the hole.
    expect(reads(s, 0.05, inkrementell)).toBeCloseTo(2.0, 6);
    // ...and the next pipe continues from there, not from zero.
    expect(reads(s, 2.0, inkrementell)).toBeCloseTo(3.95, 6);
  });

  it('accumulates the offset over several pipes', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);

    expect(s.pipeCount).toBe(3);
    expect(reads(s, 2.0, inkrementell)).toBeCloseTo(5.9, 6);
    expect(s.warning).toBeNull();
  });

  it('resumes from the deepest point reached, not the last reading', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);
    // A short lift before clamping. The hole is still 2.00 m deep and the bit
    // drops back onto its bottom when drilling resumes.
    s = seen(s, 1.9, inkrementell);
    s = change(s, inkrementell);

    expect(reads(s, 0.05, inkrementell)).toBeCloseTo(2.0, 6);
  });

  it('refuses to invent an offset when nothing was added', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);

    // The clamp cycled but the carriage never went back up — this is not a
    // Rohrverlängerung. Pulling the string out looks like this.
    let after = clamp(s, 180, inkrementell);
    after = seen(after, 2.0, inkrementell);
    after = clamp(after, 3, inkrementell);

    expect(after.offset).toBe(0);
    expect(after.pipeCount).toBe(1);
    expect(after.implausibleChanges).toBe(1);
    expect(after.warning).toContain('kein neues Bohrrohr');
  });
});

describe('calibration is somebody else\'s job', () => {
  // Scaling a reading into the unit it should be in belongs to the calibration
  // layer (see calibration.ts), which runs before this one. The state machine
  // only ever sees values that are already in metres — one place that converts
  // units, not two.
  it('suggests the correction when every pipe comes out wrong', () => {
    // A rig reading twice the truth: the kiosk sees 4 m per 2 m pipe and works
    // out that the factor needs halving.
    let s = seen(initialDrillState(), 4.0);
    s = change(s);
    s = seen(s, 8.0);
    s = change(s);

    expect(s.warning).toContain('Kalibrierung');
    expect(s.warning).toContain('0,500');
    expect(s.warning).toContain('4,00 m');
  });
});

describe('per-pipe plausibility check', () => {
  it('says nothing about the first Rohrwechsel', () => {
    // No baseline yet: recording may have started with pipes already in the
    // ground, and a warning about that would be noise.
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(0);
  });

  it('accepts a pipe length of drilling between two changes', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    s = seen(s, 4.0);
    s = change(s);

    expect(s.warning).toBeNull();
    expect(s.pipeCount).toBe(3);
  });

  it('works the same on a retrofitted rig', () => {
    // The check runs on the corrected depth, so one code path covers both
    // kinds of rig.
    let s = seen(initialDrillState(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);
    s = change(s, inkrementell);

    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(0);
  });

  it('flags a Rohrwechsel with no drilling in between', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    s = change(s);  // straight into a second change

    expect(s.implausibleChanges).toBe(1);
    expect(s.warning).toContain('ohne Bohrfortschritt');
    expect(s.warning).toContain('Rohrverlängerung');
  });

  it('flags a gap that is longer than a pipe', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    s = seen(s, 5.5);
    s = change(s);

    expect(s.implausibleChanges).toBe(1);
    expect(s.warning).toContain('3,50 m');
    expect(s.warning).toContain('2,00 m');
  });

  it('catches a rig configured with the wrong depth mode', () => {
    // A Schlittenweg read as an absolute depth: the value runs backwards at
    // every change, so the depth "drilled" between two of them is nonsense.
    // This is what makes a wrong setting announce itself within one pipe.
    let s = seen(initialDrillState(), 7.4);
    s = change(s);
    s = seen(s, 0.3);
    s = change(s);

    expect(s.warning).toContain('ohne Bohrfortschritt');
  });

  it('clears the warning once a plausible change follows a bad one', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    s = change(s);
    expect(s.warning).not.toBeNull();

    s = seen(s, 4.0);
    s = change(s);
    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(1);
  });

  it('stays quiet within the tolerance', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);
    s = seen(s, 4.25);  // 2.25 m — inside the 0.3 m tolerance
    s = change(s);
    expect(s.warning).toBeNull();
  });
});

describe('drill state persistence', () => {
  it('round-trips through JSON', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 1.5, inkrementell);
    expect(parseDrillState(JSON.stringify(s))).toEqual(s);
  });

  it('keeps the offset when a restart happens mid-Rohrwechsel', () => {
    let s = seen(initialDrillState(), 2.0, inkrementell);
    s = clamp(s, 180, inkrementell);

    const restored = parseDrillState(JSON.stringify(s))!;
    expect(restored.phase).toBe('rohrwechsel');
    expect(isClipped(restored)).toBe(true);
    expect(restored.holeDepth).toBe(2.0);
    // Without this the next pipe would be drilled on top of a hole the kiosk
    // had forgotten about.
    expect(reads(restored, 0.05, inkrementell)).toBe(2.0);
  });

  it('rejects unusable persisted state rather than guessing', () => {
    expect(parseDrillState(null)).toBeNull();
    expect(parseDrillState('')).toBeNull();
    expect(parseDrillState('not json')).toBeNull();
    expect(parseDrillState('[]')).toBeNull();
    expect(parseDrillState('{"phase":"unbekannt","pipeCount":1}')).toBeNull();
    expect(parseDrillState('{"phase":"bohren"}')).toBeNull();
  });
});

describe('depth mode', () => {
  it('accepts only the two kinds of rig that exist', () => {
    expect(isDepthMode('absolut')).toBe(true);
    expect(isDepthMode('inkrementell')).toBe(true);
    expect(isDepthMode('geschaetzt')).toBe(false);
  });
});

describe('status projection', () => {
  it('exposes what the screen needs and nothing more', () => {
    let s = seen(initialDrillState(), 2.0);
    s = change(s);

    expect(toStatus(s)).toEqual({
      phase: 'bohren',
      pipeCount: 2,
      offset: 0,
      warning: null,
      implausibleChanges: 0,
      phaseSince: 0,
    });
  });
});
