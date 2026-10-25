/**
 * The planned geology profile, read out of an element's Vorgaben.
 *
 * `Geologie n` holds a DIN 4023 ground-type number and `Tiefe Geologie n` the
 * depth that layer *ends* at, so layer n runs from layer n−1's end depth down
 * to its own. The profile bottoms out at the **deeper** of the planned bore
 * depth and the planned geology's own bottom — see `GEPLANTE_TIEFE`.
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

/**
 * The Vorgabe naming how deep the hole is planned to go, in preference order.
 *
 * One per Verfahren, and the name is the Verfahren's own: DSV plans a
 * `Säulenhöhe`, Injektionsbohren a `Bohrlaenge`, Ankerbohren a
 * `Bohrlänge Anker` (its `Bemaßungen` row in `ankerbohren-sensors.csv` —
 * nothing here matches it by prefix, and it records geology like the other
 * two, so leaving it out left every Ankerbohren element with the profile
 * clipped to the last `Tiefe Geologie n`). The list is ordered rather than a
 * set so an element somehow carrying two gets the same answer every time.
 *
 * **It is what bounds the committed profile**, together with the deepest
 * reading — see `endTiefe` below. The planned geology is usually the shallower
 * of the two, because the probe it comes from stops short of the hole: an
 * element surveyed to 36 m with a 43 m bore drew a profile that stopped at 36,
 * and since everything the chart draws is clipped to `endTiefe`, the depth
 * indicator included, the column said nothing about where the drill was for
 * the last seven metres. It is used alone rather than maximised with the
 * survey's bottom, which would report ground below the hole; `endTiefe`
 * carries that reasoning.
 *
 * `Bohrlaenge` is spelled in ASCII in `injektionsbohren-sensors.csv`, which is
 * where the platform's sensor names come from (implenia-web's
 * `sensor-blueprint.server.ts` takes `name` straight off the CSV row). The
 * umlaut spelling is accepted beside it because a miss here is **silent** —
 * the profile simply falls back to the last geology depth, which is the
 * previous behaviour and looks like nothing went wrong.
 */
const GEPLANTE_TIEFE = [
  'Säulenhöhe', 'Bohrlaenge', 'Bohrlänge', 'Bohrlänge Anker',
] as const;
const GEPLANTE_TIEFE_NAMEN: ReadonlySet<string> = new Set(GEPLANTE_TIEFE);

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
  /**
   * How deep the hole is planned to go — the bore Vorgabe, falling back to the
   * planned geology's own bottom when no Verfahren names one.
   *
   * Deliberately not the deeper of the two: see the reasoning where it is
   * computed. A planned layer below this is below the element, and the
   * committed profile must not claim it.
   */
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
  const geplant = new Map<string, number>();

  for (const [name, value] of entries(vorgaben)) {
    if (GEPLANTE_TIEFE_NAMEN.has(name)) {
      const tiefe = num(value);
      if (tiefe !== null) geplant.set(name, tiefe);
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

  // A zero or negative planned depth is "not set", not a hole of no depth.
  const geplanteTiefe = GEPLANTE_TIEFE
    .map((name) => geplant.get(name))
    .find((tiefe): tiefe is number => tiefe !== undefined && tiefe > 0);

  /*
   * The bore, and the geology's own bottom only when no bore is named.
   *
   * **This is the bottom of a hole, not the extent of a survey**, and the two
   * part company in both directions. A probe stopping short of the bore is why
   * the bore has to win when it is the deeper one: 36 m of survey against a
   * 43 m hole once stopped the drawn column — the depth indicator with it —
   * seven metres above the drill.
   *
   * The other direction is what this function must not do, and briefly did.
   * A site may legitimately share one geological section across every element
   * (see the `Geologie 1` comment in the Vorgabe CSV), so a pillar keyed at
   * 13 m routinely carries a 36 m section. Taking the maximum there bounded
   * the *committed* profile at 36 and had the kiosk upload 23 m of planned
   * ground below the bottom of the hole, back-filled and marked
   * `q: "vorgabe"` — ground nobody drilled and nobody claimed. Those layers
   * are not lost by being dropped: they are below the element.
   *
   * A hole that outruns its own Vorgabe is still covered, because
   * `profileEndTiefe` and `grenze` take this together with the deepest
   * reading. That is also what keeps a DSV `Säulenhöhe` safe here — it is a
   * column height rather than a depth to the bottom, so it can sit above the
   * real hole, and the readings make up the difference.
   *
   * The briefing draws the deeper of the two instead (`buildSchichten` in
   * `ui/src/utils/vorgaben.ts`), because showing the whole planned section is
   * informative and commits nothing. That is the display-only parser CLAUDE.md
   * names as the known deviation; this one decides what leaves the kiosk.
   */
  const tiefste = geplanteTiefe ?? prev;
  const endTiefe = tiefste > 0 ? tiefste : FALLBACK_END_TIEFE;

  return { schichten, endTiefe };
}
