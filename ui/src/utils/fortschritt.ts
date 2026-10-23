import { formatNumber } from './format';

/**
 * What an element tile says about a pillar this kiosk has already recorded.
 *
 * The depth, and not the phase: the phase is a flag the operator sets, so a
 * session that says Auffüllen may hold no readings at all, while a depth says
 * whether anybody has actually drilled here. That is the whole point of the
 * marker — a worker coming back after a shift change must be able to tell a
 * hole somebody is six metres into from one nobody has opened.
 *
 * **A depth of 0 is reported as "begonnen", never as „0,00 m".** Two different
 * things arrive as 0 and both mean the same to a reader: a session that
 * recorded no depth — somebody tapped start, fiddled, and stopped again — and
 * one whose depth the kiosk has not computed yet (`max_depth` is null for every
 * session recorded before it was stored, until `backfillMaxDepth` reaches it).
 * „0,00 m" would read as a measurement of the hole; "begonnen" is the weaker
 * claim, and it is true of both.
 */
export function fortschrittText(tiefe: number): string {
  if (!(tiefe > 0)) return 'begonnen';
  return `bis ${formatNumber(tiefe)} m`;
}
