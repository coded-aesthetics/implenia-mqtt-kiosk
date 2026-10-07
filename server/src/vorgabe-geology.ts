/**
 * The planned geology profile, read out of an element's Vorgaben.
 *
 * `Geologie n` holds a DIN 4023 ground-type number and `Tiefe Geologie n` the
 * depth that layer *ends* at, so layer n runs from layer n−1's end depth down
 * to its own. `Säulenhöhe`, where present, is the authoritative bottom of the
 * hole — the last geology depth is only a fallback.
 *
 * This lives on the server rather than in the UI because the back-fill that
 * fills unconfirmed stretches of a recorded profile happens where the
 * recording stops. Keeping a second parser in the browser would put the
 * `Geologie n` / `Tiefe Geologie n` contract in two places either side of the
 * Soll/Ist boundary, and the two would drift. The UI reads this over
 * `GET /api/elements/:name/geology-vorgabe`, which costs nothing offline: the
 * Vorgaben are already cached in `element_vorgaben` and the server is local.
 *
 * Use-case code, not framework code (see CLAUDE.md): these sensor names are
 * the DSV/Injektionsbohren contract. Another machine type would bring its own
 * module rather than extend this one.
 */

const GEOLOGIE_RE = /^Geologie\s+(\d+)$/i;
const TIEFE_GEOLOGIE_RE = /^Tiefe\s+Geologie\s+(\d+)$/i;
const PILLAR_HEIGHT = 'Säulenhöhe';

/** Fallback bottom depth when the Vorgaben name neither a height nor a depth. */
const FALLBACK_END_TIEFE = 10;

export interface VorgabeLayer {
  /** Depth this layer starts at, in metres. */
  tiefe: number;
  /** DIN 4023 `GeologieEintrag.nr`. */
  nr: number;
}

export interface VorgabeProfile {
  schichten: VorgabeLayer[];
  endTiefe: number;
}

/**
 * Every Vorgabe as a name/value pair, across all sensor-type groups.
 *
 * Values stay as they arrived. The UI's equivalent stringifies first and its
 * comment warns why — German number formatting would turn 1234.5 into
 * "1.234,50" and parse back as 1.234, silently wrecking the profile. Working
 * on the raw values sidesteps that class of bug rather than guarding it.
 */
function entries(vorgaben: unknown): [string, unknown][] {
  if (!vorgaben || typeof vorgaben !== 'object') return [];
  const groups = [
    'float_sensors', 'int_sensors', 'string_sensors',
    'geo_sensors', 'int_float_sensors',
  ] as const;
  const out: [string, unknown][] = [];
  for (const key of groups) {
    const group = (vorgaben as Record<string, unknown>)[key];
    if (!group || typeof group !== 'object') continue;
    for (const [name, value] of Object.entries(group as Record<string, unknown>)) {
      out.push([name, value]);
    }
  }
  return out;
}

/** A Vorgabe value as a number, or null when it carries none. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The planned profile, or null when the Schichtauftrag carries no geology at
 * all — which is how a caller knows there is nothing to back-fill from and no
 * profile worth confirming.
 */
export function parseVorgabeGeology(vorgaben: unknown): VorgabeProfile | null {
  const codes = new Map<number, number>();
  const endDepths = new Map<number, number>();
  let pillarHeight: number | null = null;

  for (const [name, value] of entries(vorgaben)) {
    if (name === PILLAR_HEIGHT) {
      pillarHeight = num(value);
      continue;
    }
    const codeMatch = name.match(GEOLOGIE_RE);
    if (codeMatch) {
      const nr = num(value);
      // nr 0 is not a ground type; a Schichtauftrag uses it for "not set".
      if (nr !== null && nr > 0) codes.set(Number(codeMatch[1]), Math.round(nr));
      continue;
    }
    const depthMatch = name.match(TIEFE_GEOLOGIE_RE);
    if (depthMatch) {
      const depth = num(value);
      if (depth !== null) endDepths.set(Number(depthMatch[1]), depth);
    }
  }

  if (codes.size === 0) return null;

  const schichten: VorgabeLayer[] = [];
  let prev = 0;
  for (const idx of [...codes.keys()].sort((a, b) => a - b)) {
    schichten.push({ tiefe: prev, nr: codes.get(idx)! });
    const end = endDepths.get(idx);
    // A layer with a code but no depth contributes no boundary: the next one
    // starts where this one did, and normalising on the client collapses them.
    if (end !== undefined) prev = end;
  }

  const endTiefe = pillarHeight !== null && pillarHeight > 0
    ? pillarHeight
    : prev > 0 ? prev : FALLBACK_END_TIEFE;

  return { schichten, endTiefe };
}
