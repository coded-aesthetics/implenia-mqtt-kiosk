export function clampFrac(v: number, min: number, max: number): number {
  if (min >= max) return 0;
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

export function statusColor(val: number, soll: number | null | undefined): string {
  if (soll == null) return 'var(--color-accent)';
  if (soll === 0) {
    if (val === 0) return 'var(--color-success)';
    return 'var(--color-danger)';
  }
  const dev = Math.abs(val - soll) / Math.abs(soll);
  if (dev < 0.10) return 'var(--color-success)';
  if (dev < 0.25) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

export function autoLabelStep(range: number): number {
  if (range <= 0) return 1;
  const raw = range / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}
