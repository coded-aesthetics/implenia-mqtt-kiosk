import { ALLE_EINTRAEGE, findByNr } from '@coded-aesthetics/din4023';
import type { Schicht } from '@coded-aesthetics/din4023/profile';

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
