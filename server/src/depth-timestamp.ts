/**
 * How far a session's depth readings moved.
 *
 * All that is left of what was once a depth → timestamp inversion. A geology
 * boundary used to have to borrow an instant: the profile was uploaded as a
 * `GeoDIN` time series carrying no depth of its own, implenia-web recovered
 * each layer's depth by pairing the two series on millisecond equality, and
 * `alignBoundaries` existed to give every boundary its own real depth reading
 * so the timestamps stayed strictly increasing and nothing collided.
 *
 * A committed profile is now one JSON value in which every layer states its
 * own depth (`geology.ts`), so there is nothing to invert and nothing pointing
 * into the depth series. `observedLayers` went with it — the live entries it
 * used to reconstruct are stored as depths in `session_geology`, so they are
 * read rather than re-derived.
 *
 * What remains is the question the sign-off asks before it interrupts anybody.
 */

/** A recorded depth reading: when it arrived, and how deep the hole was. */
export interface DepthSample {
  receivedAt: number;
  depth: number;
}

/**
 * Did this session drill, as opposed to only grouting or sitting idle?
 *
 * The question the stop flow asks before showing a geology confirmation at
 * all: a session that never went down has no profile to confirm, and
 * interrupting the operator for one would be exactly the kind of nagging this
 * feature is meant to avoid.
 *
 * `max - min` over the drilling window, which is why `drilling_ended_at`
 * still bounds the samples handed in: once the pipes are back out `min` falls
 * toward zero and the gate gets more permissive than it means to be.
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
