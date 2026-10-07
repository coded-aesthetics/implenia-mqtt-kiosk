/**
 * Whether a stop should route through the geology sign-off.
 *
 * Separate from the recording bar so the rule is testable, and because it is a
 * rule worth being explicit about: the sign-off is shown **once per session
 * that actually drilled**, on a machine that records geology. Grouting-only
 * sessions, machines without the sensors, and a session that never went down
 * stop exactly as they always have.
 *
 * Never throws and never blocks. A failure here — server unreachable, a
 * malformed response, a session that has gone away — stops the recording
 * normally. Geology must never be what stands between an operator and
 * finishing an element.
 */

export interface GeologyStopContext {
  verfuegbar?: unknown;
  gebohrt?: unknown;
}

/** The decision, given a context the server already produced. */
export function needsGeologyConfirmation(ctx: GeologyStopContext | null): boolean {
  return ctx?.verfuegbar === true && ctx?.gebohrt === true;
}

export async function shouldConfirmGeology(sessionId: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/recording/${sessionId}/geology-context`);
    if (!res.ok) return false;
    return needsGeologyConfirmation(await res.json());
  } catch {
    return false;
  }
}
