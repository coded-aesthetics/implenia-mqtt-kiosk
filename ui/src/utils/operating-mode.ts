import type { OperatingMode } from '../hooks/useWebSocket';

export const MODE_LABELS: Record<OperatingMode, string> = {
  bohren: 'Bohren',
  austausch: 'Austausch',
  einbauen: 'Einbauen',
  auffuellen: 'Auffüllen',
};

export const VERPRESSEN_MODES: readonly OperatingMode[] = ['austausch', 'einbauen', 'auffuellen'];

export function isVerpressenMode(mode: OperatingMode | null | undefined): boolean {
  return mode === 'austausch' || mode === 'einbauen' || mode === 'auffuellen';
}

export function hasPipeHandling(mode: OperatingMode): boolean {
  return mode === 'bohren' || mode === 'auffuellen';
}
