import { describe, it, expect } from 'vitest';
import { grundBei, RASTER } from '@coded-aesthetics/din4023/profile';
import {
  vomServer, naechsteGrenze, kurzLabel, farbeVon, nameVon, istHindernis,
  zumCommit, vorgabeArten, liveProfil, MAX_SPALTEN_KACHELN,
  spaltenKandidaten, bisZurBohrung, BODENARTEN, HINDERNISSE,
  einfuegeTiefeBei, mitIds, _resetIds,
} from './geologie';

const SAND = 5;
const SCHLUFF = 9;
const TON = 10;
const BETON = 60;
const FINDLING = 64;

/** Compact profile shape for assertions: "startDepth:nr" per layer. */
function umriss(schichten: readonly { tiefe: number; nr: number }[]): string[] {
  return schichten.map((s) => `${s.tiefe}:${s.nr}`);
}

describe('vomServer', () => {
  it('turns a Vorgabe-sourced boundary into a provisional one', () => {
    const p = vomServer({
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
        { tiefe: 2.5, nr: SCHLUFF, quelle: 'ist' },
        { tiefe: 7, nr: TON, quelle: 'vorgabe' },
      ],
      endTiefe: 10,
    })!;
    expect(umriss(p.schichten)).toEqual(['0:5', '2.5:9', '7:10']);
    expect(p.schichten.map((s) => !!s.vorlaeufig)).toEqual([true, false, true]);
    expect(p.endTiefe).toBe(10);
  });

  it('leaves an observed layer with no flag at all, not a false one', () => {
    // normalisiere treats absent and false alike, but an explicit false would
    // survive a round trip through JSON as a key that means nothing.
    const p = vomServer({
      schichten: [{ tiefe: 0, nr: SAND, quelle: 'ist' }],
      endTiefe: 5,
    })!;
    expect('vorlaeufig' in p.schichten[0]).toBe(false);
  });

  it('carries an obstruction through unchanged', () => {
    const p = vomServer({
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
        { tiefe: 4, nr: BETON, quelle: 'ist' },
        { tiefe: 4.4, nr: SAND, quelle: 'ist' },
      ],
      endTiefe: 9,
    })!;
    expect(umriss(p.schichten)).toEqual(['0:5', '4:60', '4.4:5']);
    expect(istHindernis(p.schichten[1].nr)).toBe(true);
  });

  it('is null when the server has no profile to show', () => {
    expect(vomServer(null)).toBeNull();
    expect(vomServer(undefined)).toBeNull();
    expect(vomServer({ schichten: [], endTiefe: 10 })).toBeNull();
  });

  it('round-trips back to the shape the commit sends', () => {
    const vom = {
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' as const },
        { tiefe: 3, nr: TON, quelle: 'ist' as const },
      ],
      endTiefe: 8,
    };
    expect(zumCommit(vomServer(vom)!.schichten)).toEqual([
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'vorgabe' },
      { tiefe: 3, nr: TON, name: 'Ton', quelle: 'ist' },
    ]);
  });
});

describe('naechsteGrenze', () => {
  const schichten = [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 7, nr: TON }];

  it('announces a boundary the drilling is approaching', () => {
    expect(naechsteGrenze(schichten, 2.8)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('still announces one just passed', () => {
    expect(naechsteGrenze(schichten, 3.2)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('stays quiet in the middle of a layer', () => {
    expect(naechsteGrenze(schichten, 5)).toBeNull();
  });

  it('never announces the top of the hole', () => {
    expect(naechsteGrenze(schichten, 0)).toBeNull();
    expect(naechsteGrenze(schichten, 0.1)).toBeNull();
  });

  it('picks the nearer of two close boundaries', () => {
    const dicht = [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 3.4, nr: TON }];
    expect(naechsteGrenze(dicht, 3.3)).toEqual({ tiefe: 3.4, nr: TON });
  });

  it('respects a custom window', () => {
    expect(naechsteGrenze(schichten, 2.5, 0.3)).toBeNull();
    expect(naechsteGrenze(schichten, 2.5, 0.6)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('is quiet for a depth that is not a number', () => {
    expect(naechsteGrenze(schichten, NaN)).toBeNull();
  });

  it('is quiet for an empty profile', () => {
    expect(naechsteGrenze([], 3)).toBeNull();
  });
});

describe('the vocabulary', () => {
  it('offers the fifteen soils and six obstructions', () => {
    expect(BODENARTEN).toHaveLength(15);
    expect(HINDERNISSE).toHaveLength(6);
  });

  it('distinguishes obstructions by name, since they share one Kurzform', () => {
    // Every Hindernis entry has kurzform "Hi", so the Kurzform alone would make
    // six identical tiles.
    expect(HINDERNISSE.every((e) => e.kurzform === 'Hi')).toBe(true);
    expect(HINDERNISSE.map((e) => kurzLabel(e.nr))).toEqual([
      'Stahl', 'Beton', 'Holz', 'Sonstiges', 'Hohlräume', 'Findling',
    ]);
  });

  it('uses the DIN Kurzform for soils and rocks', () => {
    expect(kurzLabel(SAND)).toBe('S');
    expect(kurzLabel(SCHLUFF)).toBe('U');
  });

  it('names a ground type for the text series', () => {
    expect(nameVon(SAND)).toBe('Sand');
    expect(nameVon(BETON)).toBe('Hindernis Beton');
  });

  it('falls back readably for a number outside the tables', () => {
    expect(nameVon(999)).toBe('GeoDIN 999');
    expect(kurzLabel(999)).toBe('999');
  });

  it('gives obstructions a colour, since DIN 4023 gives them none', () => {
    expect(HINDERNISSE.every((e) => e.farbHex === undefined)).toBe(true);
    expect(farbeVon(BETON)).toBe('var(--surface-0)');
    expect(farbeVon(SAND)).toMatch(/^#/);
  });

  it('recognises an obstruction by number', () => {
    expect(istHindernis(BETON)).toBe(true);
    expect(istHindernis(SAND)).toBe(false);
    expect(istHindernis(999)).toBe(false);
  });
});

describe('zumCommit', () => {
  it('carries the provenance of every boundary', () => {
    expect(zumCommit([
      { tiefe: 0, nr: SAND, vorlaeufig: true },
      { tiefe: 2, nr: SCHLUFF },
    ])).toEqual([
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'vorgabe' },
      { tiefe: 2, nr: SCHLUFF, name: 'Schluff', quelle: 'ist' },
    ]);
  });

  it('prefers a per-layer description over the DIN name', () => {
    expect(zumCommit([{ tiefe: 0, nr: SAND, beschreibung: 'Feinsand, humos' }])[0].name)
      .toBe('Feinsand, humos');
  });
});

describe('vorgabeArten', () => {
  it('lists the soil types the Vorgabe names, shallowest first', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 7, nr: TON },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('collapses a repeated type to one choice', () => {
    // S/U/S/T is three choices, not four: picking "the second sand" and "the
    // first sand" are the same act.
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF },
      { tiefe: 4, nr: SAND }, { tiefe: 6, nr: TON },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('orders by depth, not by the order the layers arrived in', () => {
    expect(vorgabeArten([
      { tiefe: 7, nr: TON }, { tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('leaves obstructions out — they have their own list', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: BETON }, { tiefe: 2.4, nr: SCHLUFF },
    ])).toEqual([SAND, SCHLUFF]);
  });

  it('ignores unusable entries', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 1, nr: 0 },
      { tiefe: 2, nr: -1 }, { tiefe: 3, nr: 2.5 },
    ])).toEqual([SAND]);
  });

  it('is empty for an absent or empty profile', () => {
    expect(vorgabeArten(null)).toEqual([]);
    expect(vorgabeArten(undefined)).toEqual([]);
    expect(vorgabeArten([])).toEqual([]);
  });

  it('leaves room for the Andere tile and for both markers', () => {
    // Measured at 1024x768: a tile carrying "Aktuell" and "Vorgabe" needs 76px
    // of text, and six tiles push every one of them back to the 64px floor —
    // where the second marker line is clipped and Andere slides behind the
    // recording bar. See MAX_SPALTEN_KACHELN.
    expect(MAX_SPALTEN_KACHELN).toBe(5);
  });
});

describe('spaltenKandidaten', () => {
  const KIES = 3;

  it('offers the planned soils when the drill is in one of them', () => {
    expect(spaltenKandidaten([SAND, SCHLUFF, TON], SCHLUFF))
      .toEqual([SAND, SCHLUFF, TON]);
  });

  it('adds the ground actually recorded when the plan never named it', () => {
    // The case this exists for: Kies in a sand/silt/clay hole. Without it the
    // operator opens the picker and nothing is marked as where they are.
    expect(spaltenKandidaten([SAND, SCHLUFF, TON], KIES))
      .toEqual([SAND, SCHLUFF, TON, KIES]);
  });

  it('appends rather than leading, so the list still reads like the profile', () => {
    expect(spaltenKandidaten([SAND, SCHLUFF, TON], KIES).indexOf(KIES)).toBe(3);
  });

  it('keeps the column within its cap, giving up a planned tile if it must', () => {
    const viele = [1, 2, 4, 5, 6, 7, 8, 9, 10];
    const mit = spaltenKandidaten(viele, KIES);
    expect(mit).toHaveLength(MAX_SPALTEN_KACHELN);
    expect(mit[mit.length - 1]).toBe(KIES);
  });

  it('reaches a planned soil that the cap would have cut off', () => {
    const viele = [1, 2, 4, 5, 6, 7, 8, 9, 10];
    expect(spaltenKandidaten(viele, 10)).toContain(10);
  });

  it('never injects an obstruction into the soil list', () => {
    // A tap there would record the code that is already current — no layer
    // change at all. Leaving the obstruction is the bar's job.
    expect(spaltenKandidaten([SAND, SCHLUFF, TON], BETON))
      .toEqual([SAND, SCHLUFF, TON]);
  });

  it('passes the plan straight through when nothing is active', () => {
    expect(spaltenKandidaten([SAND, SCHLUFF], null)).toEqual([SAND, SCHLUFF]);
    expect(spaltenKandidaten([SAND, SCHLUFF], undefined)).toEqual([SAND, SCHLUFF]);
  });

  it('offers the recorded ground alone when there is no plan at all', () => {
    expect(spaltenKandidaten([], KIES)).toEqual([KIES]);
  });
});

describe('the ground an obstruction returns to', () => {
  /*
   * "Hindernis Ende" records one tap with no pick, which only works if the
   * right answer is knowable. It is: the obstruction interrupted a layer the
   * Vorgabe planned, and the Vorgabe holds only soils — never obstructions —
   * so the planned ground at the current depth is always a soil to resume.
   *
   * useGeologieErfassung derives it with grundBei; these pin what that means,
   * including the one case where it cannot answer and the picker has to open.
   */
  const vorgabe = [
    { tiefe: 0, nr: SAND },
    { tiefe: 3, nr: SCHLUFF },
    { tiefe: 7, nr: TON },
  ];

  it('resumes the layer the obstruction interrupted', () => {
    // Concrete met at 4.0 m, inside the planned schluff layer (3–7 m).
    expect(grundBei(vorgabe, 4.2)).toBe(SCHLUFF);
  });

  it('resumes the right layer when the obstruction spans a planned boundary', () => {
    // Met at 6.8 m, left at 7.2 m — below it the plan says ton, not schluff.
    expect(grundBei(vorgabe, 7.2)).toBe(TON);
  });

  it('never resumes into an obstruction, because the plan holds none', () => {
    const arten = vorgabeArten(vorgabe);
    expect(arten.some(istHindernis)).toBe(false);
    for (const tiefe of [0, 1.5, 3, 5, 7, 9]) {
      const nr = grundBei(vorgabe, tiefe);
      expect(nr === null || !istHindernis(nr), `at ${tiefe} m`).toBe(true);
    }
  });

  it('answers nothing above the first layer, which is what opens the picker', () => {
    expect(grundBei([{ tiefe: 2, nr: SAND }], 1)).toBeNull();
  });
});

describe('bisZurBohrung', () => {
  /*
   * The field case this exists for: the probe drilling ended at 36 m and the
   * hole went to 44. Everything the chart draws is clipped to `endTiefe`,
   * including the depth indicator — so the column stopped saying where the
   * drill was for the last eight metres, which is what it is there for.
   */
  const plan = {
    schichten: [
      { tiefe: 0, nr: SAND },
      { tiefe: 12, nr: SCHLUFF },
      { tiefe: 30, nr: TON },
    ],
    endTiefe: 36,
  };

  it('extends the bottom past a drill deeper than the plan', () => {
    expect(bisZurBohrung(plan, 43.7)!.endTiefe).toBe(44);
  });

  it('keeps the bottom strictly below the drill, so the marker has room', () => {
    for (const tiefe of [36, 40, 43.7, 44]) {
      expect(bisZurBohrung(plan, tiefe)!.endTiefe, `at ${tiefe} m`)
        .toBeGreaterThan(tiefe);
    }
  });

  it('extends the last layer with it, rather than adding one', () => {
    // A profile is gapless: the last layer runs to endTiefe, so the deepest
    // ground the probe found is what gets carried down to the drill.
    const erweitert = bisZurBohrung(plan, 43.7)!;
    expect(umriss(erweitert.schichten)).toEqual(umriss(plan.schichten));
    expect(erweitert.schichten[erweitert.schichten.length - 1].nr).toBe(TON);
  });

  it('moves in whole metres, so the chart re-scales once per metre drilled', () => {
    // vollbild re-lays out every layer when endTiefe changes; following the
    // reading exactly would do that several times a second.
    expect(bisZurBohrung(plan, 40.1)!.endTiefe).toBe(41);
    expect(bisZurBohrung(plan, 40.9)!.endTiefe).toBe(41);
  });

  it('leaves a plan deeper than the drill alone', () => {
    expect(bisZurBohrung(plan, 20)).toBe(plan);
    expect(bisZurBohrung(plan, 35.9)).toBe(plan);
  });

  it('leaves the profile alone without a usable depth', () => {
    expect(bisZurBohrung(plan, null)).toBe(plan);
    expect(bisZurBohrung(plan, undefined)).toBe(plan);
    expect(bisZurBohrung(plan, NaN)).toBe(plan);
    // 0 is what a screen shows before the first depth reading arrives.
    expect(bisZurBohrung(plan, 0)).toBe(plan);
    expect(bisZurBohrung(plan, -1)).toBe(plan);
  });

  it('passes a missing profile through, so a screen can chain it', () => {
    expect(bisZurBohrung(null, 40)).toBeNull();
    expect(bisZurBohrung(undefined, 40)).toBeNull();
  });

  it('is idempotent, because two screens may both apply it', () => {
    const einmal = bisZurBohrung(plan, 43.7)!;
    expect(bisZurBohrung(einmal, 43.7)!.endTiefe).toBe(einmal.endTiefe);
  });

  it('lets the live profile clip the observed layer below the plan', () => {
    // Without the extension liveProfil has no room left for a boundary and
    // hands the profile back untouched — the bug, one layer deeper: the ground
    // the drill is in ran to 36 m while the drill stood at 43,7.
    const vorgabe = plan.schichten;
    const beobachtet = {
      schichten: [
        { tiefe: 0, nr: SAND, vorlaeufig: true },
        { tiefe: 30, nr: TON, vorlaeufig: true },
        { tiefe: 35, nr: FINDLING },
      ],
      endTiefe: 36,
    };
    expect(liveProfil(beobachtet, 35, vorgabe, 43.7)).toBe(beobachtet);
    const p = liveProfil(bisZurBohrung(beobachtet, 43.7), 35, vorgabe, 43.7)!;
    expect(p.endTiefe).toBe(44);
    // The boulder ends at the drill, and the plan's deepest ground resumes.
    expect(p.schichten[p.schichten.length - 1]).toMatchObject({
      tiefe: 43.7, nr: TON, vorlaeufig: true,
    });
  });
});

describe('liveProfil', () => {
  /*
   * What the drilling chart draws, which is deliberately *not* what would be
   * committed. The committed profile has to say the last ground recorded runs
   * to the next planned boundary — a gapless profile cannot say "and no claim
   * below that" — so drawing it live would show 4m of boulder the drill has not
   * reached. Here the layer the drill is in stops at the drill.
   */
  const vorgabe = [
    { tiefe: 0, nr: SAND },
    { tiefe: 3, nr: SCHLUFF },
    { tiefe: 7, nr: TON },
  ];
  /** What the server commits after a Findling is recorded at 3.1 m. */
  const nachFund: Parameters<typeof liveProfil>[0] = {
    schichten: [
      { tiefe: 0, nr: SAND, vorlaeufig: true },
      { tiefe: 3, nr: SCHLUFF, vorlaeufig: true },
      { tiefe: 3.1, nr: FINDLING },
    ],
    endTiefe: 12,
  };

  function umrissV(p: ReturnType<typeof liveProfil>): string[] {
    return (p?.schichten ?? []).map((s) => `${s.tiefe}:${s.nr}${s.vorlaeufig ? 'v' : ''}`);
  }

  it('stops the observed layer at the drill, with the plan resuming below', () => {
    // Drill at 3.4 m: the boulder is 30 cm of hole, not 3.9 m of it.
    expect(umrissV(liveProfil(nachFund, 3.1, vorgabe, 3.4)))
      .toEqual(['0:5v', '3:9v', '3.1:64', '3.4:9v']);
  });

  it('grows the observed layer as the hole advances', () => {
    const bei = (t: number) => liveProfil(nachFund, 3.1, vorgabe, t)!
      .schichten.find((s) => s.nr === FINDLING)!;
    // The boulder starts where it was met and its bottom follows the drill.
    expect(bei(3.4).tiefe).toBe(3.1);
    expect(umrissV(liveProfil(nachFund, 3.1, vorgabe, 3.4))[3]).toBe('3.4:9v');
    expect(umrissV(liveProfil(nachFund, 3.1, vorgabe, 5))[3]).toBe('5:9v');
  });

  it('keeps a just-recorded layer visible rather than zero-thickness', () => {
    // Recorded at 3.1 with the drill still at 3.1: the layer gets one grid
    // step, so it appears immediately instead of flashing.
    const p = liveProfil(nachFund, 3.1, vorgabe, 3.1)!;
    const findling = p.schichten.find((s) => s.nr === FINDLING)!;
    const danach = p.schichten.find((s) => s.tiefe > findling.tiefe)!;
    expect(danach.tiefe).toBeGreaterThan(findling.tiefe);
  });

  it('marks the ground below the drill as not yet observed', () => {
    const p = liveProfil(nachFund, 3.1, vorgabe, 3.4)!;
    expect(p.schichten.find((s) => s.tiefe === 3.4)?.vorlaeufig).toBe(true);
    // ...and the observation itself stays confirmed.
    expect(p.schichten.find((s) => s.nr === FINDLING)?.vorlaeufig).toBeFalsy();
  });

  it('adds no boundary when the observation confirms the plan', () => {
    const bestaetigt = {
      schichten: [
        { tiefe: 0, nr: SAND, vorlaeufig: true },
        { tiefe: 2.5, nr: SCHLUFF },
      ],
      endTiefe: 12,
    };
    // Schluff observed at 2.5 and schluff planned below: nothing to draw.
    expect(umrissV(liveProfil(bestaetigt, 2.5, vorgabe, 4)))
      .toEqual(['0:5v', '2.5:9']);
  });

  it('shows the plan untouched before anything is observed', () => {
    const nur = { schichten: vorgabe.map((s) => ({ ...s, vorlaeufig: true })), endTiefe: 12 };
    expect(liveProfil(nur, null, vorgabe, 4)).toBe(nur);
  });

  it('shows the committed shape once the drill nears the bottom', () => {
    // Nothing left to resume into, so there is no adjustment to make.
    expect(liveProfil(nachFund, 3.1, vorgabe, 11.95)).toBe(nachFund);
  });

  it('shows the committed shape when there is no plan to resume', () => {
    expect(liveProfil(nachFund, 3.1, null, 4)).toBe(nachFund);
    expect(liveProfil(nachFund, 3.1, [{ tiefe: 5, nr: SAND }], 4)).toBe(nachFund);
  });

  it('is null without a profile, and unchanged without a depth', () => {
    expect(liveProfil(null, 3.1, vorgabe, 4)).toBeNull();
    expect(liveProfil(nachFund, 3.1, vorgabe, null)).toBe(nachFund);
    expect(liveProfil(nachFund, 3.1, vorgabe, NaN)).toBe(nachFund);
  });
});

describe('einfuegeTiefeBei', () => {
  const SOIL = 2 * RASTER;
  /** A soil insert plus a 0.2 m obstruction, the screen's own figure. */
  const HINDERNIS_BEDARF = 0.2 + 2 * RASTER;

  const profil = [
    { tiefe: 0, nr: SAND },
    { tiefe: 3, nr: SCHLUFF },
    { tiefe: 7, nr: TON },
  ];

  it('inserts at the depth that was tapped', () => {
    expect(einfuegeTiefeBei(profil, 12, 4.7, SOIL)).toBe(4.7);
  });

  describe('the layer the chart says the finger was in', () => {
    // The chart reports `index` from the raw depth under the finger but
    // `tiefe` snapped onto the grid, so within half a step of a boundary the
    // two name neighbouring layers. Which layer a new one splits is the whole
    // content of the gesture, so the index wins.
    it('splits the layer above when the tap was above the boundary', () => {
      // Tapped at 2.97 m — visibly in the sand (index 0) — which snaps to 3.0,
      // the silt's own boundary. Re-deriving read that as the silt and put the
      // new layer at 3.1, below the boundary the operator aimed above.
      expect(einfuegeTiefeBei(profil, 12, 3, SOIL, 0)).toBe(2.9);
    });

    it('splits the layer below when the tap was below the boundary', () => {
      expect(einfuegeTiefeBei(profil, 12, 3, SOIL, 1)).toBe(3.1);
    });

    it('falls back to deriving the layer when no index is given', () => {
      expect(einfuegeTiefeBei(profil, 12, 3, SOIL)).toBe(3.1);
    });

    it('ignores an index that is not a layer', () => {
      for (const bad of [-1, 3, 99, 1.5, NaN]) {
        expect(einfuegeTiefeBei(profil, 12, 4.7, SOIL, bad), `index ${bad}`)
          .toBe(4.7);
      }
    });

    it('still refuses a layer with no room, whichever one the chart named', () => {
      const duenn = [
        { tiefe: 0, nr: SAND },
        { tiefe: 3, nr: BETON },
        { tiefe: 3.1, nr: SCHLUFF },
      ];
      expect(einfuegeTiefeBei(duenn, 12, 3.1, SOIL, 1)).toBeNull();
    });
  });

  it('snaps a tap between grid steps', () => {
    expect(einfuegeTiefeBei(profil, 12, 4.73, SOIL)).toBe(4.7);
    expect(einfuegeTiefeBei(profil, 12, 4.76, SOIL)).toBe(4.8);
  });

  it('never returns the boundary itself, which would re-type the layer above', () => {
    // A tap right on the 3 m boundary, and just above and below it. All three
    // have to produce a depth that splits something rather than one that lands
    // on an existing boundary.
    for (const tap of [2.99, 3, 3.01]) {
      const t = einfuegeTiefeBei(profil, 12, tap, SOIL)!;
      expect(t, `tap at ${tap}`).not.toBe(3);
      expect(profil.map((s) => s.tiefe)).not.toContain(t);
    }
  });

  it('keeps an insert inside the layer that was tapped', () => {
    // Tapped at the very top of the silt layer: it belongs in the silt, one
    // grid step down, not in the sand above it.
    expect(einfuegeTiefeBei(profil, 12, 3, SOIL)).toBe(3.1);
    // And at the very bottom of it: one step above the clay.
    expect(einfuegeTiefeBei(profil, 12, 7, SOIL)).toBe(7.1);
    expect(einfuegeTiefeBei(profil, 12, 6.99, SOIL)).toBe(6.9);
  });

  it('leaves an obstruction room for its lower edge', () => {
    // 0.2 m thick, tapped at the bottom of the hole: it has to end a grid step
    // above `endTiefe`, or it swallows the bottom boundary.
    const t = einfuegeTiefeBei(profil, 12, 11.95, HINDERNIS_BEDARF)!;
    expect(t).toBe(11.7);
    expect(t + 0.2).toBeLessThan(12);
  });

  it('refuses a layer with no room for what is being inserted', () => {
    // A 0.2 m seam takes a soil boundary at its midpoint, but not a 0.2 m
    // obstruction — that needs a step either side as well.
    const seam = [{ tiefe: 0, nr: SAND }, { tiefe: 4, nr: BETON }, { tiefe: 4.2, nr: SAND }];
    expect(einfuegeTiefeBei(seam, 12, 4.1, SOIL)).toBe(4.1);
    expect(einfuegeTiefeBei(seam, 12, 4.1, HINDERNIS_BEDARF)).toBeNull();
  });

  it('refuses an empty profile and a depth that is not one', () => {
    expect(einfuegeTiefeBei([], 12, 4, SOIL)).toBeNull();
    expect(einfuegeTiefeBei(profil, 12, NaN, SOIL)).toBeNull();
  });

  it('always lands on the grid and strictly inside the tapped layer', () => {
    const endTiefe = 11.37; // a drilled depth, not a round number
    for (let tap = 0; tap <= endTiefe; tap += 0.07) {
      const t = einfuegeTiefeBei(profil, endTiefe, tap, SOIL);
      if (t == null) continue;
      expect(Math.round(t * 10), `tap at ${tap}`).toBeCloseTo(t * 10, 6);
      expect(profil.map((s) => s.tiefe), `tap at ${tap}`).not.toContain(t);
      expect(t, `tap at ${tap}`).toBeGreaterThan(0);
      expect(t, `tap at ${tap}`).toBeLessThan(endTiefe);
    }
  });
});

describe('mitIds', () => {
  it('gives an id to every layer that has none', () => {
    _resetIds();
    const mit = mitIds([{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON }]);
    expect(mit.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('leaves an existing id alone, so a selection survives the edit', () => {
    _resetIds();
    const mit = mitIds([
      { tiefe: 0, nr: SAND, id: 'behalten' },
      { tiefe: 3, nr: TON },
    ]);
    expect(mit.map((s) => s.id)).toEqual(['behalten', 's1']);
  });

  it('never hands out an id twice', () => {
    _resetIds();
    const ids = [
      ...mitIds([{ tiefe: 0, nr: SAND }]),
      ...mitIds([{ tiefe: 1, nr: TON }]),
    ].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
