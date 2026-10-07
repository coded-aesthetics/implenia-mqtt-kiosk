/**
 * Depth → timestamp inversion for geology boundaries.
 *
 * A geology profile is a list of depths ("sand starts at 2.5 m"). What gets
 * uploaded is a `GeoDIN` time series, and implenia-web turns that back into
 * layers by change detection — each new code starting a layer at the
 * `Bohrtiefe` of *the same reading*. Its alignment is keyed by exact
 * millisecond (`rowMap.get(date.getTime())` in
 * `injektionsbohren-protocol.server.ts`) and it skips any row where either
 * value is null.
 *
 * So a `GeoDIN` reading written at `Date.now()`, or at an interpolated
 * instant, produces **no layer at all**. It uploads cleanly, appears as a raw
 * series, and the protocol shows zero observed layers — the same shape of
 * silent, total loss as a sensor name that fails to resolve. Every reading
 * this module's output leads to therefore lands on the exact `received_at` of
 * a depth reading that is already recorded.
 *
 * Pure on purpose: this is the one piece of the geology path where being
 * subtly wrong is invisible until someone opens a protocol weeks later.
 */

/** A recorded depth reading: when it arrived, and how deep the hole was. */
export interface DepthSample {
  receivedAt: number;
  depth: number;
}

export interface AlignedBoundary {
  /** The boundary depth that was asked for. */
  depth: number;
  /** `received_at` of a real depth reading — what the GeoDIN reading is dated at. */
  receivedAt: number;
  /**
   * The depth recorded at that instant. This, not `depth`, is where the layer
   * boundary ends up in implenia-web, because web reads the boundary off the
   * `Bohrtiefe` of the aligned row. Usually equal to `depth` within one
   * sampling interval; worth returning so a caller can report the difference.
   */
  sampleDepth: number;
}

export interface BoundaryAlignment {
  /** Boundaries that landed on a reading, in ascending depth and time. */
  aligned: AlignedBoundary[];
  /**
   * Boundaries shallower than this session ever recorded.
   *
   * The drill never crossed them *here*. On a resumed element whose second
   * session starts at 8 m, every planned boundary above that would otherwise
   * take the next free sample and come out as a 10 cm layer at 8.0, 8.1, 8.2 —
   * a plausible-looking profile, entirely fabricated, reported as a success.
   * That is worse than the silent loss this module exists to prevent, so they
   * are dropped like the too-deep ones. Ground above where recording began is
   * what implenia-web's `fillInitialGap` covers from the Vorgabe.
   */
  aboveHole: number[];
  /**
   * Boundaries deeper than the hole ever got.
   *
   * Dropped rather than clamped to the last reading. Clamping would assert the
   * drill observed ground it never reached, and — because several such
   * boundaries would all clamp to the same instant — the deepest one would
   * overwrite the rest anyway, costing a real layer to report a fictional one.
   */
  beyondHole: number[];
  /**
   * Boundaries that had no reading left to sit on: the crossing coincided with
   * one already used by a shallower boundary and the depth never came back.
   * Only reachable when boundaries are closer together than the rig's sampling
   * interval.
   */
  unalignable: number[];
}

/** Depths are metres; this is far below the 0.1 m grid the editor snaps to. */
const EPS = 1e-6;

/**
 * Date each boundary at the first instant the hole was that deep.
 *
 * "First crossing while drilling", which is what the layer means: the drill
 * passed through that boundary once, on the way down. Retraction (`auffuellen`)
 * drives the depth back up afterwards, and taking the *first* qualifying
 * reading is what keeps a boundary on the descent rather than on the way back.
 *
 * Callers pass samples already restricted to the readings that represent real
 * drilling — `phase = 'bohren'` (so Rohrverlängerung's phantom depths are
 * excluded, see rohrwechsel.ts) and not `clipped`.
 *
 * Two invariants hold for the result, and both are load-bearing:
 *
 * 1. **Every `receivedAt` is one of the samples'.** Nothing is interpolated,
 *    nothing is invented outside the session.
 * 2. **The timestamps are strictly increasing.** Two GeoDIN readings at one
 *    instant are one row to web, and the upload's own per-timestamp
 *    deduplication keeps only the last — so a collision silently discards a
 *    layer. Each boundary therefore consumes its sample.
 */
export function alignBoundaries(
  samples: readonly DepthSample[],
  depths: readonly number[],
): BoundaryAlignment {
  const usable = samples
    .filter((s) => Number.isFinite(s.depth) && Number.isFinite(s.receivedAt))
    .slice()
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const wanted = [...new Set(depths.filter((d) => Number.isFinite(d)))]
    .sort((a, b) => a - b);

  const result: BoundaryAlignment = {
    aligned: [], aboveHole: [], beyondHole: [], unalignable: [],
  };
  if (usable.length === 0) {
    result.beyondHole = wanted;
    return result;
  }

  const deepest = usable.reduce((max, s) => (s.depth > max ? s.depth : max), -Infinity);

  /**
   * How far an aligned reading may sit from the boundary it stands for.
   *
   * The largest step between consecutive readings: the drill plausibly passed
   * any depth inside a sampling gap, and nothing outside one. This is what
   * separates "the boundary fell between two readings" from "the boundary is
   * nowhere near anything this session recorded".
   */
  let toleranz = 0;
  for (let i = 1; i < usable.length; i++) {
    toleranz = Math.max(toleranz, Math.abs(usable[i].depth - usable[i - 1].depth));
  }
  toleranz = Math.max(toleranz, EPS);

  // The crossing index rises with depth, so one forward-only cursor serves
  // every boundary. It also doubles as the "already consumed" marker that
  // keeps the timestamps distinct.
  let cursor = 0;
  let lastAt = -Infinity;

  for (const depth of wanted) {
    if (depth > deepest + EPS) {
      result.beyondHole.push(depth);
      continue;
    }

    let i = cursor;
    while (
      i < usable.length
      && (usable[i].depth < depth - EPS || usable[i].receivedAt <= lastAt)
    ) {
      i++;
    }

    if (i >= usable.length) {
      // The hole did reach this depth, but only before a sample a shallower
      // boundary already took, and it never got back down here.
      result.unalignable.push(depth);
      continue;
    }

    // The reading has to actually stand for this boundary. Without this a
    // boundary above everything recorded takes the first sample regardless of
    // how far away it is — see `aboveHole`.
    if (Math.abs(usable[i].depth - depth) > toleranz) {
      result.aboveHole.push(depth);
      continue;
    }

    result.aligned.push({
      depth,
      receivedAt: usable[i].receivedAt,
      sampleDepth: usable[i].depth,
    });
    lastAt = usable[i].receivedAt;
    cursor = i + 1;
  }

  return result;
}

/**
 * Did this session drill, as opposed to only grouting or sitting idle?
 *
 * The question the stop flow asks before showing a geology confirmation at
 * all: a session that never went down has no profile to confirm, and
 * interrupting the operator for one would be exactly the kind of nagging this
 * feature is meant to avoid.
 */
export function drilledDepth(samples: readonly DepthSample[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.depth)) continue;
    if (s.depth < min) min = s.depth;
    if (s.depth > max) max = s.depth;
  }
  if (min === Infinity) return 0;
  return max - min;
}

/**
 * Turn a recorded `GeoDIN` series back into layers, exactly the way
 * implenia-web does (`herstellungLayersFromRows`).
 *
 * Reading our own writes back through web's algorithm is the point: it is what
 * lets the confirmation screen show the operator what the platform will
 * actually receive, and it makes a millisecond misalignment visible on the
 * kiosk — as a missing layer — instead of weeks later in a protocol.
 *
 * `codes` and `samples` are matched on exact `receivedAt`, which is the same
 * join web performs.
 */
export function observedLayers(
  samples: readonly DepthSample[],
  codes: readonly { receivedAt: number; nr: number }[],
): { tiefe: number; nr: number }[] {
  const depthAt = new Map<number, number>();
  for (const s of samples) {
    if (Number.isFinite(s.depth)) depthAt.set(s.receivedAt, s.depth);
  }

  const layers: { tiefe: number; nr: number }[] = [];
  let lastNr: number | null = null;
  for (const c of [...codes].sort((a, b) => a.receivedAt - b.receivedAt)) {
    const depth = depthAt.get(c.receivedAt);
    if (depth === undefined || !Number.isFinite(c.nr)) continue;
    if (c.nr !== lastNr) {
      layers.push({ tiefe: depth, nr: c.nr });
      lastNr = c.nr;
    }
  }
  return layers;
}
