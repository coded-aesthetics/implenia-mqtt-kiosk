import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { CSSProperties } from 'react';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import {
  RASTER, entferneSchicht, fuegeHindernisEin, fuegeSchichtEin, runde, setzeGrenze,
  type Schicht,
} from '@coded-aesthetics/din4023/profile';
import { formatNumber } from '../utils/format';
import {
  einfuegeTiefe, farbeVon, istHindernis, kurzLabel, nameVon, vomServer,
  zumCommit, type Profil,
} from '../utils/geologie';
import { GeologiePicker, type PickerArt } from './GeologiePicker';

/**
 * The geology profile the operator signs off before the data goes up.
 *
 * This is the backstop for the one failure that no live reminder fixes:
 * operators routinely forget to record a layer change at all. Rather than
 * nagging during drilling, every stop that followed real drilling ends here
 * once — with the layers they confirmed already in place and the Schichtauftrag
 * filling the stretches they did not, drawn dashed so the difference is
 * visible.
 *
 * Not a gate and not a dialog. Two exits, both of which leave the operator
 * somewhere useful:
 *
 * — **Beenden** commits the profile, stops the recording, and the auto-upload
 *   proceeds exactly as it always has.
 * — **Zurück zur Aufzeichnung** commits nothing and keeps recording, for a
 *   mis-tap.
 *
 * A PM2 restart on this screen leaves the session open, `resumeRecording`
 * re-attaches it, and the operator taps Beenden again — no dead end, nothing
 * lost.
 */

/**
 * Thickness an obstruction added on this screen starts at, in metres.
 *
 * Deliberately a starting point rather than a question: the operator drags it
 * to where it was. Two grid steps, so both its edges are grabbable in
 * `vollbild` without first having to make it thicker.
 */
const NEUES_HINDERNIS_DICKE = 0.2;

/**
 * How much room an insert of each kind needs.
 *
 * An obstruction is bounded, so it needs its own thickness plus a layer either
 * side of it; a soil layer only has to leave a step. Sharing the soil figure
 * let the obstruction button enable for an insert that swallowed the layer.
 */
function platzBedarf(kind: PickerArt): number {
  return kind === 'hindernis' ? NEUES_HINDERNIS_DICKE + 2 * RASTER : 2 * RASTER;
}

interface GeologyContext {
  verfuegbar: boolean;
  gebohrt: boolean;
  gebohrteTiefe: number;
  maxTiefe: number;
  /**
   * The profile the server would commit on its own — observations with the
   * Vorgabe filling what was never confirmed. This screen edits it; it does not
   * derive its own, because a stop that never reached this screen commits the
   * same thing.
   */
  profil: { schichten: { tiefe: number; nr: number; quelle: 'ist' | 'vorgabe' }[]; endTiefe: number } | null;
  hinweis?: string;
}

interface Props {
  sessionId: number | null;
  elementName?: string;
  /** Commit and stop. Resolves to an error message, or null on success. */
  onBeenden: (layers: ReturnType<typeof zumCommit>) => Promise<string | null>;
  /** Leave without committing; the recording continues. */
  onZurueck: () => void;
}

/** Which layer the picker is editing, or a kind of layer being appended. */
type PickerZiel =
  | { art: 'typ'; index: number }
  | { art: 'neu'; kind: PickerArt; tiefe: number };

export function GeologieBestaetigung({
  sessionId, elementName, onBeenden, onZurueck,
}: Props) {
  const [profil, setProfil] = useState<Profil | null>(null);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [ziel, setZiel] = useState<PickerZiel | null>(null);
  /**
   * The row whose delete is armed, if any.
   *
   * CLAUDE.md's tap-to-confirm: the first tap turns the whole row into the
   * confirm target rather than growing a small yes/no pair, and a tap anywhere
   * else disarms it. Held here rather than per-row so that arming one row
   * disarms another.
   */
  const [loeschIndex, setLoeschIndex] = useState<number | null>(null);
  const [sendet, setSendet] = useState(false);

  const [chartRef, chartHoehe] = useMeasuredHeight();

  // Load the context and build the profile to present. Deliberately not
  // retried in a loop: if this cannot be read, the operator still has Beenden,
  // which stops and uploads without a profile.
  useEffect(() => {
    if (sessionId === null) {
      setLaden(false);
      setFehler('Keine Aufzeichnung gefunden.');
      return;
    }
    let abgebrochen = false;
    fetch(`/api/recording/${sessionId}/geology-context`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Fehler ${r.status}`);
        return r.json() as Promise<GeologyContext>;
      })
      .then((ctx) => {
        if (abgebrochen) return;
        setProfil(vomServer(ctx.profil));
        if (ctx.hinweis) setHinweis(ctx.hinweis);
        setLaden(false);
      })
      .catch((err: Error) => {
        if (abgebrochen) return;
        setFehler(
          `Das Geologieprofil konnte nicht geladen werden: ${err.message}. `
          + 'Die Aufzeichnung lässt sich trotzdem beenden — die Messwerte sind vollständig.',
        );
        setLaden(false);
      });
    return () => { abgebrochen = true; };
  }, [sessionId]);

  const schichten = profil?.schichten ?? [];
  const endTiefe = profil?.endTiefe ?? 1;

  const aendern = useCallback((naechste: Schicht[]) => {
    setProfil((p) => (p ? { ...p, schichten: naechste } : p));
  }, []);

  /**
   * A boundary the operator dragged is one they looked at, so it stops being an
   * assumption.
   *
   * The drag reports the whole list, not which layer moved, so the moved ones
   * are the layers sitting at a depth no layer held before. The flag describes
   * exactly one boundary — a layer's own start — so clearing it on those and
   * nothing else is what "they confirmed this boundary, not the ones below it"
   * means.
   */
  const onSchichtenChange = useCallback((naechste: Schicht[]) => {
    setProfil((p) => {
      if (!p) return p;
      const vorher = new Set(p.schichten.map((s) => s.tiefe));
      return {
        ...p,
        schichten: naechste.map((s) =>
          vorher.has(s.tiefe) ? s : { ...s, vorlaeufig: false }),
      };
    });
  }, []);

  function verschiebeGrenze(index: number, schritte: number) {
    if (index === 0) return;
    const neueTiefe = runde(schichten[index].tiefe + schritte * RASTER);
    // Clear the flag on the way in rather than on the result: indexing the
    // input is correct whatever reshaping setzeGrenze does on the way out.
    const bestaetigt = schichten.map((s, i) =>
      (i === index ? { ...s, vorlaeufig: false } : s));
    aendern(setzeGrenze(bestaetigt, endTiefe, index, neueTiefe));
  }

  function waehleTyp(nr: number) {
    if (!ziel) return;
    if (ziel.art === 'typ') {
      // A boundary already at this depth is re-typed, not duplicated.
      aendern(fuegeSchichtEin(
        schichten, endTiefe, schichten[ziel.index].tiefe, nr, { vorlaeufig: false },
      ));
    } else if (ziel.kind === 'hindernis') {
      // An obstruction is a claim about one stretch of hole, not "from here
      // down": inserting it bounded leaves the ground resuming underneath,
      // which is both what was seen and what the uploaded series carries.
      aendern(fuegeHindernisEin(
        schichten, endTiefe, ziel.tiefe, nr, NEUES_HINDERNIS_DICKE, { vorlaeufig: false },
      ));
    } else {
      aendern(fuegeSchichtEin(schichten, endTiefe, ziel.tiefe, nr, { vorlaeufig: false }));
    }
    setZiel(null);
  }

  function entferne(index: number) {
    aendern(entferneSchicht(schichten, endTiefe, index));
    setLoeschIndex(null);
  }

  /**
   * Add a layer, or an obstruction, in the middle of the thickest layer.
   *
   * The depth is chosen rather than asked for — see einfuegeTiefe. The picker
   * opens straight away, because an operator asking for a layer already knows
   * what it is; the steppers move it afterwards.
   */
  function fuegeEin(kind: PickerArt) {
    const tiefe = einfuegeTiefe(schichten, endTiefe, platzBedarf(kind));
    if (tiefe == null) return;
    setLoeschIndex(null);
    setZiel({ art: 'neu', kind, tiefe });
  }

  async function beenden() {
    setSendet(true);
    const err = await onBeenden(profil ? zumCommit(profil.schichten) : []);
    if (err) {
      setFehler(err);
      setSendet(false);
    }
    // On success the recording state changes and the caller navigates away.
  }

  const offeneGrenzen = useMemo(
    () => schichten.filter((s) => s.vorlaeufig && s.tiefe > 0).length,
    [schichten],
  );

  if (ziel) {
    const kind: PickerArt = ziel.art === 'neu'
      ? ziel.kind
      : istHindernis(schichten[ziel.index]?.nr ?? 0) ? 'hindernis' : 'schicht';
    const untertitel = ziel.art === 'typ'
      ? `Schicht ab ${formatNumber(schichten[ziel.index].tiefe)} m`
      : `Neue Schicht ab ${formatNumber(ziel.tiefe)} m`;
    return (
      <GeologiePicker
        art={kind}
        untertitel={untertitel}
        onWaehlen={waehleTyp}
        onAbbrechen={() => setZiel(null)}
      />
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.kopf}>
        <div style={styles.titelSpalte}>
          <span style={styles.titel}>Geologie bestätigen</span>
          <span style={styles.untertitel}>
            {elementName ? `${elementName} — ` : ''}
            {offeneGrenzen > 0
              ? `${offeneGrenzen} Grenze(n) aus der Vorgabe übernommen (gestrichelt)`
              : 'Alle Grenzen während der Herstellung erfasst'}
          </span>
        </div>
        <div style={styles.aktionen}>
          {/*
            Deliberately not disabled while the stop is in flight. It only
            navigates, and if the request never answers this is the only way off
            a screen whose other control is dead — "error states must be
            recoverable", and a screen with two dead buttons is a dead end.
          */}
          <button style={styles.zurueck} onClick={onZurueck}>
            Zurück zur Aufzeichnung
          </button>
          <button style={styles.beenden} onClick={beenden} disabled={sendet}>
            {sendet ? 'Wird beendet…' : 'Beenden'}
          </button>
        </div>
      </div>

      {fehler && <div style={styles.fehler}>{fehler}</div>}
      {hinweis && !fehler && <div style={styles.hinweis}>{hinweis}</div>}

      {laden && <div style={styles.leer}>Geologieprofil wird geladen…</div>}

      {!laden && !profil && (
        <div style={styles.leer}>
          Für dieses Element liegt kein Geologieprofil vor. Mit „Beenden" wird die
          Aufzeichnung ohne Geologie abgeschlossen.
        </div>
      )}

      {!laden && profil && (
        <div style={styles.layout}>
          <div ref={chartRef} style={styles.chartSpalte}>
            <BohrprofilLog
              schichten={schichten}
              endTiefe={endTiefe}
              breite={300}
              hoehe={chartHoehe > 0 ? chartHoehe : 400}
              modus="vollbild"
              editierbar
              beruehrungsmodus
              onSchichtenChange={onSchichtenChange}
              styleOverrides={chartStyles}
            />
          </div>

          <div style={styles.listeSpalte}>
            <div
              style={{
                ...styles.liste,
                gridTemplateColumns: `repeat(${schichten.length > 7 ? 2 : 1}, 1fr)`,
                gridTemplateRows: `repeat(${Math.ceil(schichten.length / (schichten.length > 7 ? 2 : 1))}, minmax(var(--tap-min), 1fr))`,
              }}
            >
              {schichten.map((s, i) => (
                <SchichtZeile
                  key={`${s.id ?? ''}-${i}-${s.tiefe}`}
                  schicht={s}
                  istErste={i === 0}
                  // The last layer standing cannot go: a profile with no layers
                  // is not a profile.
                  loeschbar={schichten.length > 1}
                  loeschBereit={loeschIndex === i}
                  onTyp={() => { setLoeschIndex(null); setZiel({ art: 'typ', index: i }); }}
                  onMinus={() => { setLoeschIndex(null); verschiebeGrenze(i, -1); }}
                  onPlus={() => { setLoeschIndex(null); verschiebeGrenze(i, +1); }}
                  onLoeschen={() => setLoeschIndex(i)}
                  onLoeschenBestaetigen={() => entferne(i)}
                />
              ))}
            </div>
            <div style={styles.hinzuReihe}>
              <button
                style={styles.hinzu}
                onClick={() => fuegeEin('schicht')}
                disabled={einfuegeTiefe(schichten, endTiefe, platzBedarf('schicht')) == null}
              >
                + Schicht
              </button>
              <button
                style={styles.hinzuHindernis}
                onClick={() => fuegeEin('hindernis')}
                disabled={einfuegeTiefe(schichten, endTiefe, platzBedarf('hindernis')) == null}
              >
                + Hindernis
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SchichtZeile({
  schicht, istErste, loeschbar, loeschBereit,
  onTyp, onMinus, onPlus, onLoeschen, onLoeschenBestaetigen,
}: {
  schicht: Schicht;
  istErste: boolean;
  loeschbar: boolean;
  loeschBereit: boolean;
  onTyp: () => void;
  onMinus: () => void;
  onPlus: () => void;
  onLoeschen: () => void;
  onLoeschenBestaetigen: () => void;
}) {
  const hindernis = istHindernis(schicht.nr);

  // Armed: the whole row becomes the confirm target, rather than growing a
  // small yes/no pair a gloved hand cannot hit. Tapping any other control
  // disarms it.
  if (loeschBereit) {
    return (
      <button style={styles.zeileLoeschen} onClick={onLoeschenBestaetigen}>
        {nameVon(schicht.nr)} ab {formatNumber(schicht.tiefe)} m — wirklich entfernen?
      </button>
    );
  }

  return (
    <div style={styles.zeile}>
      <button style={styles.typ} onClick={onTyp}>
        <span
          style={{
            ...styles.swatch,
            backgroundColor: farbeVon(schicht.nr),
            ...(hindernis ? { border: '2px solid var(--color-warning)' } : {}),
          }}
        />
        <span style={styles.typText}>
          <span style={styles.typKurz}>
            {kurzLabel(schicht.nr)}
            <span style={styles.typName}> {nameVon(schicht.nr)}</span>
          </span>
          <span style={styles.typTiefe}>
            {istErste ? 'ab 0,00 m' : `ab ${formatNumber(schicht.tiefe)} m`}
            {schicht.vorlaeufig && <span style={styles.vorlaeufig}> Vorgabe</span>}
          </span>
        </span>
      </button>

      {!istErste && (
        <>
          <button style={styles.schritt} onClick={onMinus} aria-label="Grenze nach oben">−</button>
          <button style={styles.schritt} onClick={onPlus} aria-label="Grenze nach unten">+</button>
        </>
      )}

      {loeschbar && (
        <button
          style={styles.loeschen}
          onClick={onLoeschen}
          aria-label={`${nameVon(schicht.nr)} entfernen`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

const chartStyles = {
  depthTick: { color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 } as CSSProperties,
  depthLine: { borderTopColor: 'var(--text-primary)' } as CSSProperties,
  label: { fontSize: 15, fontWeight: 700 } as CSSProperties,
};

const styles: Record<string, CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    padding: 'var(--space-md)',
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
  titelSpalte: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  titel: {
    fontSize: 'var(--font-lg)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  untertitel: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  aktionen: { display: 'flex', gap: 'var(--space-sm)', flexShrink: 0 },
  zurueck: {
    minWidth: 240,
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-md)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  beenden: {
    minWidth: 200,
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-lg)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-success)',
    color: '#fff',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  fehler: {
    flexShrink: 0,
    padding: 'var(--space-sm) var(--space-md)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-danger-tint)',
    color: 'var(--color-danger-strong)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    lineHeight: 1.3,
  },
  hinweis: {
    flexShrink: 0,
    padding: 'var(--space-sm) var(--space-md)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-warning-tint)',
    color: 'var(--color-warning-text)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    lineHeight: 1.3,
  },
  leer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  },
  layout: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 'var(--space-md)',
  },
  chartSpalte: {
    width: 330,
    flexShrink: 0,
    minHeight: 0,
    paddingTop: 'var(--space-sm)',
    paddingBottom: 'var(--space-md)',
  },
  listeSpalte: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
  },
  /**
   * The one place in the app that scrolls, and deliberately.
   *
   * Two columns of 64px targets hold about fourteen rows in this column's
   * height. A profile can exceed that — four planned layers plus six recorded
   * obstructions is sixteen boundaries — and before this the surplus rows were
   * simply **below the fold: invisible, untappable, and with no scrollbar to
   * admit it**, on the one screen whose job is correcting the profile. Rows the
   * operator cannot reach are rows they cannot fix.
   *
   * Scrolling a dense editing list is the lesser evil against hiding data, and
   * it is contained to this column — the page itself never scrolls, the chart
   * and both exits stay put. The screen still wants a better answer than a
   * scrollbar for twenty layers; this stops it losing them in the meantime.
   */
  liste: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridAutoFlow: 'column',
    gap: 'var(--space-sm)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  zeile: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-xs)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
  },
  typ: {
    flex: 1,
    minWidth: 0,
    // 64, not 56: this is the row's main target and the rule is 64px for gloves.
    minHeight: 'var(--tap-min)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    padding: '0 var(--space-sm)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  swatch: {
    width: 28,
    height: 28,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  typText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  typKurz: {
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  typName: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Armed for deletion: the whole row, in danger red, is the confirm target. */
  zeileLoeschen: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-sm)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    lineHeight: 1.2,
  },
  loeschen: {
    width: 'var(--tap-min)',
    height: 'var(--tap-min)',
    flexShrink: 0,
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-danger)',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    lineHeight: 1,
    cursor: 'pointer',
  },
  hinzuReihe: {
    display: 'flex',
    gap: 'var(--space-sm)',
    flexShrink: 0,
  },
  hinzu: {
    flex: 1,
    minHeight: 'var(--tap-min)',
    border: '2px dashed var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  hinzuHindernis: {
    flex: 1,
    minHeight: 'var(--tap-min)',
    border: '2px dashed var(--color-warning)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--color-warning-text)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  typTiefe: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  tiefeGruppe: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-xs)',
    flexShrink: 0,
  },
  schritt: {
    width: 'var(--tap-min)',
    height: 'var(--tap-min)',
    flexShrink: 0,
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    lineHeight: 1,
    cursor: 'pointer',
  },
  tiefeWert: {
    minWidth: 104,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
  },
  tiefeFest: {
    minWidth: 104,
    textAlign: 'center',
    paddingRight: 'calc(var(--tap-min) + var(--space-xs))',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  vorlaeufig: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--color-warning-text)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
};
