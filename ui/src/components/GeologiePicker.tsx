import type { CSSProperties } from 'react';
import { imageDataURI, type GeologieEintrag } from '@coded-aesthetics/din4023';
import { BODENARTEN, FELSARTEN, HINDERNISSE, farbeVon, kurzLabel } from '../utils/geologie';

/**
 * The ground-type picker: a full-screen grid of tiles, one tap to choose.
 *
 * Full-screen rather than a dialog because CLAUDE.md rules modals out — a
 * worker must never be stuck behind one. It covers the screen, every exit is a
 * 64px+ target, and it cannot be reached without a deliberate tap.
 *
 * A closed vocabulary with no text entry: the operator is wearing gloves. Each
 * tile carries the DIN 4023 hatch symbol next to its Kurzform, so it matches
 * what the profile beside it draws — which is how someone who reads these
 * charts recognises a tile without reading its name.
 */

export type PickerArt = 'schicht' | 'hindernis';

interface Props {
  art: PickerArt;
  /** Shown above the grid: what this choice applies to. */
  untertitel?: string;
  onWaehlen: (nr: number, name: string) => void;
  onAbbrechen: () => void;
  /**
   * Offered only when an existing layer is being changed. Tap-to-confirm, like
   * every other destructive action in this app.
   */
  onEntfernen?: () => void;
  entfernenBestaetigt?: boolean;
}

interface Sektion {
  titel: string;
  eintraege: GeologieEintrag[];
}

export function GeologiePicker({
  art, untertitel, onWaehlen, onAbbrechen, onEntfernen, entfernenBestaetigt,
}: Props) {
  const sektionen: Sektion[] = art === 'hindernis'
    ? [{ titel: 'Hindernis', eintraege: HINDERNISSE }]
    : [
      { titel: 'Bodenarten', eintraege: BODENARTEN },
      { titel: 'Felsarten', eintraege: FELSARTEN },
    ];

  return (
    <div style={styles.overlay}>
      <div style={styles.kopf}>
        <div style={styles.titelSpalte}>
          <span style={styles.titel}>
            {art === 'hindernis' ? 'Hindernis wählen' : 'Bodenart wählen'}
          </span>
          {untertitel && <span style={styles.untertitel}>{untertitel}</span>}
        </div>
        <button style={styles.abbrechen} onClick={onAbbrechen}>Abbrechen</button>
      </div>

      <div style={styles.sektionen}>
        {sektionen.map((s) => (
          <div key={s.titel} style={styles.sektion}>
            {sektionen.length > 1 && <div style={styles.sektionTitel}>{s.titel}</div>}
            <div style={art === 'hindernis' ? styles.gitterWeit : styles.gitter}>
              {s.eintraege.map((e) => (
                <Kachel
                  key={e.nr}
                  eintrag={e}
                  gross={art === 'hindernis'}
                  onClick={() => onWaehlen(e.nr, e.name)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {onEntfernen && (
        <button
          style={{
            ...styles.entfernen,
            ...(entfernenBestaetigt ? styles.entfernenBestaetigt : {}),
          }}
          onClick={onEntfernen}
        >
          {entfernenBestaetigt ? 'Wirklich entfernen?' : 'Schicht entfernen'}
        </button>
      )}
    </div>
  );
}

function Kachel({
  eintrag, gross, onClick,
}: { eintrag: GeologieEintrag; gross: boolean; onClick: () => void }) {
  const hatch = imageDataURI(eintrag);

  return (
    <button style={gross ? styles.kachelGross : styles.kachel} onClick={onClick}>
      <span
        style={{
          ...styles.symbol,
          backgroundColor: farbeVon(eintrag.nr),
          ...(hatch
            ? { backgroundImage: `url(${hatch})`, backgroundSize: 'cover' }
            : {}),
        }}
      />
      <span style={styles.kachelText}>
        <span style={styles.kurz}>{kurzLabel(eintrag.nr)}</span>
        <span style={styles.name}>
          {eintrag.tabelle === 'Hindernis'
            ? eintrag.name.replace(/^Hindernis\s+/i, '')
            : eintrag.name}
        </span>
      </span>
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
    padding: 'var(--space-md)',
    gap: 'var(--space-sm)',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  kopf: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-md)',
    flexShrink: 0,
  },
  titelSpalte: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  titel: {
    fontSize: 'var(--font-lg)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  untertitel: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    fontWeight: 600,
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
  sektionen: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
  },
  sektion: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-xs)',
    minHeight: 0,
  },
  sektionTitel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    flexShrink: 0,
  },
  gitter: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 1fr)',
    gap: 'var(--space-sm)',
  },
  gitterWeit: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 'var(--space-md)',
  },
  kachel: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-sm)',
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
  symbol: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  kachelText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  kurz: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  name: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    fontWeight: 600,
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  entfernen: {
    minHeight: 'var(--tap-min)',
    flexShrink: 0,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-danger)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  entfernenBestaetigt: {
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
  },
};
