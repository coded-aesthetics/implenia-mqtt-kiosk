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
 * The ground types the operator can choose from, grouped as the picker shows
 * them.
 *
 * A closed vocabulary: the whole point of a tile grid is that a gloved hand
 * never types. `Zusammengesetzt` (nr 48–58) is left out deliberately — those
 * are compound descriptions like `U, fs*` that a drilling supervisor does not
 * distinguish at the rig, and 11 more near-identical tiles would cost the
 * screen the room the common ones need.
 */
export const BODENARTEN = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Bodenarten');
export const FELSARTEN = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Felsarten');
export const HINDERNISSE = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Hindernis');

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
 * layer the Schichtauftrag already predicted, so offering 33 DIN types to
 * choose from is 33 ways to mis-tap; these are the three to five that can
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
 * Where a new layer goes when the operator asks for one.
 *
 * The middle of the thickest layer. A correction screen cannot ask "at what
 * depth?" before it knows what is being inserted — that is two questions where
 * the operator has one thought — so it picks a spot with room and lets them
 * step it from there.
 *
 * Thickest rather than last: it is the layer most likely to be hiding a
 * boundary nobody recorded, and it is the one place guaranteed to have room for
 * a split. Null when nothing can be split, which is what greys out the control
 * rather than producing a layer of no thickness.
 */
export function einfuegeTiefe(
  schichten: readonly Schicht[],
  endTiefe: number,
  /**
   * How much room the insert needs, in metres.
   *
   * A soil layer only has to leave a step either side. An obstruction is
   * bounded, so it needs its own thickness *plus* a step above and below — and
   * with the soil figure it was possible to enable the button for an insert
   * that swallowed the layer whole.
   */
  mindestDicke = 2 * RASTER,
): number | null {
  let beste: { tiefe: number; dicke: number } | null = null;
  for (let i = 0; i < schichten.length; i++) {
    const von = schichten[i].tiefe;
    const bis = i + 1 < schichten.length ? schichten[i + 1].tiefe : endTiefe;
    const dicke = bis - von;
    if (!beste || dicke > beste.dicke) beste = { tiefe: runde(von + dicke / 2), dicke };
  }
  if (!beste || beste.dicke < mindestDicke) return null;
  return beste.tiefe;
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
