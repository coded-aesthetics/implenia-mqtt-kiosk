/**
 * Whether the geology sign-off still has to be shown.
 *
 * Separate from the screens that ask so the rule is testable, and because it is
 * a rule worth being explicit about: the sign-off is shown **once per session
 * that actually drilled**, on a machine that records geology. Grouting-only
 * sessions, machines without the sensors, and a session that never went down
 * stop exactly as they always have.
 *
 * Two callers now ask the same question. The step out of `bohren` asks it to
 * decide whether to route through the review — which is where it normally
 * happens, while the drilling is still fresh. The stop asks it as the backstop,
 * for the sessions that never left `bohren` at all.
 *
 * `bestaetigt` is what keeps it to once: it is set when a review commits and
 * cleared by a step back into `bohren`, so an operator who resumes drilling is
 * asked again about the deeper hole and nobody else is asked twice.
 *
 * Never throws and never blocks. A failure here — server unreachable, a
 * malformed response, a session that has gone away — stops the recording
 * normally. Geology must never be what stands between an operator and
 * finishing an element.
 */

export interface GeologyStopContext {
  verfuegbar?: unknown;
  gebohrt?: unknown;
  bestaetigt?: unknown;
}

/** The decision, given a context the server already produced. */
export function needsGeologyConfirmation(ctx: GeologyStopContext | null): boolean {
  return ctx?.verfuegbar === true && ctx?.gebohrt === true && ctx?.bestaetigt !== true;
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
