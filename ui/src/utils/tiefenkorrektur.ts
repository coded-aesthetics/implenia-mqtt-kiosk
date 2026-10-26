/**
 * The arithmetic behind the depth-correction stepper.
 *
 * Pure and separate from the screen because the whole content of it is one
 * bound, and that bound was wrong in a way no amount of looking at the screen
 * explained — see below. `TiefenKorrektur` draws the buttons; this decides
 * what they do.
 */

/** Must match MAX_DEPTH_CORRECTION_M on the server. */
export const MAX_KORREKTUR_CM = 5000;

/**
 * The correction after one press of a step button, in centimetres.
 *
 * `tiefe` is the depth the rig is reporting *right now*, in metres — the
 * stepper submits a difference, so the bound is re-read on every press rather
 * than frozen when the screen opened.
 *
 * **The lower bound may never be positive, and that is the whole point of this
 * function.** It exists to stop a correction from taking the current depth
 * below zero, because a depth above the ground is not a depth and the server
 * refuses one anyway — stopping here means the worker never has to read that
 * message. Written as a plain `-tiefeCm` it does that correctly for a rig
 * reporting a positive depth and turns into a *floor the correction is pushed
 * up to* the moment the rig reports a negative one:
 *
 *   - the first press, in either direction, jumped the correction to exactly
 *     `-tiefe`, so „Neue Tiefe" read **0,00 m**;
 *   - every „Flacher" press after that snapped back to 0,00 m, whatever the
 *     step — which is "the depth is always zeroed no matter which button I
 *     press", reported from the field on 2026-10-26;
 *   - and that first press armed „Übernehmen" with a correction of `-tiefe`
 *     that nobody had dialled in. One more tap moved the depth of the hole by
 *     it, in the opposite direction to the button pressed.
 *
 * A negative depth is not a fault to be hidden here. An absolute-depth rig can
 * report one before the bit is in the ground, and a retrofitted one publishes
 * the Schlittenweg, which sweeps either side of zero all shift (−6,8 … 7,5 m
 * on the one rig that has been captured). With the bound clamped at 0 the
 * screen says what the machine says and only „Tiefer" can move it, which is
 * exactly the operation that is physically available: the depth has to come
 * back to zero before it can go past it.
 */
export function naechsteKorrektur(
  vorherCm: number,
  schrittCm: number,
  tiefe: number | null,
): number {
  const tiefeCm = Math.round((tiefe ?? 0) * 100);
  // Spelled out rather than `Math.min(0, -tiefeCm)`, which answers `-0` for a
  // depth of exactly zero — and `-0` formats as „-0,00 m" in the de-DE locale.
  const min = tiefeCm > 0 ? -tiefeCm : 0;
  return Math.max(
    -MAX_KORREKTUR_CM,
    Math.min(MAX_KORREKTUR_CM, Math.max(min, vorherCm + schrittCm)),
  );
}

/**
 * Whether „Flacher" can do anything at all, i.e. whether the rig is already
 * reporting a depth at or above ground level.
 *
 * The screen says so in a sentence, because three buttons that do nothing and
 * give no reason is the dead end this software does not get to have.
 */
export function nurTieferMoeglich(tiefe: number | null): boolean {
  return tiefe != null && tiefe <= 0;
}
