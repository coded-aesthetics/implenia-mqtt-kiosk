import { describe, it, expect } from 'vitest';
import {
  alignBoundaries, drilledDepth, observedLayers,
  type DepthSample,
} from './depth-timestamp.js';

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

describe('alignBoundaries', () => {
  it('dates a boundary at the first reading that deep', () => {
    const samples = descent(T0, 0, 5); // 0, 0.5, ... 5.0 at T0 + n*1000
    const { aligned } = alignBoundaries(samples, [2.5]);
    expect(aligned).toEqual([{ depth: 2.5, receivedAt: T0 + 5000, sampleDepth: 2.5 }]);
  });

  it('never invents a timestamp: every result is a sample receivedAt', () => {
    const samples = descent(T0, 0, 10);
    const stamps = new Set(samples.map((s) => s.receivedAt));
    // 2.3 and 7.8 fall between samples — the point of the test.
    const { aligned } = alignBoundaries(samples, [0, 2.3, 7.8]);
    expect(aligned).toHaveLength(3);
    for (const a of aligned) expect(stamps.has(a.receivedAt)).toBe(true);
  });

  it('rounds a boundary up to the first reading past it, never down', () => {
    const samples = descent(T0, 0, 10);
    const [a] = alignBoundaries(samples, [2.3]).aligned;
    // 2.3 sits between 2.0 and 2.5; the hole first *was* 2.3 m deep at 2.5.
    expect(a.sampleDepth).toBe(2.5);
    expect(a.receivedAt).toBe(T0 + 5000);
  });

  it('puts the top of the hole on the first reading when recording started there', () => {
    const samples = descent(T0, 0, 6);
    const [a] = alignBoundaries(samples, [0]).aligned;
    expect(a.receivedAt).toBe(T0);
    expect(a.sampleDepth).toBe(0);
  });

  it('tolerates a boundary inside the sampling gap above the first reading', () => {
    // 0.5 m steps, recording from 0.4: the drill plausibly passed 0 between
    // collaring and the first reading.
    const samples = descent(T0, 0.4, 6);
    expect(alignBoundaries(samples, [0]).aligned).toHaveLength(1);
  });

  it('refuses a boundary this session never came near', () => {
    // Session 2 of a resumed element: recording starts at 8 m, and the plan's
    // boundaries at 0/2/5 were drilled on a previous day. Taking the nearest
    // free reading for each would commit Sand at 8.0, Schluff at 8.1 and Ton
    // at 8.2 — three fabricated 10cm layers reported as a clean success, which
    // is worse than the silent loss this module exists to prevent.
    const samples = descent(T0, 8, 10, 0.1);
    const { aligned, aboveHole } = alignBoundaries(samples, [0, 2, 5]);
    expect(aligned).toEqual([]);
    expect(aboveHole).toEqual([0, 2, 5]);
  });

  it('keeps the boundaries a resumed session did drill through', () => {
    const samples = descent(T0, 8, 10, 0.1);
    const { aligned, aboveHole } = alignBoundaries(samples, [5, 8.5, 9.5]);
    expect(aboveHole).toEqual([5]);
    expect(aligned.map((a) => a.depth)).toEqual([8.5, 9.5]);
  });

  it('keeps timestamps strictly increasing', () => {
    const samples = descent(T0, 0, 12);
    const { aligned } = alignBoundaries(samples, [0, 1, 2, 3, 4, 5, 6]);
    const stamps = aligned.map((a) => a.receivedAt);
    expect(stamps).toEqual([...stamps].sort((x, y) => x - y));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('gives each boundary its own reading when several fall in one gap', () => {
    // One 4 m jump, then normal sampling. Both boundaries resolve to the jump,
    // so the second has to move on to the next reading rather than collide.
    const samples: DepthSample[] = [
      { receivedAt: T0, depth: 0 },
      { receivedAt: T0 + 1000, depth: 4 },
      { receivedAt: T0 + 2000, depth: 4.5 },
      { receivedAt: T0 + 3000, depth: 5 },
    ];
    const { aligned, unalignable } = alignBoundaries(samples, [1.5, 2.5]);
    expect(unalignable).toEqual([]);
    expect(aligned.map((a) => a.receivedAt)).toEqual([T0 + 1000, T0 + 2000]);
  });

  it('separates boundaries that share a millisecond', () => {
    // Two depth readings at the same instant — possible at replay speed.
    const samples: DepthSample[] = [
      { receivedAt: T0, depth: 1 },
      { receivedAt: T0, depth: 2 },
      { receivedAt: T0 + 1000, depth: 3 },
    ];
    const { aligned } = alignBoundaries(samples, [1, 2]);
    expect(new Set(aligned.map((a) => a.receivedAt)).size).toBe(2);
  });

  it('drops a boundary deeper than the hole ever got', () => {
    const samples = descent(T0, 0, 5);
    const { aligned, beyondHole } = alignBoundaries(samples, [2, 8]);
    expect(beyondHole).toEqual([8]);
    expect(aligned.map((a) => a.depth)).toEqual([2]);
  });

  it('does not clamp several too-deep boundaries onto the last reading', () => {
    // Clamping would make 6, 7 and 8 one instant; the deepest would win and
    // the real layer at 2 m would be the only survivor of three writes.
    const samples = descent(T0, 0, 5);
    const { aligned, beyondHole } = alignBoundaries(samples, [2, 6, 7, 8]);
    expect(aligned).toHaveLength(1);
    expect(beyondHole).toEqual([6, 7, 8]);
  });

  it('takes the descent, not the retraction, for a hole drilled then pulled', () => {
    const down = descent(T0, 0, 6);
    const up: DepthSample[] = [];
    const lastAt = down[down.length - 1].receivedAt;
    let i = 1;
    for (let d = 5.5; d >= 0; d -= 0.5) {
      up.push({ receivedAt: lastAt + i * 1000, depth: d });
      i++;
    }
    const [a] = alignBoundaries([...down, ...up], [3]).aligned;
    expect(a.receivedAt).toBe(T0 + 6000); // on the way down
  });

  it('ignores non-finite depths rather than aligning to them', () => {
    const samples: DepthSample[] = [
      { receivedAt: T0, depth: 0 },
      { receivedAt: T0 + 1000, depth: NaN },
      { receivedAt: T0 + 2000, depth: 2 },
    ];
    const { aligned } = alignBoundaries(samples, [1]);
    expect(aligned).toEqual([{ depth: 1, receivedAt: T0 + 2000, sampleDepth: 2 }]);
  });

  it('sorts unsorted samples before walking them', () => {
    const shuffled = [...descent(T0, 0, 4)].reverse();
    const { aligned } = alignBoundaries(shuffled, [2]);
    expect(aligned[0].receivedAt).toBe(T0 + 4000);
  });

  it('deduplicates and sorts the requested depths', () => {
    const samples = descent(T0, 0, 5);
    const { aligned } = alignBoundaries(samples, [3, 1, 3]);
    expect(aligned.map((a) => a.depth)).toEqual([1, 3]);
  });

  it('reports every boundary as beyond the hole when nothing was recorded', () => {
    const { aligned, aboveHole, beyondHole } = alignBoundaries([], [0, 2]);
    expect(aligned).toEqual([]);
    expect(aboveHole).toEqual([]);
    expect(beyondHole).toEqual([0, 2]);
  });

  it('tolerates floating-point depth noise at the boundary', () => {
    // 0.1 + 0.2 arithmetic puts a sample a hair under 2.5.
    const samples: DepthSample[] = [
      { receivedAt: T0, depth: 0 },
      { receivedAt: T0 + 1000, depth: 2.5 - 1e-9 },
      { receivedAt: T0 + 2000, depth: 3 },
    ];
    const [a] = alignBoundaries(samples, [2.5]).aligned;
    expect(a.receivedAt).toBe(T0 + 1000);
  });

  it('marks a boundary unalignable rather than reusing a consumed reading', () => {
    // Two readings, and only the second is deep enough for any of these
    // boundaries. The first boundary consumes it; the rest have nothing left —
    // reported, not quietly dated at an instant another layer already holds.
    const samples: DepthSample[] = [
      { receivedAt: T0, depth: 0 },
      { receivedAt: T0 + 1000, depth: 5 },
    ];
    const { aligned, unalignable, beyondHole } = alignBoundaries(samples, [1, 2, 3]);
    expect(beyondHole).toEqual([]);
    expect(aligned.map((a) => a.depth)).toEqual([1]);
    expect(unalignable).toEqual([2, 3]);
  });
});

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

describe('observedLayers', () => {
  /**
   * The layers without the reading each was detected at.
   *
   * `observedLayers` carries the `receivedAt` so geology can look a layer's
   * `Geologie` text up and tell an observation from a back-filled boundary;
   * these cases are about the depths and ground types, so they drop it.
   */
  const ohneZeit = (
    layers: readonly { receivedAt: number; tiefe: number; nr: number }[],
  ): { tiefe: number; nr: number }[] => layers.map(({ tiefe, nr }) => ({ tiefe, nr }));

  it('reads a GeoDIN series back the way implenia-web does', () => {
    const samples = descent(T0, 0, 5);
    const codes = [
      { receivedAt: T0, nr: 5 },
      { receivedAt: T0 + 5000, nr: 9 },
    ];
    expect(ohneZeit(observedLayers(samples, codes))).toEqual([
      { tiefe: 0, nr: 5 },
      { tiefe: 2.5, nr: 9 },
    ]);
  });

  it('starts no layer where the code does not change', () => {
    const samples = descent(T0, 0, 5);
    const codes = [
      { receivedAt: T0, nr: 5 },
      { receivedAt: T0 + 2000, nr: 5 },
      { receivedAt: T0 + 5000, nr: 9 },
    ];
    expect(observedLayers(samples, codes)).toHaveLength(2);
  });

  it('silently drops a code with no depth reading at its exact millisecond', () => {
    // This is the failure the whole module exists to prevent — pinned here so
    // the cost of a misaligned write is visible in the test suite.
    const samples = descent(T0, 0, 5);
    const codes = [{ receivedAt: T0 + 2500, nr: 9 }]; // between samples
    expect(ohneZeit(observedLayers(samples, codes))).toEqual([]);
  });

  it('round-trips an aligned profile back to the depths it came from', () => {
    const samples = descent(T0, 0, 10);
    const profile = [
      { tiefe: 0, nr: 5 },
      { tiefe: 2.5, nr: 9 },
      { tiefe: 4, nr: 60 },  // obstruction
      { tiefe: 4.5, nr: 9 }, // ground resumes
      { tiefe: 7, nr: 10 },
    ];
    const { aligned } = alignBoundaries(samples, profile.map((l) => l.tiefe));
    const codes = aligned.map((a, i) => ({ receivedAt: a.receivedAt, nr: profile[i].nr }));

    expect(ohneZeit(observedLayers(samples, codes))).toEqual([
      { tiefe: 0, nr: 5 },
      { tiefe: 2.5, nr: 9 },
      { tiefe: 4, nr: 60 },
      { tiefe: 4.5, nr: 9 },
      { tiefe: 7, nr: 10 },
    ]);
  });

  it('carries the reading each layer was detected at', () => {
    // What geology.ts joins the `Geologie` text on to recover provenance. A
    // depth cannot stand in for it: change detection means a layer's depth
    // says nothing about which reading produced it.
    const samples = descent(T0, 0, 5);
    const codes = [
      { receivedAt: T0, nr: 5 },
      { receivedAt: T0 + 5000, nr: 9 },
    ];
    expect(observedLayers(samples, codes).map((l) => l.receivedAt))
      .toEqual([T0, T0 + 5000]);
  });

  it('round-trips depths that do not sit on the sampling grid', () => {
    const samples = descent(T0, 0, 10);
    const profile = [
      { tiefe: 0, nr: 5 },
      { tiefe: 2.3, nr: 9 },
      { tiefe: 6.7, nr: 10 },
    ];
    const { aligned } = alignBoundaries(samples, profile.map((l) => l.tiefe));
    const codes = aligned.map((a, i) => ({ receivedAt: a.receivedAt, nr: profile[i].nr }));

    // The ground types survive exactly; the depths land on the readings that
    // first reached them, which is where web will read them off too.
    expect(ohneZeit(observedLayers(samples, codes))).toEqual([
      { tiefe: 0, nr: 5 },
      { tiefe: 2.5, nr: 9 },
      { tiefe: 7, nr: 10 },
    ]);
  });
});
