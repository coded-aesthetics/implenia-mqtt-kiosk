/**
 * Building the profile that gets committed: what the operator observed, with
 * the stretches they never confirmed filled in from the Schichtauftrag.
 *
 * ── Why back-filling is not a preference ───────────────────
 *
 * A profile is flat and gapless: each layer runs to the next, the last to the
 * bottom of the hole. So a single ground-type code asserts the ground continues
 * all the way down, and there is **no way to record "sand from 2 m, and no
 * claim below that"** — partial geology is not representable. Leaving the
 * Vorgabe in place where nothing was confirmed is therefore the only option
 * that neither discards what the operator saw nor invents a boundary they
 * rejected, and every layer carries where it came from so the upload can mark
 * the difference.
 *
 * ── Why it lives on the server ─────────────────────────────
 *
 * Because *every* stop has to produce one. The touchscreen's sign-off screen is
 * a review step, not a gate: a stop by voice, from another tab, or straight
 * from the recording bar must back-fill exactly the same way. Doing it here
 * means there is one implementation rather than one per stop path, and the
 * sign-off screen edits what this produced instead of producing its own.
 *
 * ── Why the algebra is not imported ────────────────────────
 *
 * The din4023 package owns the interesting layer algebra — dragging an
 * obstruction through a profile, healing what it leaves, splitting what it
 * lands in — and that stays in the browser, where the dragging happens. What is
 * needed here is only the flat-list insert: "from this depth it is X, down to
 * whatever boundary comes next". That is a sort and an adjacent-merge, and
 * pulling React into the server process to borrow it would cost more than it
 * saves. `geologie.test.ts` on the UI side pins the editor against the same
 * semantics.
 */

import { findByNr } from '@coded-aesthetics/din4023';
import type { VorgabeProfile } from './vorgabe-geology.js';

/** Where a layer's start depth came from. */
export type Quelle = 'ist' | 'vorgabe';

export interface ProfileLayer {
  /** Depth this layer starts at, in metres. */
  tiefe: number;
  /** DIN 4023 `GeologieEintrag.nr`. */
  nr: number;
  quelle: Quelle;
}

export interface MergedProfile {
  schichten: ProfileLayer[];
  endTiefe: number;
}

/** Depths are metres; well below the 0.1 m grid the editor snaps to. */
const EPS = 1e-6;

/** The thinnest layer worth representing, and the floor for a nominal hole. */
const MIN_DICKE = 0.1;

/**
 * The profile to commit (and to present for review).
 *
 * The fold is what makes the operator's entries win. Inserting a layer into an
 * ascending, gapless list *is* "from here it is X, to the next boundary": the
 * layer above it now ends where it starts, and it ends where the next one
 * begins. Applied in ascending depth, each observation cuts into the planned
 * profile and the next one bounds it.
 *
 * Two merges then clean up after the fold:
 *
 * - **A boundary at the same depth is replaced**, not duplicated — confirming a
 *   planned change at the depth it was planned re-types that boundary.
 * - **Adjacent layers of one ground type become one**, with the shallower
 *   boundary surviving. This is what moves a planned boundary to where it was
 *   actually seen: confirming schluff at 2.5 m where the plan said 3 m leaves
 *   one schluff layer starting at 2.5, marked as observed. It is also what
 *   stops a confirmation that changed nothing from splitting a layer in two.
 *
 * Returns null when there is nothing to commit at all.
 */
export function mergeProfile(
  vorgabe: VorgabeProfile | null,
  beobachtet: readonly { tiefe: number; nr: number }[],
  maxTiefe: number,
): MergedProfile | null {
  const observed = beobachtet
    .filter((b) => Number.isFinite(b.tiefe) && b.tiefe >= 0
      && Number.isInteger(b.nr) && b.nr > 0)
    .slice()
    .sort((a, b) => a.tiefe - b.tiefe);

  // A planned layer is bounded by the plan's own bottom: one at or below it has
  // no thickness and describes nothing. Only an observation may push the
  // profile deeper, because only an observation is evidence the drill was
  // there.
  const planned = (vorgabe?.schichten ?? [])
    .filter((s) => Number.isFinite(s.tiefe) && s.tiefe >= 0
      && Number.isInteger(s.nr) && s.nr > 0
      && s.tiefe < (vorgabe?.endTiefe ?? Infinity) - EPS);

  if (planned.length === 0 && observed.length === 0) return null;

  let layers: ProfileLayer[] = planned
    .map((s) => ({ tiefe: s.tiefe, nr: s.nr, quelle: 'vorgabe' as Quelle }));

  for (const b of observed) {
    layers = layers.filter((l) => Math.abs(l.tiefe - b.tiefe) > EPS);
    layers.push({ tiefe: b.tiefe, nr: b.nr, quelle: 'ist' });
    layers.sort((a, b2) => a.tiefe - b2.tiefe);
  }

  // With no Vorgabe to fill the top of the hole, the shallowest ground observed
  // is extended upward — as a Vorgabe-grade assumption, because nobody saw it
  // up there.
  //
  // **Never with an obstruction.** Extending soil upward is a mild guess that
  // is usually right; extending `Hindernis Beton` upward asserts the drill met
  // concrete from the surface, which is a specific claim nobody made. Where the
  // shallowest thing known is an obstruction, the profile simply starts at it:
  // the uploaded series then says "at 2.0 m the code became 60" and nothing
  // before, which is exactly true, is what implenia-web's `fillInitialGap` is
  // there to handle, and draws as empty space above the first layer — which the
  // operator can fill in on the sign-off screen.
  if (layers.length > 0 && layers[0].tiefe > EPS && !istHindernis(layers[0].nr)) {
    layers.unshift({ tiefe: 0, nr: layers[0].nr, quelle: 'vorgabe' });
  }

  layers = mergeAdjacent(layers);
  if (layers.length === 0) return null;

  // The hole can end up deeper than planned, and a profile stopping above the
  // deepest reading would say nothing about ground the drill went through.
  // The last layer must also start above the bottom, or it has no thickness —
  // which is reachable when the deepest thing observed is the deepest reading.
  const deepest = layers[layers.length - 1].tiefe;
  const endTiefe = Math.max(
    vorgabe?.endTiefe ?? 0,
    Number.isFinite(maxTiefe) ? maxTiefe : 0,
    deepest + MIN_DICKE,
    MIN_DICKE,
  );

  return { schichten: layers, endTiefe };
}

/** Is this ground type an obstruction rather than soil or rock? */
function istHindernis(nr: number): boolean {
  return findByNr(nr)?.tabelle === 'Hindernis';
}

/**
 * Collapse runs of one ground type into a single layer, keeping the shallower
 * boundary — and with it, whether that boundary was observed or assumed.
 */
function mergeAdjacent(layers: readonly ProfileLayer[]): ProfileLayer[] {
  const out: ProfileLayer[] = [];
  for (const l of layers) {
    if (out.length > 0 && out[out.length - 1].nr === l.nr) continue;
    out.push(l);
  }
  return out;
}
