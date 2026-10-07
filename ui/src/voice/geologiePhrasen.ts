import { BODENARTEN, HINDERNISSE } from '../utils/geologie';

/**
 * The spoken vocabulary for recording geology during drilling.
 *
 * Geology is the strongest case for voice in this app: the operator's hands are
 * on the rig, and the vocabulary is closed and short. Say "schluff" and the
 * layer is recorded at the depth the rig is at — no screen, no glove on glass.
 *
 * Deliberately limited to the fifteen Bodenarten and six Hindernisse. The
 * Felsarten are names like "Anhydritstein" and "Vulkanisches Gestein" that a
 * small offline Vosk model will mishear far more often than it gets right, and
 * a misheard ground type is worse than a tile tap: it records a layer nobody
 * said. Those stay touch-only, where there is nothing to mishear.
 *
 * `Torf, Humus` and the other comma names are split: nobody says the comma.
 */

export interface GeologiePhrase {
  nr: number;
  name: string;
  phrases: string[];
}

/** Spoken forms of a ground type's name. */
function wortformen(name: string): string[] {
  // "Torf, Humus" is two words for one thing; both should work.
  const teile = name.split(',').map((t) => t.trim()).filter(Boolean);
  const formen = new Set<string>();
  for (const teil of teile) {
    formen.add(teil.toLowerCase());
  }
  return [...formen];
}

/**
 * The phrases that record one ground type.
 *
 * Both the bare name and a prefixed form. The bare name is what someone
 * actually says, and the prefix is what disambiguates the few that collide with
 * ordinary words — "Ton" is also the German for a sound.
 */
export function phrasenFuer(name: string, hindernis: boolean): string[] {
  const phrases = new Set<string>();
  for (const wort of wortformen(name.replace(/^Hindernis\s+/i, ''))) {
    phrases.add(wort);
    if (hindernis) {
      phrases.add(`hindernis ${wort}`);
    } else {
      phrases.add(`schicht ${wort}`);
      phrases.add(`bodenart ${wort}`);
      phrases.add(`geologie ${wort}`);
    }
  }
  return [...phrases];
}

/** Every ground type reachable by voice, with the phrases that select it. */
export function geologieVokabular(): GeologiePhrase[] {
  return [
    ...BODENARTEN.map((e) => ({
      nr: e.nr,
      name: e.name,
      phrases: phrasenFuer(e.name, false),
    })),
    ...HINDERNISSE.map((e) => ({
      nr: e.nr,
      name: e.name,
      phrases: phrasenFuer(e.name, true),
    })),
  ];
}

/** Flat list of every geology phrase, for the Vosk grammar. */
export function geologieGrammatik(): string[] {
  return geologieVokabular().flatMap((v) => v.phrases);
}
