import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { imageDataURI, type GeologieEintrag } from '@coded-aesthetics/din4023';
import {
  GRUPPEN, HINDERNISSE, WAEHLBAR, farbeVon, kurzLabel, nameTeile,
} from '../utils/geologie';
import { sucheEintraege } from '../utils/geologie-suche';

/**
 * The full DIN 4023 vocabulary, reached via "Andere…" from a quick picker.
 *
 * Full-screen rather than a dialog because CLAUDE.md rules modals out — a
 * worker must never be stuck behind one. It covers the screen, every exit is a
 * 64px+ target, and it cannot be reached without a deliberate tap.
 *
 * ── Why tabs, and why they are the load-bearing control ──────
 *
 * This screen is the long tail. The ground an operator actually picks is on
 * the quick picker in the profile column (`GeologieSpalte`), three to five
 * tiles drawn from this element's Schichtauftrag; everything here is for the
 * ground nobody planned for. So the job is completeness and legibility, not
 * speed — the opposite of the column's.
 *
 * It was one flat grid of 33 tiles in eight columns, which is 115px per tile
 * and left about 60px for the name: `Vulk…`, `Blätt…`, `(z. B. Basa…`. A tile
 * whose label names neither the type nor the example is a tile you cannot
 * choose from, and the eight-column grid was also what kept 25 perfectly real
 * ground types off the screen entirely.
 *
 * One table per tab fixes both at once. No tab runs past five rows at four
 * columns, so every tile is wide enough for its whole name, and the catalogue
 * is complete at 58 — obstructions excluded because they have their own
 * picker, where the same tap would record no layer change at all.
 *
 * ── The search field is additive, never the only way ─────────
 *
 * The kiosk autostarts `chromium --kiosk` with no on-screen keyboard, so for a
 * gloved worker the field does nothing today (issue #49 picks one, deferred
 * until we are on the target hardware). That is survivable only because —
 * and only for as long as — the tabs reach every entry on their
 * own: nothing in this catalogue is reachable by typing alone. The field earns
 * its place on a machine with a keyboard — service personnel, and the
 * touchscreen once a keyboard is chosen — and `geologie-suche.ts` is what
 * makes `Löß`, `Loess` and `Loss` all find the same tile.
 */

export type PickerArt = 'schicht' | 'hindernis';

interface Props {
  art: PickerArt;
  /** Shown above the grid: what this choice applies to. */
  untertitel?: string;
  /**
   * Ground types this element's Schichtauftrag names, badged wherever they
   * appear. The quick picker already offered them, so this is not the way to
   * reach them — it is for the operator who tapped "Andere…" by mistake, or
   * who wants to see that the type they are about to pick was in fact planned.
   */
  vorgabeNrs?: readonly number[];
  /** The layer's current ground type, badged "Aktuell". */
  aktiveNr?: number | null;
  onWaehlen: (nr: number, name: string) => void;
  onAbbrechen: () => void;
}

/**
 * Results shown before the screen is asked to scroll.
 *
 * Four columns by four rows. A one-letter query legitimately matches half the
 * catalogue, and the honest answer to that is "narrow it", not a grid running
 * off the bottom of a screen that must not scroll.
 */
const MAX_TREFFER = 16;

/**
 * Columns in the tile grid.
 *
 * Four, because that is what makes the widest tab (Fels, 18 entries, five
 * rows) fit without scrolling while still leaving each tile ~240px — enough
 * for the whole of `Verfestigte vulkanische Aschen` on two lines. Five columns
 * would save a row and lose the names again.
 */
const SPALTEN = 4;

/**
 * Tallest a tile may get, in px.
 *
 * Rows otherwise share the whole column evenly, which is right for a four- or
 * five-row tab and absurd for a search that matched two entries — `Löß` and
 * `Lößlehm` came out as two 600px slabs with their labels floating in the
 * middle. Capping the grid's height rather than the tile's keeps the rule in
 * one place: a tab that needs more than this still gets an even share of
 * whatever is left, because the flex container is the tighter bound.
 */
const ZEILE_MAX = 124;

export function GeologiePicker({
  art, untertitel, vorgabeNrs, aktiveNr, onWaehlen, onAbbrechen,
}: Props) {
  const [gruppe, setGruppe] = useState<string>(GRUPPEN[0].id);
  const [suche, setSuche] = useState('');

  const sucht = suche.trim().length > 0;
  const kandidaten = art === 'hindernis' ? HINDERNISSE : WAEHLBAR;

  const treffer = useMemo(
    () => (sucht ? sucheEintraege(suche, kandidaten) : []),
    [sucht, suche, kandidaten],
  );

  const vorgabe = useMemo(() => new Set(vorgabeNrs ?? []), [vorgabeNrs]);

  // Six obstructions fit a single grid, and there is nothing to tab between.
  if (art === 'hindernis') {
    return (
      <div style={styles.overlay}>
        <Kopf titel="Hindernis wählen" untertitel={untertitel} onAbbrechen={onAbbrechen} />
        <div style={styles.gitterHindernis}>
          {HINDERNISSE.map((e) => (
            <Kachel
              key={e.nr}
              eintrag={e}
              gross
              onClick={() => onWaehlen(e.nr, e.name)}
            />
          ))}
        </div>
      </div>
    );
  }

  const aktiv = GRUPPEN.find((g) => g.id === gruppe) ?? GRUPPEN[0];
  const gezeigt = sucht ? treffer.slice(0, MAX_TREFFER) : [...aktiv.eintraege];
  const weitere = sucht ? treffer.length - gezeigt.length : 0;
  /**
   * Rows pinned to an even share of what is left, rather than sized by their
   * content.
   *
   * `grid-auto-rows` lets a tall tile push the grid past the bottom of a
   * screen that must not scroll — which is exactly what one entry
   * (`Blättrige, feinschichtige Metamorphite …`) did on the five-row Fels tab,
   * taking the whole last row off-screen with it. `minmax(0, 1fr)` cannot
   * overflow whatever the tile holds.
   */
  const zeilen = Math.max(1, Math.ceil(gezeigt.length / SPALTEN));

  return (
    <div style={styles.overlay}>
      <Kopf titel="Bodenart wählen" untertitel={untertitel} onAbbrechen={onAbbrechen} />

      <div style={styles.steuerung}>
        <div style={styles.reiter}>
          {GRUPPEN.map((g) => (
            <button
              key={g.id}
              style={{
                ...styles.reiterKnopf,
                // A search spans every tab, so none of them is current while
                // one is running — a highlighted tab next to results from four
                // tables would be saying something untrue.
                ...(!sucht && g.id === aktiv.id ? styles.reiterAktiv : {}),
              }}
              onClick={() => { setSuche(''); setGruppe(g.id); }}
            >
              {g.titel}
              <span style={styles.reiterZahl}>{g.eintraege.length}</span>
            </button>
          ))}
        </div>

        <div style={styles.sucheFeld}>
          <span style={styles.sucheIkon} aria-hidden>⌕</span>
          <input
            type="text"
            value={suche}
            onChange={(e) => setSuche(e.target.value)}
            placeholder="Suchen…"
            aria-label="Bodenart suchen"
            style={styles.sucheEingabe}
          />
          {sucht && (
            <button
              style={styles.sucheLeeren}
              onClick={() => setSuche('')}
              aria-label="Suche löschen"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {sucht && gezeigt.length === 0 ? (
        <div style={styles.keineTreffer}>
          Keine Bodenart gefunden für „{suche.trim()}“. Bitte anders schreiben
          oder oben über die Gruppen auswählen — dort stehen alle {WAEHLBAR.length} Bodenarten.
        </div>
      ) : (
        <div
          style={{
            ...styles.gitter,
            gridTemplateRows: `repeat(${zeilen}, minmax(0, 1fr))`,
            maxHeight: zeilen * ZEILE_MAX + (zeilen - 1) * 4,
          }}
        >
          {gezeigt.map((e) => (
            <Kachel
              key={e.nr}
              eintrag={e}
              vorgabe={vorgabe.has(e.nr)}
              aktuell={e.nr === aktiveNr}
              onClick={() => onWaehlen(e.nr, e.name)}
            />
          ))}
        </div>
      )}

      {weitere > 0 && (
        <div style={styles.weitere}>
          {weitere} weitere Treffer — Suchbegriff ergänzen, um sie zu sehen.
        </div>
      )}
    </div>
  );
}

function Kopf({
  titel, untertitel, onAbbrechen,
}: { titel: string; untertitel?: string; onAbbrechen: () => void }) {
  return (
    <div style={styles.kopf}>
      {/*
        Title and target on one line. Stacked they cost 72px of a budget the
        five-row Fels tab spends entirely on tile height, and `Bodenart wählen
        · Schicht ab 18,30 m` reads as one sentence anyway.
      */}
      <span style={styles.titel}>{titel}</span>
      {untertitel && <span style={styles.untertitel}>{untertitel}</span>}
      <span style={styles.schub} />
      <button style={styles.abbrechen} onClick={onAbbrechen}>Abbrechen</button>
    </div>
  );
}

function Kachel({
  eintrag, gross, vorgabe, aktuell, onClick,
}: {
  eintrag: GeologieEintrag;
  gross?: boolean;
  vorgabe?: boolean;
  aktuell?: boolean;
  onClick: () => void;
}) {
  const hatch = imageDataURI(eintrag);
  const roh = eintrag.tabelle === 'Hindernis'
    ? eintrag.name.replace(/^Hindernis\s+/i, '')
    : eintrag.name;
  const { haupt, hinweis } = nameTeile(roh);

  const symbol = (
    <span
      style={{
        ...(gross ? styles.symbolGross : styles.symbol),
        backgroundColor: farbeVon(eintrag.nr),
        ...(hatch
          ? { backgroundImage: `url(${hatch})`, backgroundSize: 'cover' }
          : {}),
      }}
    />
  );

  const marker = (aktuell || vorgabe) && (
    <span style={styles.marker}>
      {aktuell && <span style={styles.markerAktuell}>Aktuell</span>}
      {vorgabe && <span style={styles.markerVorgabe}>Vorgabe</span>}
    </span>
  );

  if (gross) {
    return (
      <button style={styles.kachelGross} onClick={onClick}>
        {symbol}
        <span style={styles.kachelTextGross}>
          <span style={styles.kurz}>{kurzLabel(eintrag.nr)}</span>
          <span style={styles.name}>{haupt}</span>
          {hinweis && <span style={styles.hinweis}>{hinweis}</span>}
        </span>
      </button>
    );
  }

  /*
    The symbol floats rather than sitting in its own flex column, so the name
    runs the full width of the tile once it has cleared it. In a column the
    name only ever gets ~178px of a 242px tile, which is the difference
    between `Blättrige, feinschichtige Metamorphite` on two lines and on
    three — and three is what pushed the Fels tab's last row off-screen.
  */
  return (
    <button
      style={{ ...styles.kachel, ...(aktuell ? styles.kachelAktuell : {}) }}
      onClick={onClick}
    >
      <span style={styles.symbolFliessend}>{symbol}</span>
      <span style={styles.kurz}>{kurzLabel(eintrag.nr)}</span>
      {/*
        The bracketed part on its own line, one size down. `Vulkanite
        (z. B. Basalt)` is a type plus an example, and drawn as one string it
        either wraps to four lines or gets cut mid-word — which is how a tile
        came to read `(z. B. Basa…` and name neither.
      */}
      <span style={styles.name}>{haupt}</span>
      {hinweis && <span style={styles.hinweis}>{hinweis}</span>}
      {marker}
    </button>
  );
}

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 500,
    backgroundColor: 'var(--surface-1)',
    display: 'flex',
    flexDirection: 'column',
    // Tighter vertically than horizontally: the 1024x768 budget is spent on
    // tile height, and the Fels tab's five rows need every pixel of it.
    padding: 'var(--space-sm) var(--space-md)',
    gap: 'var(--space-sm)',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  kopf: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    flexShrink: 0,
  },
  schub: { flex: 1 },
  titel: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
    whiteSpace: 'nowrap',
  },
  untertitel: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  abbrechen: {
    minWidth: 180,
    minHeight: 'var(--tap-min)',
    flexShrink: 0,
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },

  // ── Tabs and search ──────────────────────────────────────
  steuerung: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 'var(--space-sm)',
    flexShrink: 0,
  },
  reiter: {
    display: 'flex',
    gap: 'var(--space-xs)',
    flex: 1,
    minWidth: 0,
  },
  reiterKnopf: {
    flex: 1,
    minHeight: 'var(--tap-min)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.4rem',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  reiterAktiv: {
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    fontWeight: 800,
  },
  reiterZahl: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  sucheFeld: {
    width: 260,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-xs)',
    paddingLeft: 'var(--space-sm)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    boxSizing: 'border-box',
  },
  sucheIkon: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  sucheEingabe: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
  },
  sucheLeeren: {
    width: 'var(--tap-min)',
    alignSelf: 'stretch',
    flexShrink: 0,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },

  // ── Grid ─────────────────────────────────────────────────
  gitter: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: `repeat(${SPALTEN}, 1fr)`,
    // Rows tighter than columns: four row gaps at 8px cost each of the five
    // Fels rows 3px, which is exactly what the tallest tile in the catalogue
    // was short of. The tiles carry borders, so they stay distinct at 4px.
    gap: 'var(--space-xs) var(--space-sm)',
    alignContent: 'stretch',
  },
  gitterHindernis: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridAutoRows: 'minmax(var(--tap-min), 1fr)',
    gap: 'var(--space-md)',
  },
  kachel: {
    display: 'block',
    minHeight: 'var(--tap-min)',
    // 6px rather than 8 top and bottom. Measured, not chosen: the tallest
    // entry in the catalogue (Meb, a three-line name plus its examples) needs
    // 114px and the five-row Fels tab gives a tile 115.
    padding: '6px var(--space-sm)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    overflow: 'hidden',
  },
  kachelGross: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    minHeight: 110,
    padding: 'var(--space-md)',
    border: '2px solid var(--color-warning)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-warning-tint)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  kachelAktuell: {
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
  },
  symbol: {
    display: 'block',
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  symbolFliessend: {
    float: 'left',
    marginRight: 'var(--space-sm)',
  },
  symbolGross: {
    width: 56,
    height: 56,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  kachelTextGross: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  kurz: {
    display: 'block',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  /**
   * The whole name, wrapped. No ellipsis and no `nowrap`: a ground type the
   * operator cannot read is a ground type they cannot pick, and this screen
   * exists precisely for the ones they do not already know by their Kurzform.
   */
  name: {
    display: 'block',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    lineHeight: 1.12,
    overflowWrap: 'anywhere',
  },
  hinweis: {
    // The kiosk minimum. It is an example, not decoration — it is what tells
    // `Vulkanite` from `Plutonite` for anyone who does not know the words.
    // Clamped at two lines, and it is the only text here that may be: the
    // type's own name is never cut, and `z. B. Glimmerschiefer, Phyllit` has
    // said what it is for long before it runs out.
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical' as CSSProperties['WebkitBoxOrient'],
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.15,
    overflowWrap: 'anywhere',
  },
  marker: {
    display: 'flex',
    gap: '0.4rem',
    fontSize: 'var(--font-sm)',
    fontWeight: 800,
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
  },
  markerAktuell: { color: 'var(--color-accent-strong)' },
  markerVorgabe: { color: 'var(--text-muted)' },

  keineTreffer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    maxWidth: '50ch',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  weitere: {
    flexShrink: 0,
    textAlign: 'center',
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
};
