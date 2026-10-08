import { ALLE_EINTRAEGE, type GeologieEintrag } from '@coded-aesthetics/din4023';

/**
 * Finding a ground type by name in the full DIN 4023 catalogue.
 *
 * Written here rather than in the din4023 package only because the package
 * ships on GitHub Packages and a publish cycle is a poor thing to couple a UI
 * iteration to. It is deliberately free of React, of kiosk tokens and of
 * anything kiosk-shaped, so it can be lifted into the package verbatim once
 * the screen has settled on site — implenia-web needs the same thing.
 *
 * ── Why two normal forms ─────────────────────────────────────
 *
 * The catalogue is German and the operator's spelling is not. `Löß` is typed
 * `Löß`, `Loess` and `Loss` by three different people, and `Lößlehm` is the
 * one entry where getting it wrong means finding nothing at all.
 *
 * One fold cannot serve both: stripping the diacritic gives `loss`, spelling
 * it out gives `loess`, and a `loss` needle does not occur in `loess` nor the
 * other way round. So every entry carries **both** forms and so does the
 * query, and a match on any pairing counts. That is three lines of code
 * against a class of "the search is broken" that is invisible until somebody
 * on a rig types the word the other way.
 */

/** Strip the diacritic: `Löß` → `loss`, `Glimmerschiefer` → `glimmerschiefer`. */
function gestrichen(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Spell the umlaut out: `Löß` → `loess`. */
function ausgeschrieben(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Both normal forms of a string, deduplicated when they coincide. */
export function normalformen(text: string): string[] {
  const a = gestrichen(text);
  const b = ausgeschrieben(text);
  return a === b ? [a] : [a, b];
}

/**
 * What an entry can be found by.
 *
 * `kategorie` and `tabelle` are in here on purpose: "fels", "grobkörnig" and
 * "organisch" are words a drilling supervisor uses, and they are the only way
 * a query like "fels" returns anything at all.
 */
function felder(e: GeologieEintrag): string[] {
  return [
    e.name,
    e.kurzform,
    e.kurzformNeben ?? '',
    e.isoSymbol ?? '',
    e.nameAdjektiv ?? '',
    e.kategorie ?? '',
    e.tabelle,
  ].filter((s) => s.length > 0);
}

/**
 * How well an entry answers the query. Higher is better, 0 is no match.
 *
 * Ranked rather than merely filtered because the Kurzform is what a supervisor
 * writes on paper: typing `T` has to put `Ton` first, not the eleven entries
 * with a `t` somewhere in their name. Typing `S` likewise means `Sand`.
 */
function gewicht(e: GeologieEintrag, nadeln: string[]): number {
  const kurz = normalformen(e.kurzform);
  const name = normalformen(e.name);

  let beste = 0;
  for (const n of nadeln) {
    if (kurz.includes(n)) return 100;
    if (kurz.some((k) => k.startsWith(n))) beste = Math.max(beste, 80);
    if (name.some((k) => k.startsWith(n))) beste = Math.max(beste, 60);
    // A word inside the name: "lehm" has to find "Verwitterungslehm,
    // Hanglehm", which starts with neither.
    if (name.some((k) => k.split(/[\s,()]+/).some((w) => w.startsWith(n)))) {
      beste = Math.max(beste, 50);
    }
    if (name.some((k) => k.includes(n))) beste = Math.max(beste, 30);
    if (felder(e).some((f) => normalformen(f).some((k) => k.includes(n)))) {
      beste = Math.max(beste, 10);
    }
  }
  return beste;
}

/**
 * The catalogue entries matching `query`, best first, DIN order within a rank.
 *
 * An empty or whitespace-only query returns the candidates untouched and in
 * their own order — the caller renders its browsing grid from the same call
 * rather than branching, and DIN order is meaningful (G, gG, mG, fG, S, …).
 *
 * A purely numeric query matches the `GeoDIN` code, because that number is
 * what the uploaded series carries and what somebody reading a protocol has in
 * front of them.
 */
export function sucheEintraege(
  query: string,
  kandidaten: readonly GeologieEintrag[] = ALLE_EINTRAEGE,
): GeologieEintrag[] {
  const roh = query.trim();
  if (roh.length === 0) return [...kandidaten];

  if (/^\d+$/.test(roh)) {
    const nr = Number(roh);
    return kandidaten.filter((e) => e.nr === nr || String(e.nr).startsWith(roh));
  }

  const nadeln = normalformen(roh);
  return kandidaten
    .map((e) => ({ e, w: gewicht(e, nadeln) }))
    .filter((t) => t.w > 0)
    .sort((a, b) => (b.w - a.w) || (a.e.nr - b.e.nr))
    .map((t) => t.e);
}
