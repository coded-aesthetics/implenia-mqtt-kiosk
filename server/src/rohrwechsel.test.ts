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
  THRESHOLD_WARNING,
  THRESHOLD_WARNING_AFTER_MS,
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

/**
 * A rig that has been drilling for a moment: the Klemmbacke has been seen
 * *open*, which is what arms the clipping. On a real rig that is the normal
 * state at the start — the clamp is open while the bit turns — and nothing is
 * ever clipped before it has been observed once, so the tests start there too.
 */
function armed(): DrillState {
  return clamp(initialDrillState(), 3);
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
    let s = seen(armed(), 2.0);

    s = clamp(s, 180);
    expect(isClipped(s)).toBe(true);
    s = seen(s, 2.0);
    expect(isClipped(s)).toBe(true);

    s = clamp(s, 3);
    expect(isClipped(s)).toBe(false);
  });

  it('counts a pipe once the change completes, not when it starts', () => {
    let s = seen(armed(), 2.0);
    s = clamp(s, 180);
    expect(s.pipeCount).toBe(1);
    s = clamp(s, 3);
    expect(s.pipeCount).toBe(2);
  });

  it('does not flap between phases on sensor noise', () => {
    let s = seen(armed(), 1.0);

    s = clamp(s, 75);          // inside the dead band
    expect(s.phase).toBe('bohren');
    s = clamp(s, 180);
    expect(s.phase).toBe('rohrwechsel');
    s = clamp(s, 75);          // still inside it
    expect(s.phase).toBe('rohrwechsel');
  });

  it('ignores unparseable readings', () => {
    const drilling = seen(armed(), 2.0);
    expect(reads(drilling, NaN)).toBe(2.0);
    expect(clamp(drilling, NaN).phase).toBe('bohren');
  });
});

describe('thresholds that do not fit the rig', () => {
  // The defaults are 100 / 50 and read like bar. The one rig anybody has
  // captured publishes its Klemmdruck between 1609 and 5558 — against those
  // defaults every single reading counts as "closed". Without an arming
  // condition the first message would start a Rohrwechsel that never ends,
  // and the whole shift would be held back from the upload *and* from the
  // exported file. See assets/reference/README.md.
  it('clips nothing until the Klemmbacke has been seen open', () => {
    let s = initialDrillState();
    for (const p of [4200, 4180, 5558, 3900, 4100]) {
      s = clamp(s, p);
    }
    expect(s.phase).toBe('bohren');
    expect(isClipped(s)).toBe(false);
    expect(s.pipeCount).toBe(1);
  });

  it('says so, instead of silently recording everything', () => {
    let s = clamp(initialDrillState(), 4200, absolut, 0);
    expect(s.warning).toBeNull();          // could still be a change in progress

    s = clamp(s, 4200, absolut, THRESHOLD_WARNING_AFTER_MS);
    expect(s.warning).toBe(THRESHOLD_WARNING);
    // The worker has to know the recording is intact, not just that something
    // is wrong — there is nothing for them to rescue.
    expect(s.warning).toContain('nichts ausgeblendet');
    expect(s.warningSince).toBe(THRESHOLD_WARNING_AFTER_MS);
  });

  it('arms as soon as one open reading arrives, and clips from then on', () => {
    let s = clamp(initialDrillState(), 4200);
    s = clamp(s, 20);                      // thresholds fixed, clamp opens
    expect(s.clampSeenOpen).toBe(true);
    s = clamp(s, 180);
    expect(isClipped(s)).toBe(true);
  });
});

describe('while the rig is grouting, not drilling', () => {
  // During Verpressen the Klemmbacke holds the pipe string steady — 81% of
  // that phase on the G08 capture. Nothing is clipped then, so anything the
  // state machine does to a reading is uploaded as it stands.
  const verpressen = (st: DrillState, p: number, s = absolut, now = 0) =>
    applyClampPressure(st, p, s, now, false).state;

  it('does not count a Bohrrohr that was never added', () => {
    let s = armed();
    s = verpressen(s, 180);
    s = verpressen(s, 3);
    expect(s.pipeCount).toBe(1);
    expect(s.implausibleChanges).toBe(0);
    expect(s.warning).toBeNull();
  });

  it('keeps reporting the depth while the string is pulled', () => {
    // The carriage travels up as pipe comes out, so the depth genuinely
    // changes with the clamp closed. Freezing it at the hole bottom would
    // upload a flat line for the whole grouting phase.
    let s = seen(armed(), 12.0, inkrementell);
    s = verpressen(s, 180, inkrementell);
    expect(observeDepth(s, 9.5, inkrementell, false).depth).toBe(9.5);
  });

  it('does not walk the offset up on every clamp cycle', () => {
    let s = seen(armed(), 12.0, inkrementell);
    for (let i = 0; i < 5; i++) {
      s = verpressen(s, 180, inkrementell);
      s = observeDepth(s, 11 - i, inkrementell, false).state;
      s = verpressen(s, 3, inkrementell);
    }
    expect(s.offset).toBe(0);
    expect(s.pipeCount).toBe(1);
  });

  it('does not check a pipe length against a grouting phase', () => {
    // The baseline is dropped rather than carried: measuring the "pipe" either
    // side of Verpressen would report a Rohrwechsel as implausible for no
    // reason the worker can act on.
    let s = seen(armed(), 12.0);
    s = verpressen(s, 180);
    expect(s.depthAtLastChange).toBeNull();
  });
});

describe('a rig that reports an absolute depth', () => {
  it('records the depth exactly as the rig sent it', () => {
    let s = seen(armed(), 2.0);
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
    let s = seen(armed(), 2.0, inkrementell);

    s = clamp(s, 180, inkrementell);
    // The carriage is running backwards; the hole is not getting shallower.
    expect(reads(s, 1.2, inkrementell)).toBe(2.0);
    s = seen(s, 1.2, inkrementell);
    expect(reads(s, 0.05, inkrementell)).toBe(2.0);
  });

  it('keeps the depth continuous across a Rohrwechsel', () => {
    let s = seen(armed(), 2.0, inkrementell);
    s = change(s, inkrementell);

    expect(s.pipeCount).toBe(2);
    expect(s.warning).toBeNull();
    // Back at the top of the mast, the bit is still at the bottom of the hole.
    expect(reads(s, 0.05, inkrementell)).toBeCloseTo(2.0, 6);
    // ...and the next pipe continues from there, not from zero.
    expect(reads(s, 2.0, inkrementell)).toBeCloseTo(3.95, 6);
  });

  it('accumulates the offset over several pipes', () => {
    let s = seen(armed(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);

    expect(s.pipeCount).toBe(3);
    expect(reads(s, 2.0, inkrementell)).toBeCloseTo(5.9, 6);
    expect(s.warning).toBeNull();
  });

  it('resumes from the deepest point reached, not the last reading', () => {
    let s = seen(armed(), 2.0, inkrementell);
    // A short lift before clamping. The hole is still 2.00 m deep and the bit
    // drops back onto its bottom when drilling resumes.
    s = seen(s, 1.9, inkrementell);
    s = change(s, inkrementell);

    expect(reads(s, 0.05, inkrementell)).toBeCloseTo(2.0, 6);
  });

  it('refuses to invent an offset when nothing was added', () => {
    let s = seen(armed(), 2.0, inkrementell);

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
    let s = seen(armed(), 4.0);
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
    let s = seen(armed(), 2.0);
    s = change(s);
    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(0);
  });

  it('accepts a pipe length of drilling between two changes', () => {
    let s = seen(armed(), 2.0);
    s = change(s);
    s = seen(s, 4.0);
    s = change(s);

    expect(s.warning).toBeNull();
    expect(s.pipeCount).toBe(3);
  });

  it('works the same on a retrofitted rig', () => {
    // The check runs on the corrected depth, so one code path covers both
    // kinds of rig.
    let s = seen(armed(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 2.0, inkrementell);
    s = change(s, inkrementell);

    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(0);
  });

  it('flags a Rohrwechsel with no drilling in between', () => {
    let s = seen(armed(), 2.0);
    s = change(s);
    s = change(s);  // straight into a second change

    expect(s.implausibleChanges).toBe(1);
    expect(s.warning).toContain('ohne Bohrfortschritt');
    expect(s.warning).toContain('Rohrverlängerung');
  });

  it('flags a gap that is longer than a pipe', () => {
    let s = seen(armed(), 2.0);
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
    let s = seen(armed(), 7.4);
    s = change(s);
    s = seen(s, 0.3);
    s = change(s);

    expect(s.warning).toContain('ohne Bohrfortschritt');
  });

  it('clears the warning once a plausible change follows a bad one', () => {
    let s = seen(armed(), 2.0);
    s = change(s);
    s = change(s);
    expect(s.warning).not.toBeNull();

    s = seen(s, 4.0);
    s = change(s);
    expect(s.warning).toBeNull();
    expect(s.implausibleChanges).toBe(1);
  });

  it('stays quiet within the tolerance', () => {
    let s = seen(armed(), 2.0);
    s = change(s);
    s = seen(s, 4.25);  // 2.25 m — inside the 0.3 m tolerance
    s = change(s);
    expect(s.warning).toBeNull();
  });
});

describe('how long a warning stays up', () => {
  it('outlives the Rohrwechsel it describes, with the time it was raised', () => {
    // The worker is handling a Bohrrohr while it is up; going into the
    // settings is something they can only do afterwards. The timestamp is what
    // lets the screen tell a fresh warning from one already tapped away.
    let s = seen(armed(), 2.0);
    s = clamp(s, 180, absolut, 1000);
    s = clamp(s, 3, absolut, 1500);
    s = clamp(s, 180, absolut, 2000);   // nothing drilled since the last change
    expect(s.warning).toContain('ohne Bohrfortschritt');
    expect(s.warningSince).toBe(2000);

    s = clamp(s, 3, absolut, 3000);
    expect(s.warning).toContain('ohne Bohrfortschritt');
    expect(s.warningSince).toBe(2000);   // still the same one, not re-raised
  });
});

describe('drill state persistence', () => {
  it('round-trips through JSON', () => {
    let s = seen(armed(), 2.0, inkrementell);
    s = change(s, inkrementell);
    s = seen(s, 1.5, inkrementell);
    expect(parseDrillState(JSON.stringify(s))).toEqual(s);
  });

  it('keeps the offset when a restart happens mid-Rohrwechsel', () => {
    let s = seen(armed(), 2.0, inkrementell);
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
    let s = seen(armed(), 2.0);
    s = change(s);

    expect(toStatus(s)).toEqual({
      phase: 'bohren',
      pipeCount: 2,
      offset: 0,
      warning: null,
      warningSince: null,
      implausibleChanges: 0,
      phaseSince: 0,
    });
  });
});
