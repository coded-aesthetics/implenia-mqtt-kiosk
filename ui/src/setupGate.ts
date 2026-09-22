/**
 * Which top-level screen the app shows.
 *
 * This used to be a chain of early returns in App, where the *order* of the
 * branches was the policy — unwritten and untested. Two bugs came out of that
 * chain, both the same shape: the setup wizard's visibility was derived from
 * the very state the wizard exists to change, so completing a step unmounted
 * it (first by setting the Verfahren, then by flipping `loading` on refetch).
 *
 * The fix is that the wizard is a route. The URL decides whether it shows, and
 * the URL is not something the wizard's own writes can change underneath it.
 */

export type Screen = 'checking' | 'error' | 'setup' | 'app';

export interface GateInput {
  /** The URL says we are in the wizard. */
  onSetupRoute: boolean;
  /** The setup state is known — the first request has answered. */
  settled: boolean;
  /** The setup state could not be determined at all. */
  hasError: boolean;
  /** null = this kiosk has not been set up. */
  verfahren: string | null;
}

export function resolveScreen({
  onSetupRoute,
  settled,
  hasError,
  verfahren,
}: GateInput): Screen {
  // The URL wins, unconditionally and first. No later loading or error state
  // can pull the wizard out from under someone who is halfway through it.
  if (onSetupRoute) return 'setup';
  if (hasError) return 'error';
  if (!settled) return 'checking';
  // Unconfigured but not yet redirected: render setup rather than flashing the
  // app for a frame while the redirect lands.
  if (verfahren === null) return 'setup';
  return 'app';
}

/** True when an unconfigured kiosk needs to be sent to the wizard. */
export function needsSetupRedirect(input: {
  onSetupRoute: boolean;
  settled: boolean;
  hasError: boolean;
  verfahren: string | null;
}): boolean {
  return (
    !input.onSetupRoute && input.settled && !input.hasError && input.verfahren === null
  );
}
