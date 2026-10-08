import { ALLE_EINTRAEGE, findByNr } from '@coded-aesthetics/din4023';
import {
  RASTER, fuegeSchichtEin, grundBei, runde, type Schicht,
} from '@coded-aesthetics/din4023/profile';

/**
 * The geology vocabulary and the profile the confirmation screen starts from.
 *
 * Pure, so the back-fill rule — the one part of this feature with a decision in
 * it — can be tested without a browser.
 */

/**
 * The ground types the operator can choose from, grouped as the picker's tabs
 * show them — the whole DIN 4023 catalogue bar the obstructions, which have
 * their own picker.
 *
 * It used to be Bodenarten + Felsarten, 33 of 64, and the 14
 * non-petrographic types were the costly omission: `Auffüllung`,
 * `Mutterboden`, `Geschiebemergel`, `Löß`, `Hangschutt`, `Klei` are the most
 * common *top* layers on a German site. Worse, it was asymmetric —
 * `vorgabeArten` happily offers nr 34–47 in the quick column when a
 * Schichtauftrag names one, but the full picker could not reproduce it, so
 * "Andere…" was a one-way door away from a planned ground type.
 *
 * What made 33 the limit was the screen, not the vocabulary: one flat grid of
 * everything cannot be both complete and readable at 1024x768. A tab per
 * table fixes that — no tab exceeds five rows, so every entry gets a tile wide
 * enough for its whole name.
 */
export const BODENARTEN = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Bodenarten');
export const FELSARTEN = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Felsarten');
export const HINDERNISSE = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Hindernis');
/** Soils named for how they came to be rather than their grain: `Auffüllung`. */
export const SONSTIGE_BODEN = ALLE_EINTRAEGE
  .filter((e) => e.tabelle === 'Nicht-petrographisch');
/** Compound descriptions: `U, fs*`, `mS, u, h`. */
export const ZUSAMMENGESETZT = ALLE_EINTRAEGE
  .filter((e) => e.tabelle === 'Zusammengesetzt');

/** Everything a layer may be typed as. Obstructions have their own picker. */
export const WAEHLBAR = [
  ...BODENARTEN, ...SONSTIGE_BODEN, ...FELSARTEN, ...ZUSAMMENGESETZT,
];

/**
 * The picker's tabs, in the order a hole is usually described: grain-size
 * soils first, then the soils named for their origin, then rock, then the
 * compounds nobody reaches for at the rig.
 *
 * Short labels on purpose — four tabs plus a search field share one 64px row,
 * and "Nicht-petrographisch" is a word no operator needs to read to find
 * `Auffüllung` under it.
 */
export const GRUPPEN = [
  { id: 'boden', titel: 'Boden', eintraege: BODENARTEN },
  { id: 'sonstige', titel: 'Sonstige', eintraege: SONSTIGE_BODEN },
  { id: 'fels', titel: 'Fels', eintraege: FELSARTEN },
  { id: 'zusammen', titel: 'Gemischt', eintraege: ZUSAMMENGESETZT },
] as const;

/**
 * A name split into what it is and the examples that follow in brackets.
 *
 * `Vulkanite (z. B. Basalt)` is two different things to a reader: the type,
 * which has to be legible at a glance, and a hint that only matters once the
 * type is in question. Drawn as one string it either wraps to four lines or
 * gets cut — the tiles in the screenshot that started this read `Vulk…` and
 * `(z. B. Basa…`, which names neither.
 */
export function nameTeile(name: string): { haupt: string; hinweis?: string } {
  const m = name.match(/^(.*?)\s*\((.+)\)\s*$/);
  return m ? { haupt: m[1], hinweis: m[2] } : { haupt: name };
}

/** Is this ground type an obstruction rather than soil or rock? */
export function istHindernis(nr: number): boolean {
  return findByNr(nr)?.tabelle === 'Hindernis';
}

/** The full name of a ground type, for the `Geologie` text series and labels. */
export function nameVon(nr: number): string {
  return findByNr(nr)?.name ?? `GeoDIN ${nr}`;
}

/**
 * The short label a tile and a layer row carry.
 *
 * Every obstruction shares the Kurzform `Hi`, so for those the name without its
 * `Hindernis ` prefix is the only thing that tells `Beton` from `Holz`.
 */
export function kurzLabel(nr: number): string {
  const e = findByNr(nr);
  if (!e) return String(nr);
  if (e.tabelle === 'Hindernis') return e.name.replace(/^Hindernis\s+/i, '');
  return e.kurzform;
}

/** A tile's fill colour. Obstructions carry none in DIN 4023, so they get one. */
export function farbeVon(nr: number): string {
  const e = findByNr(nr);
  if (e?.tabelle === 'Hindernis') return 'var(--surface-0)';
  return e?.farbHex ?? 'var(--surface-3)';
}

/**
 * The most tiles that fit the drilling screen's profile column.
 *
 * The column is ~519px tall and a tap target is 64px, so seven plus an
 * "Andere" tile. A Vorgabe with more distinct types than that loses the
 * deepest ones to the full picker rather than shrinking the tiles — a target
 * too small for a gloved hand is worse than one more tap.
 */
/**
 * How many soil tiles the column shows.
 *
 * Measured at 1024x768, not derived from the 64px tap minimum. The column has
 * about 515px between the depth hero and the recording bar, and a tile that
 * carries both markers needs 76px of text — `kurz`, the name, and two marker
 * lines. Five tiles leave ~81px each and still fit the Andere button; six put
 * every tile back on the 64px floor, where the second marker line is clipped
 * mid-glyph and Andere slides behind the recording bar.
 *
 * It was 7, which never fit: Andere was already half-hidden at that count
 * before the markers existed. A Vorgabe naming more distinct soils keeps the
 * shallowest five and leaves the rest to Andere — one extra tap, against text
 * the operator cannot read at all.
 */
export const MAX_SPALTEN_KACHELN = 5;

/**
 * The soil types this element's Vorgabe actually names, shallowest first.
 *
 * What the quick picker offers. The operator is nearly always confirming a
 * layer the Schichtauftrag already predicted, so offering 58 DIN types to
 * choose from is 58 ways to mis-tap; these are the three to five that can
 * plausibly occur in this hole.
 *
 * Distinct types rather than layers: a S/U/S/T profile is three choices, not
 * four, because picking "the second sand" and "the first sand" are the same
 * act. Ordered by first appearance so the list still reads like the profile it
 * replaces, top to bottom.
 *
 * Obstructions are excluded even if a Vorgabe somehow names one — they are not
 * planned ground, and they have their own list.
 */
export function vorgabeArten(schichten: readonly Schicht[] | null | undefined): number[] {
  if (!schichten) return [];
  const gesehen = new Set<number>();
  const arten: number[] = [];
  for (const s of [...schichten].sort((a, b) => a.tiefe - b.tiefe)) {
    if (!Number.isInteger(s.nr) || s.nr <= 0) continue;
    if (istHindernis(s.nr) || gesehen.has(s.nr)) continue;
    gesehen.add(s.nr);
    arten.push(s.nr);
  }
  return arten;
}

/**
 * The ground types the quick picker offers, with the ground the drill is
 * actually in guaranteed a place.
 *
 * The planned soils alone are not enough: an operator who recorded something
 * the Schichtauftrag never named — Kies in a sand/silt/clay hole — would open
 * the picker and find no tile marked as where they are, which is exactly the
 * case where knowing matters. So an active ground outside the plan is appended
 * (at the end, because the list is otherwise ordered like the profile and an
 * unplanned ground has no place in that order) and the cap gives way to it.
 *
 * An obstruction is never injected. The drill being inside one is said by the
 * bar's "Hindernis Ende" button, and a Bodenart list offering `Hindernis Beton`
 * would be offering a tap that records nothing — the same code again is no
 * layer change at all.
 */
export function spaltenKandidaten(
  arten: readonly number[],
  aktiv: number | null | undefined,
  max: number = MAX_SPALTEN_KACHELN,
): number[] {
  const sichtbar = arten.slice(0, max);
  if (aktiv == null || istHindernis(aktiv) || sichtbar.includes(aktiv)) return sichtbar;
  return [...arten.slice(0, max - 1), aktiv];
}

export interface Profil {
  schichten: Schicht[];
  endTiefe: number;
}

/** A layer as the server's merged profile delivers it. */
export interface ServerSchicht {
  tiefe: number;
  nr: number;
  quelle: 'ist' | 'vorgabe';
}

/**
 * The server's profile, in the shape the chart and its algebra want.
 *
 * `quelle` and `vorlaeufig` are the same fact from two directions: a boundary
 * carried over from the Schichtauftrag is an assumption, which the chart draws
 * as a dashed edge. Keeping the merge itself on the server is what makes the
 * sign-off a review step — a stop that never reached this screen commits the
 * very same profile, so there is one answer rather than one per stop path.
 */
export function vomServer(
  profil: { schichten: ServerSchicht[]; endTiefe: number } | null | undefined,
): Profil | null {
  if (!profil || !Array.isArray(profil.schichten) || profil.schichten.length === 0) {
    return null;
  }
  return {
    endTiefe: profil.endTiefe,
    schichten: profil.schichten.map((s) =>
      (s.quelle === 'vorgabe'
        ? { tiefe: s.tiefe, nr: s.nr, vorlaeufig: true }
        : { tiefe: s.tiefe, nr: s.nr })),
  };
}

/**
 * The profile's bottom, extended to wherever the drill actually is.
 *
 * The Vorgabe geology comes from a probe drilling, and that probe does not
 * always go as deep as the hole: one element's plan ends at 36 m while the hole
 * is drilled to 44. Everything the chart draws is clipped to `endTiefe`,
 * including the depth indicator — `tiefenIndikator` is hidden outside the
 * profile range — so for the last eight metres the column stopped saying where
 * the drill was, which is the one thing it is on the screen for.
 *
 * Extending the bottom extends the last layer with it: a profile is gapless and
 * the last layer runs to `endTiefe`, so the deepest ground the probe found is
 * carried down to the drill. That is the honest claim — it is the best evidence
 * anyone has about the ground down there, and a profile that simply stops says
 * nothing at all.
 *
 * Display only, and in whole metres. The committed profile already does this on
 * the server (`geology-profile.ts` ends it at the deepest reading), so nothing
 * here changes what gets uploaded. Whole metres because `modus="vollbild"`
 * re-lays out every layer when `endTiefe` changes: following the depth reading
 * exactly would re-scale the chart several times a second on a Celeron, and
 * would pin the indicator to the very bottom edge, where its label has no room.
 */
export function bisZurBohrung<P extends { schichten: Schicht[]; endTiefe: number }>(
  profil: P | null | undefined,
  tiefe: number | null | undefined,
): P | null {
  if (!profil) return null;
  if (tiefe == null || !Number.isFinite(tiefe) || tiefe <= 0) return profil;
  if (tiefe < profil.endTiefe) return profil;
  // Strictly deeper than the drill, always: floor + 1 keeps the indicator off
  // the bottom edge and re-scales the chart once per metre drilled.
  return { ...profil, endTiefe: Math.floor(tiefe) + 1 };
}

/**
 * The profile as it stands right now, for the live drilling chart.
 *
 * The committed profile says the last ground recorded runs to the next planned
 * boundary — it has to, because a flat gapless profile cannot say "and no claim
 * below that". On screen during drilling that reads wrong: tapping `Findling`
 * at 3.08 m would immediately draw a 4 m block of boulder the drill has not
 * reached, rather than the thin seam it actually is.
 *
 * So for display, the layer the drill is *in* stops at the current depth and the
 * plan resumes below it, dashed. The operator watches the obstruction grow as
 * the hole advances, and it stops growing the moment they tap `Hindernis Ende`
 * — which records a real boundary where the display already had one.
 *
 * Display only. The committed profile is the server's (`geology-profile.ts`),
 * and this never re-derives it — it adjusts the answer the server gave. The
 * boundary sits at least one grid step below the observation so a layer just
 * recorded is visible rather than zero-thickness.
 */
export function liveProfil(
  profil: Profil | null,
  letzteBeobachtungTiefe: number | null,
  vorgabeSchichten: readonly Schicht[] | null | undefined,
  tiefe: number | null,
): Profil | null {
  if (!profil) return null;
  // Nothing observed yet, or no depth to stop at: the plan is the whole story.
  if (letzteBeobachtungTiefe == null || tiefe == null || !Number.isFinite(tiefe)) {
    return profil;
  }

  const grenze = runde(Math.max(tiefe, letzteBeobachtungTiefe + RASTER));
  if (grenze >= profil.endTiefe - RASTER) return profil;

  const geplant = vorgabeSchichten
    ? grundBei(vorgabeSchichten as Parameters<typeof grundBei>[0], grenze)
    : null;
  // No plan to resume — leaving the observed ground running on is the only
  // thing left to draw, and it is what will be committed anyway.
  if (geplant == null) return profil;

  return {
    endTiefe: profil.endTiefe,
    schichten: fuegeSchichtEin(
      profil.schichten, profil.endTiefe, grenze, geplant, { vorlaeufig: true },
    ),
  };
}

/**
 * The planned boundary the drilling is closest to, within `fenster` metres.
 *
 * This is the whole anti-nagging mechanism. Rather than a popup saying "a layer
 * change is expected soon", the entry button itself pre-loads the expected
 * answer and relabels — so the reminder *is* the control. One tap confirms the
 * planned change; ignoring it costs nothing, dismisses nothing, and moves no
 * other element on the screen.
 *
 * Symmetric around the current depth on purpose: an operator who notices the
 * ground changed twenty centimetres ago still gets the one-tap confirmation.
 */
export function naechsteGrenze(
  schichten: readonly Schicht[],
  tiefe: number,
  fenster = 0.3,
): { tiefe: number; nr: number } | null {
  if (!Number.isFinite(tiefe)) return null;

  let beste: { tiefe: number; nr: number } | null = null;
  let besterAbstand = Infinity;
  for (const s of schichten) {
    // Layer 0 starts at the top of the hole; there is no boundary to confirm.
    if (s.tiefe <= 0) continue;
    const abstand = Math.abs(s.tiefe - tiefe);
    if (abstand <= fenster && abstand < besterAbstand) {
      beste = { tiefe: s.tiefe, nr: s.nr };
      besterAbstand = abstand;
    }
  }
  return beste;
}

/** The layer list in the shape the stop route commits. */
export function zumCommit(
  schichten: readonly Schicht[],
): { tiefe: number; nr: number; name: string; quelle: 'ist' | 'vorgabe' }[] {
  return schichten.map((s) => ({
    tiefe: s.tiefe,
    nr: s.nr,
    name: s.beschreibung?.trim() || nameVon(s.nr),
    quelle: s.vorlaeufig ? 'vorgabe' : 'ist',
  }));
}

/**
 * Snap a depth onto the grid, inwards.
 *
 * `runde` goes to the nearest step, which is wrong for a bound: rounding a
 * limit outwards puts it back outside the range it was computed to describe.
 */
function aufGitter(tiefe: number): number {
  return runde(Math.ceil((tiefe - 1e-9) / RASTER) * RASTER);
}

function abGitter(tiefe: number): number {
  return runde(Math.floor((tiefe + 1e-9) / RASTER) * RASTER);
}

/**
 * Which layer a depth falls in — the fallback for a caller with no index from
 * the chart, and the same rule the chart itself uses.
 */
function schichtIndexBei(schichten: readonly Schicht[], tiefe: number): number {
  let index = 0;
  for (let i = 0; i < schichten.length; i++) {
    if (schichten[i].tiefe > tiefe) break;
    index = i;
  }
  return index;
}

/**
 * Where an insert tapped at `tiefe` actually goes, or null if it cannot go
 * there.
 *
 * The tapped depth is a pointed finger, not a measurement, so it has to be
 * brought inside the layer it landed in before it can be used — and for two
 * reasons that both fail quietly:
 *
 * - **A depth that already carries a boundary re-types that layer** rather
 *   than starting a new one (`fuegeSchichtEin`). A tap a few pixels from a
 *   boundary would therefore change the ground above it instead of splitting
 *   it, which is the opposite of what the operator asked for and looks like
 *   nothing happened.
 * - **An obstruction needs room for both its edges.** Inserted against the
 *   bottom of its layer it swallows the boundary below and takes the next
 *   layer's ground with it.
 *
 * So the result is kept `RASTER` below the layer's top and `bedarf - RASTER`
 * above its bottom, and both bounds are snapped inwards onto the grid — so the
 * answer is always on the grid and always inside the layer, and
 * `fuegeSchichtEin`'s own rounding has nothing left to do.
 *
 * Null when the tapped layer is too thin to take the insert at all. That is a
 * refusal the caller has to say out loud: unlike the old "middle of the
 * thickest layer", a tapped depth can land somewhere with no room, and an
 * insert that silently did nothing would be indistinguishable from a mis-read
 * tap.
 */
export function einfuegeTiefeBei(
  schichten: readonly Schicht[],
  endTiefe: number,
  tiefe: number,
  bedarf = 2 * RASTER,
  gezeigterIndex?: number,
): number | null {
  if (!Number.isFinite(tiefe) || schichten.length === 0) return null;

  /*
    The layer the finger was visibly in, as the *chart* decided it.

    This used to be re-derived here from `tiefe`, and that is wrong on both
    sides of every boundary. The chart reports `index` from the raw depth
    under the finger but `tiefe` snapped onto the grid, and its own comment
    says so: within half a grid step the two name neighbouring layers.
    Re-deriving therefore read a tap just above a boundary as landing in the
    layer *below* it and clamped the insert into that layer instead — so the
    new layer appeared below the boundary the operator had aimed above, at a
    depth they had not pointed at. Which layer a new one splits is the whole
    content of the gesture, so the chart's answer wins.
  */
  const index = gezeigterIndex != null
    && Number.isInteger(gezeigterIndex)
    && gezeigterIndex >= 0 && gezeigterIndex < schichten.length
    ? gezeigterIndex
    : schichtIndexBei(schichten, tiefe);

  const von = schichten[index].tiefe;
  const bis = index + 1 < schichten.length ? schichten[index + 1].tiefe : endTiefe;

  const min = aufGitter(von + RASTER);
  const max = abGitter(bis - (bedarf - RASTER));
  if (max < min) return null;

  return Math.min(max, Math.max(min, runde(tiefe)));
}

/**
 * Give every layer an id, so a selection can survive an edit.
 *
 * The screen holds its selection as an id rather than an index because every
 * edit reshuffles indices: an insert shifts everything below it, a delete
 * closes a gap, and `normalisiere` merges two adjacent layers of one ground
 * type into the shallower one. An index kept across any of those points at a
 * different layer than the operator selected — and the controls beside it
 * would then edit that one.
 *
 * Ids have to be topped up after every edit rather than assigned once: the
 * package preserves them through its operations, but a layer born from a split
 * gets none (it is new profile, not a continuation), which is exactly what
 * inserting an obstruction into a layer produces.
 */
export function mitIds(schichten: readonly Schicht[]): Schicht[] {
  return schichten.map((s) => (s.id != null ? s : { ...s, id: neueId() }));
}

/**
 * An id for a layer about to be created.
 *
 * Needed because an insert has to be able to *select* what it inserted, which
 * means knowing the id before the edit rather than topping it up afterwards.
 */
export function neueId(): string {
  return `s${naechsteId++}`;
}

let naechsteId = 1;

/** Reset the id counter. Tests only — ids are opaque and never persisted. */
export function _resetIds(): void {
  naechsteId = 1;
}
