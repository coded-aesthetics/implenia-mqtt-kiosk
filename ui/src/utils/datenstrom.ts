/**
 * Reading the Datenstrom screen's channel list: how fresh a channel is, and
 * which group it belongs under.
 *
 * Pure so the boundaries are testable. The one that matters is the difference
 * between "old" and "silent": a channel that stopped publishing has to *say* so
 * rather than keep presenting its last value as current, which is the failure
 * every other view of this data still has.
 */

export type Freshness = 'frisch' | 'alt' | 'stumm';

/**
 * Above this, a value is the last one that arrived rather than what the sensor
 * is doing.
 *
 * The same number as the old Kalibrierung screen's `STALE_AFTER_MS` and the server's
 * `TARE_MAX_AGE_MS`, and deliberately so: it is the age at which `Nullen` is
 * refused, so a screen that called a value fresh past it would be inviting a
 * technician to tap into that refusal.
 */
export const FRESH_MS = 10_000;

/**
 * Above this, a channel is reported as having stopped.
 *
 * The slowest channel on the captured rig — the pumps — publishes every ~3 s,
 * so two minutes is some forty times the longest interval anything is expected
 * to leave. Short enough to notice a pump that died over a break, long enough
 * that nothing healthy trips it.
 */
export const SILENT_MS = 120_000;

export function freshnessOf(ageMs: number): Freshness {
  if (ageMs > SILENT_MS) return 'stumm';
  if (ageMs > FRESH_MS) return 'alt';
  return 'frisch';
}

/**
 * How long ago something arrived, in German.
 *
 * Seconds matter here, which is why this is not `commentTimeAgo()` — a
 * technician watching a channel to identify it needs to see the value move.
 * Takes an age rather than an instant, unlike `TopicAssignment`'s `secondsAgo`,
 * because that is what the channel list carries.
 */
export function ageLabel(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 2) return 'gerade eben';
  if (s < 60) return `vor ${s} s`;
  return `vor ${Math.floor(s / 60)} Min.`;
}

/**
 * The age label for a channel tile. A silent channel is named as silent rather
 * than merely old, because the two call for different actions: an old value
 * means wait, a silent one means go and look at the machine.
 */
export function silenceLabel(ageMs: number): string {
  const label = ageLabel(ageMs);
  return freshnessOf(ageMs) === 'stumm' ? `stumm ${label}` : label;
}

interface Grouped<T> {
  /** The column heading. Empty for the channels that have no prefix. */
  prefix: string;
  channels: T[];
}

/**
 * Group channels into the columns the screen draws, preserving the order the
 * server listed them in (topic ascending, so prefixes come out alphabetically).
 *
 * The group with no prefix sorts last whatever its name would be: it is the
 * leftovers, not a source.
 */
export function groupByPrefix<T extends { prefix: string }>(channels: readonly T[]): Grouped<T>[] {
  const groups = new Map<string, T[]>();
  for (const c of channels) {
    const existing = groups.get(c.prefix);
    if (existing) existing.push(c);
    else groups.set(c.prefix, [c]);
  }
  return [...groups.entries()]
    .map(([prefix, list]) => ({ prefix, channels: list }))
    .sort((a, b) => {
      if (a.prefix === b.prefix) return 0;
      if (!a.prefix) return 1;
      if (!b.prefix) return -1;
      return 0; // server order otherwise
    });
}

/** The heading a group gets. A prefix-less group is named, never left blank. */
export function groupLabel(prefix: string): string {
  return prefix || 'Ohne Präfix';
}

/**
 * A raw payload as the screen shows it.
 *
 * A payload that is not a number is printed **verbatim**. `nan` is a real value
 * on the rig — `Bohrgeraet/Klemmdruck` publishes it in the G08 capture — and
 * `buildSensorValues` would hand back `0` for it, which would have this screen
 * report a pressure the machine never sent. Same rule as `TopicAssignment`.
 */
export function formatPayload(payload: string): string {
  const n = Number.parseFloat(payload);
  if (!Number.isFinite(n)) return payload.trim() || '–';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A y-axis range of exactly four round steps covering `[min, max]`.
 *
 * `SensorChart` draws a fixed four splits and formats them with a fixed number
 * of decimals, so a range that is not four round steps prints ticks like
 * `10 · 11 · 13 · 14 · 15` — the 12,5 rounds to 13 and the axis silently skips
 * a number. Picking the step first and the bounds from it is what keeps every
 * tick a number a person would have chosen.
 *
 * The bounds are also **quantised on purpose**: they feed `scalesKey`, one of
 * the chart's init dependencies, so a range recomputed from live data would
 * destroy and rebuild the uPlot instance rather than redraw it.
 */
/**
 * The fewest decimals that print `step` without rounding it.
 *
 * Not `-log10(step)`: a 2,5-style step gets 1 that way and its ticks print
 * 0 · 0,3 · 0,5 · 0,8 · 1 — two of which are rounded, and the axis then claims
 * gaps the data does not have.
 */
function decimalsFor(step: number): number {
  for (let d = 0; d <= 4; d++) {
    if (Math.abs(Number(step.toFixed(d)) - step) < step * 1e-9) return d;
  }
  return 4;
}

export function niceScale(min: number, max: number): { min: number; max: number; decimals: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, decimals: 0 };
  // A flat signal still needs a band to be drawn in.
  if (max - min < Number.EPSILON) {
    const pad = Math.abs(max) > 1 ? Math.abs(max) * 0.1 : 1;
    min -= pad;
    max += pad;
  }

  const NICE = [1, 2, 2.5, 5, 10];
  const magnitude = Math.pow(10, Math.floor(Math.log10((max - min) / 4)));

  for (let exp = 0; exp < 3; exp++) {
    for (const n of NICE) {
      const step = n * magnitude * Math.pow(10, exp);
      const lo = Math.floor(min / step) * step;
      if (lo + 4 * step >= max) {
        const decimals = decimalsFor(step);
        // Re-round the bounds: floating point leaves 11.000000000000002 here,
        // which prints fine but makes scalesKey differ run to run.
        const round = (v: number) => Number(v.toFixed(decimals + 2));
        return { min: round(lo), max: round(lo + 4 * step), decimals };
      }
    }
  }
  return { min, max, decimals: 2 };
}
