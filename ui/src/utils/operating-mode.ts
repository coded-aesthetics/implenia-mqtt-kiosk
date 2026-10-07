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
 * Grouped because they share every behaviour that matters: all three handle
 * pipes here, and all three retract on the server (`isRetracting` in
 * `ingestion.ts`), so clipping treats them identically. That is also why
 * skipping one costs nothing — stepping through Austausch to reach Einbauen is
 * behaviourally a no-op, and `operating_mode` is a single overwritten column
 * rather than a time series, so it leaves no trace either.
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

export function hasPipeHandling(mode: OperatingMode): boolean {
  return mode === 'bohren' || mode === 'austausch' || mode === 'einbauen' || mode === 'auffuellen';
}
