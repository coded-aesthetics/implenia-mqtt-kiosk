import { describe, it, expect } from 'vitest';
import { mergeProfile } from './geology-profile.js';

const SAND = 5;
const SCHLUFF = 9;
const TON = 10;
const BETON = 60;

const VORGABE = {
  schichten: [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 7, nr: TON }],
  endTiefe: 10,
};

/** Compact shape for assertions: "startDepth:nr:provenance" per layer. */
function umriss(p: ReturnType<typeof mergeProfile>): string[] {
  return (p?.schichten ?? []).map((s) => `${s.tiefe}:${s.nr}:${s.quelle[0]}`);
}

describe('mergeProfile', () => {
  it('returns the plan untouched when nothing was observed', () => {
    expect(umriss(mergeProfile(VORGABE, [], 10))).toEqual(['0:5:v', '3:9:v', '7:10:v']);
  });

  it('moves a planned boundary to where it was actually seen', () => {
    // The plan said schluff at 3 m; the operator confirmed it at 2.5 m.
    expect(umriss(mergeProfile(VORGABE, [{ tiefe: 2.5, nr: SCHLUFF }], 10)))
      .toEqual(['0:5:v', '2.5:9:i', '7:10:v']);
  });

  it('leaves the plan in place below the deepest observation', () => {
    const p = mergeProfile(VORGABE, [{ tiefe: 4, nr: SCHLUFF }], 10);
    expect(p?.schichten.find((s) => s.tiefe === 7)?.quelle).toBe('vorgabe');
  });

  it('keeps an observation the plan did not predict', () => {
    expect(umriss(mergeProfile(VORGABE, [{ tiefe: 5, nr: TON }], 10)))
      .toEqual(['0:5:v', '3:9:v', '5:10:i']);
  });

  it('re-types a boundary confirmed at exactly the planned depth', () => {
    expect(umriss(mergeProfile(VORGABE, [{ tiefe: 3, nr: TON }], 10)))
      .toEqual(['0:5:v', '3:10:i', '7:10:v'].filter((x) => x !== '7:10:v'));
  });

  it('records an obstruction as a bounded span with the ground resuming', () => {
    expect(umriss(mergeProfile(VORGABE, [
      { tiefe: 4, nr: BETON }, { tiefe: 4.4, nr: SCHLUFF },
    ], 10))).toEqual(['0:5:v', '3:9:v', '4:60:i', '4.4:9:i', '7:10:v']);
  });

  it('heals the plan when an observation confirms it unchanged', () => {
    // Confirming sand at 1 m must not split the sand layer in two.
    expect(umriss(mergeProfile(VORGABE, [{ tiefe: 1, nr: SAND }], 10)))
      .toEqual(['0:5:v', '3:9:v', '7:10:v']);
  });

  it('applies observations in depth order regardless of input order', () => {
    expect(umriss(mergeProfile(VORGABE, [
      { tiefe: 5, nr: TON }, { tiefe: 2, nr: SCHLUFF },
    ], 10))).toEqual(['0:5:v', '2:9:i', '5:10:i']);
  });

  it('builds a profile from observations alone when there is no plan', () => {
    expect(umriss(mergeProfile(null, [
      { tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON },
    ], 6))).toEqual(['0:5:i', '3:10:i']);
  });

  it('never extends an obstruction up to the top of the hole', () => {
    // Extending concrete upward would assert the drill met it from the surface.
    // The profile starts where the obstruction was actually seen, and the chart
    // draws empty space above it.
    const p = mergeProfile(null, [{ tiefe: 2, nr: BETON }], 6)!;
    expect(umriss(p)).toEqual(['2:60:i']);
  });

  it('still extends soil observed below an obstruction', () => {
    const p = mergeProfile(null, [
      { tiefe: 2, nr: BETON }, { tiefe: 2.4, nr: SAND },
    ], 6)!;
    expect(umriss(p)).toEqual(['2:60:i', '2.4:5:i']);
  });

  it('extends the shallowest observation up to the top of the hole', () => {
    // Nobody confirmed anything above 2 m and there is no plan, but the model
    // has no gaps — so the ground seen at 2 m is assumed up to 0, as an
    // assumption, because nobody saw it there.
    expect(umriss(mergeProfile(null, [{ tiefe: 2, nr: SAND }], 5))).toEqual(['0:5:v']);
  });

  it('extends the profile when the hole went deeper than planned', () => {
    expect(mergeProfile(VORGABE, [], 14)?.endTiefe).toBe(14);
  });

  it('returns null when there is nothing at all to commit', () => {
    expect(mergeProfile(null, [], 6)).toBeNull();
    expect(mergeProfile({ schichten: [], endTiefe: 10 }, [], 6)).toBeNull();
  });

  it('ignores observations with an invalid ground type or depth', () => {
    expect(umriss(mergeProfile(VORGABE, [
      { tiefe: 2, nr: 0 }, { tiefe: 4, nr: -3 },
      { tiefe: 5, nr: NaN }, { tiefe: -1, nr: TON }, { tiefe: 6, nr: 2.5 },
    ], 10))).toEqual(['0:5:v', '3:9:v', '7:10:v']);
  });

  it('never produces a gap, a repeat or an out-of-order layer', () => {
    const p = mergeProfile(VORGABE, [
      { tiefe: 0.5, nr: SCHLUFF }, { tiefe: 2, nr: BETON },
      { tiefe: 2.3, nr: SCHLUFF }, { tiefe: 8, nr: TON },
    ], 12)!;
    expect(p.schichten[0].tiefe).toBe(0);
    for (let i = 1; i < p.schichten.length; i++) {
      expect(p.schichten[i].tiefe).toBeGreaterThan(p.schichten[i - 1].tiefe);
      expect(p.schichten[i].nr).not.toBe(p.schichten[i - 1].nr);
    }
    expect(p.schichten[p.schichten.length - 1].tiefe).toBeLessThan(p.endTiefe);
  });

  it('keeps the last layer above the bottom even when it was seen there', () => {
    // An observation at the deepest reading would otherwise sit exactly at
    // endTiefe, which is a layer with no thickness.
    const p = mergeProfile(null, [{ tiefe: 0, nr: SAND }, { tiefe: 8, nr: TON }], 8)!;
    expect(p.endTiefe).toBeGreaterThan(8);
    expect(p.schichten.every((s) => s.tiefe < p.endTiefe)).toBe(true);
  });

  it('drops a planned layer at or below the plan own bottom', () => {
    const p = mergeProfile(
      { schichten: [{ tiefe: 0, nr: SAND }, { tiefe: 10, nr: TON }], endTiefe: 10 },
      [], 4,
    )!;
    expect(umriss(p)).toEqual(['0:5:v']);
  });

  it('survives a plan whose layers are out of order', () => {
    const p = mergeProfile(
      { schichten: [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }], endTiefe: 9 },
      [{ tiefe: 1, nr: TON }], 9,
    )!;
    expect(umriss(p)).toEqual(['0:5:v', '1:10:i', '3:9:v']);
  });
});
