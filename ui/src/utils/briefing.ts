import type { VorgabenData } from '../hooks/useImplenia';
import { collectVorgabeEntries, geplanteTiefe } from './vorgaben';

/**
 * The Vorgaben briefing: what is planned at this element, shown before anyone
 * starts drilling it.
 *
 * Use-case code, not framework code (see CLAUDE.md). The Vorgaben it draws are
 * the Injektionsbohren contract, and DSV already has somewhere to read them —
 * `ElementDetail`'s Vorgabe tab. Injektionsbohren has had nowhere at all: its
 * element route goes straight to the drilling screen, so the planned depth, the
 * target volume and the two angles were on the kiosk and on no screen.
 */

/**
 * Should opening this element show the briefing instead of a phase screen?
 *
 * ── Why it is a render, not a redirect ───────────────────────────────
 *
 * `element/<name>` means "open this element" and `bohren/<name>` means "the
 * drilling screen, directly" — the same distinction the alignment screen is
 * keyed on, and the thing that keeps either of them from becoming a trap. The
 * briefing is what the former renders, so the forward button navigating to
 * `ausrichten/` or `bohren/` is never bounced back, and the element list is
 * the way to it again. A redirect would need a route of its own and would then
 * collide with the alignment one on the same page.
 *
 * ── Why a running recording never sees it ────────────────────────────
 *
 * The rig is in the hole. A worker who walks back to the list and taps the
 * pillar means "show me what it is doing", and what is planned is no longer
 * the question. It also makes starting a recording from the briefing work
 * without a special case: the moment the session opens, this goes false and
 * the drilling screen takes over under the operator's finger — which is the
 * right screen to be left on.
 *
 * ── Why an element already recorded here never sees it ───────────────
 *
 * It is being **resumed**, and it reopens on the phase its last session was in.
 * Drilling has started; a briefing about what was planned is the wrong screen
 * in front of somebody appending a few metres to a hole they drilled an hour
 * ago. Same rule, and the same reasoning, as `ausrichtenBeimOeffnen` — which
 * is also why the two are asked together: a fresh element shows the briefing
 * *instead of* being redirected to the dials, and reaches them from its own
 * forward button.
 *
 * `nochUnbekannt` is not `bereitsAufgezeichnet: false`. The session lookup is
 * local SQLite and answers in milliseconds, but answering "no" while it is
 * still thinking would put the briefing in front of a resumed element for a
 * frame and then take it away.
 *
 * ── Why no Vorgaben means no briefing ────────────────────────────────
 *
 * There would be nothing on it. A kiosk that has never seen this element and
 * has no Schichtauftrag cached opens it exactly the way it did before — the
 * drilling screen, which still works with no Soll values at all. A briefing
 * showing six dashes and a forward button is a screen that costs a tap and
 * says nothing.
 */
export function briefingBeimOeffnen(args: {
  seite: string;
  /** The kiosk's configured Verfahren. */
  verfahren: string | null;
  aufzeichnungLaeuft: boolean;
  /** This kiosk has recorded this element before — it is being resumed. */
  bereitsAufgezeichnet: boolean;
  /** The session lookup has not answered yet. Not the same as "no session". */
  nochUnbekannt: boolean;
  vorgaben: VorgabenData | null;
}): boolean {
  if (args.seite !== 'element') return false;
  if (args.verfahren !== 'injektionsbohren') return false;
  if (args.aufzeichnungLaeuft) return false;
  if (args.nochUnbekannt || args.bereitsAufgezeichnet) return false;
  return hatBriefingInhalt(args.vorgaben);
}

/**
 * Is there anything to brief?
 *
 * The planned depth or a geology profile. Those are the two things the screen
 * is built around — the hero and the column — and an element carrying neither
 * has nothing worth a screen of its own, whatever else its Vorgaben hold.
 */
export function hatBriefingInhalt(vorgaben: VorgabenData | null): boolean {
  if (!vorgaben) return false;
  if (geplanteTiefe(vorgaben) !== null) return true;
  return collectVorgabeEntries(vorgaben)
    .some((e) => /^Geologie\s+\d+$/i.test(e.name) && parseInt(e.value, 10) > 0);
}
