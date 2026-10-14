import type { OperatingMode } from '../hooks/useWebSocket';

export const MODE_LABELS: Record<OperatingMode, string> = {
  bohren: 'Bohren',
  austausch: 'Austausch',
  einbauen: 'Einbauen',
  auffuellen: 'Auffüllen',
};

/**
 * The phases a pillar goes through, in the order they always happen.
 *
 * Fixed sequence, not a free choice: drilling, then the slurry exchange, then
 * the steel core, then filling. Austausch and Einbauen are occasionally
 * omitted, but nothing ever runs out of order — which is why the phase control
 * is a stepper showing where you are rather than a set of equal buttons.
 */
export const PHASE_ORDER: readonly OperatingMode[] = [
  'bohren', 'austausch', 'einbauen', 'auffuellen',
];

/**
 * The phases after drilling.
 *
 * Grouped because all three retract on the server (`isRetracting` in
 * `ingestion.ts`), which is what decides how depth is tracked. They do *not*
 * share clipping: only Auffüllen handles pipes, by removing them in
 * increments the way Bohren adds them. Austausch and Einbauen handle none, so
 * their clamp rests closed and nothing in them is clipped — see
 * `hasPipeHandling`.
 *
 * Skipping one is still cheap rather than free: stepping through Austausch to
 * reach Einbauen passes through a phase that clips nothing, so the cost is at
 * most the readings that arrive between two taps, and `operating_mode` is a
 * single overwritten column rather than a time series, so it leaves no trace.
 *
 * Named for the DSV term the kiosk shipped with. It is the wrong word for
 * Injektionsbohren — see the note in App.tsx — and survives only as an
 * identifier; no screen shows it.
 */
export const VERPRESSEN_MODES: readonly OperatingMode[] = ['austausch', 'einbauen', 'auffuellen'];

/** The phase that follows `mode`, or null at the end of the sequence. */
export function nextPhase(mode: OperatingMode): OperatingMode | null {
  const i = PHASE_ORDER.indexOf(mode);
  if (i < 0 || i === PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[i + 1];
}

/** The phase before `mode`, or null at the start of the sequence. */
export function previousPhase(mode: OperatingMode): OperatingMode | null {
  const i = PHASE_ORDER.indexOf(mode);
  if (i <= 0) return null;
  return PHASE_ORDER[i - 1];
}

export function isVerpressenMode(mode: OperatingMode | null | undefined): boolean {
  return mode === 'austausch' || mode === 'einbauen' || mode === 'auffuellen';
}

/**
 * Whether the drive adds or removes pipes in this phase.
 *
 * Bohren reaches depth by adding 2 m or 3 m pipes; Auffüllen takes them back
 * out the same way. Austausch and Einbauen handle no pipes at all, so a closed
 * clamp there is the resting state and means nothing — which is why the server
 * clips neither (see `hasPipeHandling` in `ingestion.ts`, and keep the two in
 * step: this one decides whether the recording bar shows the paused icon, and
 * a bar claiming a pause while the server records normally is a lie to the
 * operator).
 */
export function hasPipeHandling(mode: OperatingMode): boolean {
  return mode === 'bohren' || mode === 'auffuellen';
}
