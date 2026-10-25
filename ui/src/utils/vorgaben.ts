import type { Schicht } from '@coded-aesthetics/din4023/profile';
import { formatNumber, isNoValue } from './format';
import { findSoll } from './sensors';
import type { SensorDef, VorgabenData } from '../hooks/useImplenia';

/**
 * Reading a Schichtauftrag's vorgaben into what the element screen draws.
 *
 * This is use-case code, not framework code (see CLAUDE.md): the sensor names
 * matched here — "Geologie 3", "Tiefe Geologie 3", "Startpunkt X",
 * "Säulenhöhe" — are the DSV contract. Another machine type has its own
 * special sensors and would bring its own module rather than extend this one.
 *
 * It lives apart from ElementDetail because it is pure: given entries, it
 * produces layers, coordinates and priorities with no React in sight, which
 * is what makes it testable.
 */

const GEOLOGIE_RE = /^Geologie\s+(\d+)$/i;
const TIEFE_GEOLOGIE_RE = /^Tiefe\s+Geologie\s+(\d+)$/i;
const COORDINATE_RE = /^(Startpunkt|Fusspunkt)\s+(X|Y|Z)$/i;
const HIDDEN_SENSORS = new Set(['Nummer']);

/**
 * The Vorgabe naming how deep the hole is planned to go, in preference order —
 * DSV's `Säulenhöhe`, Injektionsbohren's `Bohrlaenge`, Ankerbohren's
 * `Bohrlänge Anker`.
 *
 * The same list as the server's `GEPLANTE_TIEFE` (`vorgabe-geology.ts`), which
 * carries the full reasoning: the planned geology is routinely shallower than
 * the bore, and a profile that stops at the last `Tiefe Geologie n` stops
 * drawing the depth indicator with it. Keep the two in step — this is the
 * display-only parser the CLAUDE.md "Known deviation" note names.
 */
const GEPLANTE_TIEFE = [
  'Säulenhöhe', 'Bohrlaenge', 'Bohrlänge', 'Bohrlänge Anker',
] as const;

export interface VorgabeProfil {
  schichten: Schicht[];
  /**
   * Where the drawn profile bottoms out: the deeper of the planned bore depth
   * and `vermessenBis`.
   */
  endTiefe: number;
  /**
   * Where the planned geology itself stops — the bottom of its deepest layer.
   *
   * 0 when the Schichtauftrag names ground types but no depths at all, which
   * is a profile that makes no claim about where anything ends, and
   * `endTiefe` when its deepest layer states no depth — that one runs to the
   * bottom, so there is no unsurveyed stretch to mark.
   *
   * Below this the deepest planned layer is carried down to `endTiefe`,
   * because a profile is gapless and has no way to say "and no claim below
   * that". The briefing marks the boundary and says so; callers that do not
   * care can ignore the field.
   */
  vermessenBis: number;
}

export interface VorgabeEntry {
  name: string;
  value: string;
}

/**
 * How deep this element is planned to go, in metres, or null when the
 * Schichtauftrag does not say.
 *
 * The number the briefing screen shows as its hero and the number the profile
 * column bottoms out at, from one lookup — so the two cannot disagree about
 * how deep the hole is. Reads the raw Vorgaben rather than `VorgabeEntry[]`
 * because every caller outside the profile has them in that shape already.
 */
export function geplanteTiefe(vorgaben: VorgabenData | null): number | null {
  for (const name of GEPLANTE_TIEFE) {
    const wert = findSoll(vorgaben, name);
    if (wert !== null && wert > 0) return wert;
  }
  return null;
}

export interface CoordinateGroup {
  label: string;
  x: string;
  y: string;
  z: string;
}

export type Priority = 'hero' | 'primary' | 'secondary';

/**
 * Stringify a vorgabe value WITHOUT locale formatting.
 *
 * Deliberately not formatNumber(): these strings are parsed back by
 * buildSchichten() and extractCoordinates() with parseFloat/parseInt. German
 * formatting here would turn 1234.5 into "1.234,50" and read back as 1.234 —
 * silently wrecking the geology profile. Format at the point of display.
 */
export function vorgabeText(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '–';
  if (typeof v === 'string') return v || '–';
  return JSON.stringify(v);
}

/** Every vorgabe of every sensor type, flattened in declaration order. */
export function collectVorgabeEntries(vorgaben: VorgabenData | null): VorgabeEntry[] {
  if (!vorgaben) return [];
  const entries: VorgabeEntry[] = [];
  const groups = [
    vorgaben.float_sensors, vorgaben.int_sensors, vorgaben.string_sensors,
    vorgaben.geo_sensors, vorgaben.int_float_sensors,
  ];
  for (const group of groups) {
    for (const [name, val] of Object.entries(group ?? {})) {
      entries.push({ name, value: vorgabeText(val) });
    }
  }
  return entries;
}

/**
 * Is this sensor drawn by something other than a plain tile?
 *
 * Geology and coordinates have their own presentation, and "Nummer" is
 * internal. Listing them again as tiles would be noise on a screen that has
 * no room for any.
 */
export function isSpecialSensor(name: string): boolean {
  return GEOLOGIE_RE.test(name) || TIEFE_GEOLOGIE_RE.test(name)
    || COORDINATE_RE.test(name) || HIDDEN_SENSORS.has(name);
}

/** Group "Startpunkt X/Y/Z" and "Fusspunkt X/Y/Z" into one row each. */
export function extractCoordinates(entries: VorgabeEntry[]): CoordinateGroup[] {
  const groups = new Map<string, { x: string; y: string; z: string }>();
  for (const { name, value } of entries) {
    const m = name.match(COORDINATE_RE);
    if (!m) continue;
    const groupName = m[1];
    const axis = m[2].toUpperCase() as 'X' | 'Y' | 'Z';
    if (!groups.has(groupName)) groups.set(groupName, { x: '–', y: '–', z: '–' });
    groups.get(groupName)![axis.toLowerCase() as 'x' | 'y' | 'z'] = value;
  }
  return [...groups.entries()].map(([label, coords]) => ({ label, ...coords }));
}

/**
 * The geology column: one Schicht per "Geologie n", running from the previous
 * layer's end depth to its own.
 *
 * Returns null when the Schichtauftrag carries no geology at all, which is
 * how the screen knows not to reserve a column for it.
 */
export function buildSchichten(entries: VorgabeEntry[]): VorgabeProfil | null {
  const geoCodes = new Map<number, number>();
  const geoDepths = new Map<number, number>();

  for (const { name, value } of entries) {
    const codeMatch = name.match(GEOLOGIE_RE);
    if (codeMatch) {
      const idx = parseInt(codeMatch[1], 10);
      const nr = parseInt(value, 10);
      if (!isNaN(nr) && nr > 0) geoCodes.set(idx, nr);
      continue;
    }
    const depthMatch = name.match(TIEFE_GEOLOGIE_RE);
    if (depthMatch) {
      const idx = parseInt(depthMatch[1], 10);
      const depth = parseFloat(value);
      if (!isNaN(depth)) geoDepths.set(idx, depth);
    }
  }

  if (geoCodes.size === 0) return null;

  const indices = [...geoCodes.keys()].sort((a, b) => a - b);
  const schichten: Schicht[] = [];
  let prevDepth = 0;

  for (const idx of indices) {
    const nr = geoCodes.get(idx)!;
    schichten.push({ tiefe: prevDepth, nr });
    const endDepth = geoDepths.get(idx);
    if (endDepth !== undefined) prevDepth = endDepth;
  }

  /*
   * The deepest layer with no `Tiefe Geologie n` of its own is the
   * Schichtauftrag saying "and this one runs to the bottom".
   *
   * It is not the same shape as a survey that stopped: both leave `prevDepth`
   * above `endTiefe`, but here the plan does name the ground down there. The
   * briefing used to mark the boundary and state „Unterhalb X m ist die
   * Geologie nicht erkundet" over a stretch the plan explicitly covers —
   * which is a confident false sentence to a worker about unexplored ground.
   *
   * A Schichtauftrag naming ground types and **no** depths at all is not this
   * and keeps `vermessenBis` at 0: it is the one that makes no claim about
   * where anything ends, rather than one claim reaching the bottom. The
   * marker does not fire for either — it needs a boundary above 0 — so this
   * only decides what the field means.
   */
  const offenesEnde = prevDepth > 0 && !geoDepths.has(indices[indices.length - 1]);

  // Zero or negative is "not set" rather than a hole of no depth.
  const geplant = GEPLANTE_TIEFE
    .map((name) => {
      const entry = entries.find((e) => e.name === name);
      return entry ? parseFloat(entry.value) : NaN;
    })
    .find((tiefe) => Number.isFinite(tiefe) && tiefe > 0);

  // The deeper of the two — see the server's `GEPLANTE_TIEFE`, which carries
  // the reasoning. A bore keyed shallower than the geology it comes with would
  // otherwise clip the layers below it straight out of the drawing.
  const tiefste = Math.max(geplant ?? 0, prevDepth);
  const endTiefe = tiefste > 0 ? tiefste : 10;
  return { schichten, endTiefe, vermessenBis: offenesEnde ? endTiefe : prevDepth };
}

/** Parse a raw MQTT payload (plain number or text, not JSON). */
export function parseRawPayload(payload: string): string {
  const trimmed = payload.trim();
  // isNoValue covers '', 'NaN', '±Infinity' and 'null'; '""' is an empty JSON
  // string, which only ever arrives over MQTT.
  if (isNoValue(trimmed) || trimmed === '""') return '–';

  const num = parseFloat(trimmed);
  if (Number.isFinite(num)) return formatNumber(num);

  // Not a number: show the text. A string sensor has nothing else to show.
  return trimmed;
}

/** Priority from a sensor def, defaulting to 'primary'. */
export function getPriority(sensor: SensorDef | undefined): Priority {
  if (!sensor?.meta?.priority) return 'primary';
  const p = sensor.meta.priority;
  if (p === 'hero' || p === 'primary' || p === 'secondary') return p;
  return 'primary';
}

/** Split a list into the three priority buckets, preserving order. */
export function byPriority<T>(
  items: T[],
  priorityOf: (item: T) => Priority,
): Record<Priority, T[]> {
  const out: Record<Priority, T[]> = { hero: [], primary: [], secondary: [] };
  for (const item of items) out[priorityOf(item)].push(item);
  return out;
}

/** Build a lookup from sensor name to SensorDef. */
export function buildSensorLookup(sensors: SensorDef[]): Map<string, SensorDef> {
  const map = new Map<string, SensorDef>();
  for (const s of sensors) map.set(s.name, s);
  return map;
}
