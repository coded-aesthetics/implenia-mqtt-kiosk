import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { CSSProperties } from 'react';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import {
  RASTER, entferneSchicht, fuegeHindernisEin, fuegeSchichtEin, grundBei, runde,
  setzeGrenze, type Auswahl, type Schicht,
} from '@coded-aesthetics/din4023/profile';
import { formatNumber } from '../utils/format';
import {
  HINDERNISSE, WAEHLBAR, einfuegeTiefeBei, farbeVon, istHindernis, kurzLabel,
  mitIds, nameVon, neueId, spaltenKandidaten, vomServer, vorgabeArten, zumCommit,
  type Profil,
} from '../utils/geologie';
import { GeologiePicker, type PickerArt } from './GeologiePicker';
import { GeologieSpalte } from './GeologieSpalte';

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
 *
 * ── The chart is the index ───────────────────────────────────
 *
 * The operator taps a layer in the profile and edits it in the panel beside it.
 * There was a row of controls per layer here before, which does not survive a
 * real profile: four controls is 192px of buttons, so a row cannot shrink below
 * about 408px and two columns of them need 824px of a column that has 646px at
 * 1024x768. The second column was cut off — on the one screen whose job is
 * correcting the profile, with no scrollbar to admit it. A scrollbar was the
 * stopgap; neither it nor pagination is an answer, because a layer the operator
 * never scrolled to is a layer they cannot fix.
 *
 * One panel pays for those controls once. The chart holds twenty layers in the
 * same column it holds four — `modus="vollbild"` floors every layer at 32px —
 * so it is the one representation that structurally cannot lose one.
 *
 * ── Tap and drag on the same targets ─────────────────────────
 *
 * Both are on. A tap selects, a drag moves what it grabbed — and they share
 * every target, because there is nowhere else to put the tap: a boundary
 * handle is centred on its boundary and 64px tall for gloves, so it claims
 * 32px either side, and any layer under ~64px tall is drag target from edge to
 * edge. In `vollbild` that is guaranteed for exactly the thin layers most in
 * need of correction, so "tap the body, drag the handle" would leave them
 * selectable only by accident.
 *
 * What makes sharing safe is that a press takes hold of nothing until it has
 * travelled the tap threshold (`istZug` in the din4023 package). Inside it
 * nothing moves, so a tap never shows an edit it is about to take back, and a
 * boundary cannot be nudged by a press that was meant as a tap — the silent
 * change that matters most on the screen that decides the committed profile.
 *
 * The panel is still the way to make a small, exact change: 10 cm steps where
 * a drag would be a guess, and 1 m steps for a boundary that turned out metres
 * from where it was planned. Insertion does not need either, because a new
 * layer is born at the depth the operator pointed at.
 */

/**
 * Thickness an obstruction added on this screen starts at, in metres.
 *
 * Deliberately a starting point rather than a question: the operator taps where
 * it was and adjusts its edges from the panel. Two grid steps, so it reads as a
 * seam rather than a layer from the moment it appears.
 */
const NEUES_HINDERNIS_DICKE = 0.2;

/** Coarse and fine steps the boundary steppers move by, in metres. */
const SCHRITT_FEIN = RASTER;
const SCHRITT_GROB = 1;

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

/** "Neues Hindernis", not "Neue Hindernis" — the article follows the gender. */
function neuLabel(kind: PickerArt): string {
  return kind === 'hindernis' ? 'Neues Hindernis' : 'Neue Schicht';
}

/** All six obstruction kinds — few enough that the column shows them all. */
const HINDERNIS_NRS = HINDERNISSE.map((e) => e.nr);

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
  /**
   * The planned profile from the Schichtauftrag, as `vorgabe-geology.ts`
   * parsed it.
   *
   * Already in the response — this screen simply never read it. It is what
   * makes the quick picker possible: the three to five soils that can
   * plausibly occur in *this* hole, rather than 58 ways to mis-tap.
   */
  vorgabe: { schichten: { tiefe: number; nr: number }[]; endTiefe: number } | null;
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
  /** The planned layers, for the quick picker and its "Vorgabe" marker. */
  const [vorgabeSchichten, setVorgabeSchichten] = useState<Schicht[]>([]);
  /**
   * Whether the full DIN catalogue is open on top of the quick picker.
   *
   * Two levels, exactly as the drilling screen has them: the column offers
   * what this element's Schichtauftrag names, and "Andere…" opens all 58 for
   * the ground nobody planned for. Separate from `ziel` because escalating
   * must not lose which layer is being retyped.
   */
  const [vollbild, setVollbild] = useState(false);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [ziel, setZiel] = useState<PickerZiel | null>(null);
  /**
   * The selected layer, held by id rather than index.
   *
   * Every edit reshuffles indices — an insert shifts everything below it, a
   * delete closes a gap, and two adjacent layers of one ground type merge into
   * the shallower one — so an index kept across an edit points at a different
   * layer than the operator selected, and the panel beside it would edit that
   * one. See `mitIds`.
   */
  const [auswahlId, setAuswahlId] = useState<string | null>(null);
  /** The kind of insert waiting for a depth, if the operator armed one. */
  const [einfuegen, setEinfuegen] = useState<PickerArt | null>(null);
  /**
   * Whether the selected layer's delete is armed.
   *
   * CLAUDE.md's tap-to-confirm: the first tap turns the whole button into the
   * confirm target rather than growing a small yes/no pair, and a tap on
   * anything else disarms it. One flag rather than per-layer, because selecting
   * another layer has to disarm it too — on a screen where a 32px layer can be
   * mis-tapped, a delete that stayed armed across a selection change would be
   * one stray tap from removing the wrong layer.
   */
  const [loeschBereit, setLoeschBereit] = useState(false);
  /** Why the last tap did not insert anything. Cleared by the next one. */
  const [meldung, setMeldung] = useState<string | null>(null);
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
    // The recording state arrives over the websocket, so the first render can
    // legitimately have no session yet. Clearing on the way in is what keeps
    // that first render's "Keine Aufzeichnung gefunden." from staying on screen
    // under a profile that loaded perfectly well a moment later.
    setFehler(null);
    let abgebrochen = false;
    fetch(`/api/recording/${sessionId}/geology-context`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Fehler ${r.status}`);
        return r.json() as Promise<GeologyContext>;
      })
      .then((ctx) => {
        if (abgebrochen) return;
        const geladen = vomServer(ctx.profil);
        setProfil(geladen && { ...geladen, schichten: mitIds(geladen.schichten) });
        setVorgabeSchichten(ctx.vorgabe?.schichten ?? []);
        /*
          Everything pointing into the old profile goes with it.

          A reload replaces the layers and mints fresh ids, so a selection held
          by id stops resolving and a `ziel` held by *index* starts resolving
          to a different layer than the operator tapped — which would leave an
          open picker quietly retyping the wrong one. `vollbild` is the worse
          half: it would survive with no `wahl` under it and latch, so the next
          "Bodenart ändern" opened the 58-entry catalogue directly, skipping
          the quick column for the rest of the session.

          This only fires when `sessionId` changes — a websocket reconnect that
          drops it and brings it back — so it is not clearing state out from
          under an operator mid-edit on the ordinary path.
        */
        setZiel(null);
        setVollbild(false);
        setEinfuegen(null);
        setAuswahlId(null);
        setLoeschBereit(false);
        setMeldung(null);
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

  /**
   * Every edit lands here, and every edit tops the ids up.
   *
   * The package preserves an id through its operations, but a layer born from a
   * split carries none — it is new profile, not a continuation — which is
   * exactly what inserting an obstruction into a layer produces.
   */
  const aendern = useCallback((naechste: Schicht[]) => {
    setProfil((p) => (p ? { ...p, schichten: mitIds(naechste) } : p));
  }, []);

  /**
   * A boundary the operator dragged is one they looked at, so it stops being
   * an assumption.
   *
   * The drag reports the whole list, not which layer moved, so the moved ones
   * are the layers sitting at a depth no layer held before. The flag describes
   * exactly one boundary — a layer's own start — so clearing it on those and
   * nothing else is what "they confirmed this boundary, not the ones below it"
   * means.
   *
   * Only ever called for a real drag: a press that did not travel far enough
   * takes hold of nothing, so a tap meant as a selection cannot arrive here
   * and quietly mark a planned boundary as confirmed.
   */
  const onSchichtenChange = useCallback((naechste: Schicht[]) => {
    setProfil((p) => {
      if (!p) return p;
      const vorher = new Set(p.schichten.map((s) => s.tiefe));
      return {
        ...p,
        schichten: mitIds(naechste.map((s) =>
          (vorher.has(s.tiefe) ? s : { ...s, vorlaeufig: false }))),
      };
    });
  }, []);

  const auswahlIndex = auswahlId == null
    ? -1
    : schichten.findIndex((s) => s.id === auswahlId);
  // An edit can merge the selected layer away. Deriving the index every render
  // rather than storing it is what turns that into "nothing selected" instead
  // of a panel editing whatever moved into its place.
  const gewaehlt = auswahlIndex >= 0 ? schichten[auswahlIndex] : null;

  /**
   * A tap on the profile: a depth when an insert is armed, a layer otherwise.
   *
   * One gesture read two ways, rather than two gestures. The armed state is
   * visible on both the chart and the panel, and tapping the insert button
   * again cancels it, so there is always a way out of it.
   */
  const onAuswahl = useCallback(({ index, tiefe }: Auswahl) => {
    setLoeschBereit(false);
    setMeldung(null);
    if (einfuegen) {
      // `index` as well as `tiefe`: the chart derives the two from different
      // depths — raw for the index, snapped for the depth — so within half a
      // grid step of a boundary only the index says which layer the finger
      // was actually in.
      const stelle = einfuegeTiefeBei(
        schichten, endTiefe, tiefe, platzBedarf(einfuegen), index,
      );
      if (stelle == null) {
        // Said out loud rather than ignored: unlike a depth this screen picked
        // for itself, a tapped one can land where there is no room, and an
        // insert that quietly did nothing is indistinguishable from a tap the
        // screen never received.
        setMeldung(
          `Diese Schicht ist zu dünn für ${einfuegen === 'hindernis' ? 'ein Hindernis' : 'eine weitere Schicht'}. `
          + 'Bitte eine dickere Schicht antippen.',
        );
        return;
      }
      setEinfuegen(null);
      setZiel({ art: 'neu', kind: einfuegen, tiefe: stelle });
      return;
    }
    setAuswahlId(schichten[index]?.id ?? null);
  }, [einfuegen, schichten, endTiefe]);

  function verschiebeGrenze(index: number, meter: number) {
    if (index < 1) return;
    setLoeschBereit(false);
    // A boundary the operator moved is one they looked at, so it stops being an
    // assumption. Cleared on the way in rather than on the result: indexing the
    // input is correct whatever reshaping setzeGrenze does on the way out.
    const bestaetigt = schichten.map((s, i) =>
      (i === index ? { ...s, vorlaeufig: false } : s));
    aendern(setzeGrenze(
      bestaetigt, endTiefe, index, runde(schichten[index].tiefe + meter),
    ));
  }

  function waehleTyp(nr: number) {
    setVollbild(false);
    if (!ziel) return;
    if (ziel.art === 'typ') {
      const s = schichten[ziel.index];
      if (s) {
        // A boundary already at this depth is re-typed, not duplicated. Keeping
        // the id keeps the operator's selection on the layer they just changed.
        aendern(fuegeSchichtEin(
          schichten, endTiefe, s.tiefe, nr, { vorlaeufig: false, id: s.id },
        ));
      }
    } else {
      // Minted before the edit, because the insert has to select what it
      // inserted — the panel is where its depth gets corrected, and an insert
      // that left nothing selected would make the operator find it again.
      const id = neueId();
      aendern(ziel.kind === 'hindernis'
        // An obstruction is a claim about one stretch of hole, not "from here
        // down": inserting it bounded leaves the ground resuming underneath,
        // which is both what was seen and what the uploaded series carries.
        ? fuegeHindernisEin(
          schichten, endTiefe, ziel.tiefe, nr, NEUES_HINDERNIS_DICKE,
          { vorlaeufig: false, id },
        )
        : fuegeSchichtEin(
          schichten, endTiefe, ziel.tiefe, nr, { vorlaeufig: false, id },
        ));
      setAuswahlId(id);
    }
    setZiel(null);
  }

  function entferne(index: number) {
    aendern(entferneSchicht(schichten, endTiefe, index));
    setAuswahlId(null);
    setLoeschBereit(false);
  }

  /**
   * Arm an insert, or cancel the one that is armed.
   *
   * The depth comes from the next tap on the profile, which is the whole point:
   * the operator decides where the layer starts, and a layer born where they
   * pointed needs the steppers only for the last few centimetres. Tapping the
   * same button again is the way out, so the armed state is never a trap.
   */
  function fuegeEin(kind: PickerArt) {
    setLoeschBereit(false);
    setMeldung(null);
    setEinfuegen((aktuell) => (aktuell === kind ? null : kind));
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

  /** The soils this element's Schichtauftrag names, shallowest first. */
  const geplanteArten = useMemo(
    () => vorgabeArten(vorgabeSchichten),
    [vorgabeSchichten],
  );

  /**
   * Everything the open ground-type choice needs, or null when none is open.
   *
   * The choice takes the profile column rather than covering the screen — the
   * same move the drilling screen makes, and for the same reason: the panel
   * beside it keeps saying *which* layer is being typed, the header keeps its
   * exits, and the whole interaction is over in a tap. A full-screen picker
   * here threw away the one piece of context the operator needs, which is
   * where in the hole the layer they just tapped actually sits.
   */
  const wahl = useMemo(() => {
    if (!ziel) return null;
    const schicht = ziel.art === 'typ' ? schichten[ziel.index] : null;
    if (ziel.art === 'typ' && !schicht) return null;

    const kind: PickerArt = ziel.art === 'neu'
      ? ziel.kind
      : istHindernis(schicht!.nr) ? 'hindernis' : 'schicht';
    const tiefe = ziel.art === 'typ' ? schicht!.tiefe : ziel.tiefe;
    const untertitel = ziel.art === 'typ'
      ? `Schicht ab ${formatNumber(tiefe)} m`
      : `${neuLabel(ziel.kind)} ab ${formatNumber(tiefe)} m`;

    // Only a retype has a ground type to call "Aktuell". For a new layer the
    // ground at that depth is what is about to be split, so marking it would
    // offer a tap that changes nothing — `fuegeSchichtEin` merges it straight
    // back into its neighbour.
    const aktiveNr = ziel.art === 'typ' ? schicht!.nr : null;
    const vorgabeNr = vorgabeSchichten.length > 0
      ? grundBei(vorgabeSchichten as Parameters<typeof grundBei>[0], tiefe)
      : null;

    return {
      kind,
      untertitel,
      aktiveNr,
      vorgabeNr: vorgabeNr != null && !istHindernis(vorgabeNr) ? vorgabeNr : null,
      kandidaten: kind === 'hindernis'
        ? HINDERNIS_NRS
        : spaltenKandidaten(geplanteArten, aktiveNr),
    };
  }, [ziel, schichten, vorgabeSchichten, geplanteArten]);

  function brichWahlAb() {
    setVollbild(false);
    setZiel(null);
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
          <div
            ref={chartRef}
            style={{
              ...styles.chartSpalte,
              ...(einfuegen || wahl ? styles.chartSpalteScharf : {}),
              // The quick picker divides the column between its tiles, which
              // needs the column to be a flex parent. The chart sizes itself
              // from a measured height instead, so it neither needs this nor
              // wants it.
              ...(wahl ? styles.chartSpalteWahl : {}),
            }}
          >
            {wahl ? (
              <GeologieSpalte
                art={wahl.kind}
                nrs={wahl.kandidaten}
                aktiveNr={wahl.aktiveNr}
                vorgabeNr={wahl.vorgabeNr}
                onWaehlen={(nr) => waehleTyp(nr)}
                // Obstructions need no escalation: all six fit the column, and
                // there is no seventh kind behind "Andere…".
                onAndere={wahl.kind === 'schicht' ? () => setVollbild(true) : undefined}
              />
            ) : (
            <BohrprofilLog
              schichten={schichten}
              endTiefe={endTiefe}
              breite={340}
              hoehe={chartHoehe > 0 ? chartHoehe : 400}
              modus="vollbild"
              editierbar
              beruehrungsmodus
              onSchichtenChange={onSchichtenChange}
              // Nothing is ringed while an insert waits for a depth: the next
              // tap is about a height, not about a layer, and a ring would say
              // the opposite.
              ausgewaehlt={einfuegen ? null : auswahlIndex >= 0 ? auswahlIndex : null}
              onAuswahl={onAuswahl}
              styleOverrides={chartStyles}
            />
            )}
          </div>

          <div style={styles.panel}>
            {wahl ? (
              <WahlPanel
                kind={wahl.kind}
                untertitel={wahl.untertitel}
                // `geplanteArten`, not `kandidaten.length`: for a retype
                // `spaltenKandidaten` injects the layer's own type when the
                // plan does not name it, so the tile list is never empty and
                // the "no Vorgabe" wording was unreachable — the panel claimed
                // the column held the plan's soils while showing one tile that
                // changes nothing.
                geplant={geplanteArten.length > 0 && wahl.kind === 'schicht'}
                onAbbrechen={brichWahlAb}
              />
            ) : einfuegen ? (
              <EinfuegenPanel kind={einfuegen} meldung={meldung} />
            ) : gewaehlt ? (
              <SchichtPanel
                schicht={gewaehlt}
                istErste={auswahlIndex === 0}
                // The last layer standing cannot go: a profile with no layers
                // is not a profile.
                loeschbar={schichten.length > 1}
                loeschBereit={loeschBereit}
                onTyp={() => { setLoeschBereit(false); setZiel({ art: 'typ', index: auswahlIndex }); }}
                onSchritt={(meter) => verschiebeGrenze(auswahlIndex, meter)}
                onLoeschen={() => setLoeschBereit(true)}
                onLoeschenBestaetigen={() => entferne(auswahlIndex)}
              />
            ) : (
              <LeerPanel />
            )}

            {/*
              Hidden while a ground type is being chosen. The column is the
              picker at that moment, so there is nowhere for a new layer's
              depth tap to land — and the panel's own Abbrechen is the way out.
            */}
            {!wahl && (
              <div style={styles.hinzuReihe}>
                <button
                  style={{
                    ...styles.hinzu,
                    ...(einfuegen === 'schicht' ? styles.hinzuScharf : {}),
                  }}
                  onClick={() => fuegeEin('schicht')}
                >
                  {einfuegen === 'schicht' ? 'Abbrechen' : '+ Schicht'}
                </button>
                <button
                  style={{
                    ...styles.hinzuHindernis,
                    ...(einfuegen === 'hindernis' ? styles.hinzuScharf : {}),
                  }}
                  onClick={() => fuegeEin('hindernis')}
                >
                  {einfuegen === 'hindernis' ? 'Abbrechen' : '+ Hindernis'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        The full DIN catalogue, one level above the column. It covers the
        screen, so it is rendered last and outside the layout — and cancelling
        it returns to the quick picker rather than dropping the layer being
        typed.
      */}
      {wahl && vollbild && (
        <GeologiePicker
          art={wahl.kind}
          untertitel={wahl.untertitel}
          vorgabeNrs={geplanteArten}
          aktiveNr={wahl.aktiveNr}
          onWaehlen={waehleTyp}
          onAbbrechen={() => setVollbild(false)}
        />
      )}
    </div>
  );
}

/**
 * What the panel says while a ground type is being chosen in the column.
 *
 * It carries the context the full-screen picker used to put in its own header
 * — which layer, at what depth — so swapping the column for the picker costs
 * the operator nothing they were reading.
 */
function WahlPanel({
  kind, untertitel, geplant, onAbbrechen,
}: {
  kind: PickerArt;
  untertitel: string;
  geplant: boolean;
  onAbbrechen: () => void;
}) {
  return (
    <div style={styles.wahlPanel}>
      <span style={styles.wahlTitel}>
        <span style={styles.leerPfeil} aria-hidden>← </span>
        {kind === 'hindernis' ? 'Hindernis wählen' : 'Bodenart wählen'}
      </span>
      <span style={styles.wahlZiel}>{untertitel}</span>
      <span style={styles.wahlText}>
        {kind === 'hindernis'
          ? 'Links die Art des Hindernisses antippen.'
          : geplant
            ? `Links stehen die Bodenarten aus der Vorgabe für dieses Element. Alle ${WAEHLBAR.length} DIN-Bodenarten stehen unter „Andere…“.`
            : `Für dieses Element sind keine Bodenarten vorgegeben. Unter „Andere…“ stehen alle ${WAEHLBAR.length} DIN-Bodenarten.`}
      </span>
      <button style={styles.wahlAbbrechen} onClick={onAbbrechen}>
        Abbrechen
      </button>
    </div>
  );
}

/**
 * What the panel says before anything is selected.
 *
 * Not onboarding — this is the state the screen returns to after a delete, and
 * after an edit merges the selected layer away, so it has to keep explaining
 * itself rather than teach once and disappear. It is also the only thing on the
 * screen that says the chart is tappable at all.
 */
function LeerPanel() {
  return (
    <div style={styles.leerPanel}>
      <span style={styles.leerTitel}>
        <span style={styles.leerPfeil} aria-hidden>← </span>
        Schicht im Profil antippen
      </span>
      <span style={styles.leerText}>
        Bodenart, Tiefe und Entfernen erscheinen dann hier. Gestrichelte Grenzen
        kommen aus der Vorgabe und sind noch nicht bestätigt.
      </span>
    </div>
  );
}

/** What the panel says while an insert is waiting for its depth. */
function EinfuegenPanel({ kind, meldung }: { kind: PickerArt; meldung: string | null }) {
  return (
    <div style={styles.einfuegenPanel}>
      <span style={styles.einfuegenTitel}>
        Tiefe für {kind === 'hindernis' ? 'das Hindernis' : 'die neue Schicht'} antippen
      </span>
      <span style={styles.einfuegenText}>
        Im Bohrprofil links die Stelle antippen, an der
        {kind === 'hindernis' ? ' das Hindernis beginnt' : ' die Schicht beginnt'}.
        Danach die Bodenart wählen — die Tiefe lässt sich hier noch genau einstellen.
      </span>
      {meldung && <span style={styles.einfuegenFehler}>{meldung}</span>}
      {/*
        No cancel button here on purpose. The insert button below armed this
        and now reads "Abbrechen", so the way out is the control the operator
        just used — a second one in the panel is two identically labelled
        buttons for one action.
      */}
    </div>
  );
}

/** Everything that can be done to the one selected layer. */
function SchichtPanel({
  schicht, istErste, loeschbar, loeschBereit,
  onTyp, onSchritt, onLoeschen, onLoeschenBestaetigen,
}: {
  schicht: Schicht;
  istErste: boolean;
  loeschbar: boolean;
  loeschBereit: boolean;
  onTyp: () => void;
  onSchritt: (meter: number) => void;
  onLoeschen: () => void;
  onLoeschenBestaetigen: () => void;
}) {
  const hindernis = istHindernis(schicht.nr);
  const kurz = kurzLabel(schicht.nr);

  return (
    <div style={styles.schichtPanel}>
      <div style={styles.kennung}>
        <span
          style={{
            ...styles.swatch,
            backgroundColor: farbeVon(schicht.nr),
            ...(hindernis ? { border: '3px solid var(--color-warning)' } : {}),
          }}
        />
        <span style={styles.kennungText}>
          <span style={styles.kennungName}>{nameVon(schicht.nr)}</span>
          <span style={styles.kennungMeta}>
            {/*
              Every obstruction shares the Kurzform `Hi`, so `kurzLabel` falls
              back to the name without its prefix — which for `Findling` is the
              whole name, and "Findling · Findling" says nothing twice.
            */}
            {kurz !== nameVon(schicht.nr) && `${kurz} · `}
            {istErste ? 'ab Oberkante' : `ab ${formatNumber(schicht.tiefe)} m`}
            {schicht.vorlaeufig && <span style={styles.vorlaeufig}> Vorgabe</span>}
          </span>
        </span>
      </div>

      <button style={styles.typ} onClick={onTyp}>
        Bodenart ändern
      </button>

      {istErste ? (
        <div style={styles.obenHinweis}>
          Oberste Schicht — sie beginnt an der Oberkante des Profils und hat
          keine Grenze zum Verschieben.
        </div>
      ) : (
        <div style={styles.tiefeBlock}>
          <span style={styles.tiefeLabel}>Schichtgrenze</span>
          <div style={styles.tiefeReihe}>
            <button
              style={styles.schritt}
              onClick={() => onSchritt(-SCHRITT_GROB)}
              aria-label="Grenze einen Meter nach oben"
            >
              −1 m
            </button>
            <button
              style={styles.schritt}
              onClick={() => onSchritt(-SCHRITT_FEIN)}
              aria-label="Grenze zehn Zentimeter nach oben"
            >
              −10 cm
            </button>
            <span style={styles.tiefeWert}>{formatNumber(schicht.tiefe)} m</span>
            <button
              style={styles.schritt}
              onClick={() => onSchritt(SCHRITT_FEIN)}
              aria-label="Grenze zehn Zentimeter nach unten"
            >
              +10 cm
            </button>
            <button
              style={styles.schritt}
              onClick={() => onSchritt(SCHRITT_GROB)}
              aria-label="Grenze einen Meter nach unten"
            >
              +1 m
            </button>
          </div>
        </div>
      )}

      {loeschbar && (
        loeschBereit
          ? (
            <button style={styles.loeschenScharf} onClick={onLoeschenBestaetigen}>
              Wirklich entfernen?
            </button>
          )
          : (
            <button style={styles.loeschen} onClick={onLoeschen}>
              Schicht entfernen
            </button>
          )
      )}
    </div>
  );
}

const chartStyles = {
  depthTick: { color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 } as CSSProperties,
  depthLine: { borderTopColor: 'var(--text-primary)' } as CSSProperties,
  label: { fontSize: 15, fontWeight: 700 } as CSSProperties,
  /**
   * The ring has to win against every hatch pattern DIN 4023 defines, several
   * of which are dense black on white. A white ring inside a dark one reads on
   * all of them, which a single accent-coloured line does not.
   *
   * No `zIndex`: the package pins it below the rails and the boundary handles,
   * because a ring above them would make the selected layer swallow presses
   * meant for its own edges.
   */
  schichtAusgewaehlt: {
    outline: '4px solid var(--color-accent)',
    outlineOffset: -4,
    boxShadow: 'inset 0 0 0 7px rgba(255,255,255,0.9)',
  } as CSSProperties,
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
    width: 370,
    flexShrink: 0,
    minHeight: 0,
    paddingTop: 'var(--space-sm)',
    paddingBottom: 'var(--space-md)',
    borderRadius: 'var(--radius-md)',
    border: '3px solid transparent',
    boxSizing: 'border-box',
  },
  /**
   * While an insert waits for a depth, the chart is the control. Marked on the
   * chart as well as in the panel, because that is where the next tap has to
   * go — an armed state only the panel knew about would read as a panel that
   * stopped responding.
   */
  chartSpalteScharf: {
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-2)',
  },
  chartSpalteWahl: {
    display: 'flex',
    flexDirection: 'column',
    paddingLeft: 'var(--space-sm)',
    paddingRight: 'var(--space-sm)',
  },
  panel: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
  },

  // ── Zero state ───────────────────────────────────────────
  leerPanel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 'var(--space-sm)',
    padding: 'var(--space-lg)',
    borderRadius: 'var(--radius-md)',
    border: '2px dashed var(--border)',
    backgroundColor: 'var(--surface-2)',
  },
  leerPfeil: {
    color: 'var(--color-accent)',
    fontWeight: 800,
  },
  leerTitel: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.2,
  },
  leerText: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    maxWidth: '36ch',
  },

  // ── Ground type being chosen in the column ───────────────
  wahlPanel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 'var(--space-sm)',
    padding: 'var(--space-lg)',
    borderRadius: 'var(--radius-md)',
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-2)',
  },
  wahlTitel: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.2,
  },
  wahlZiel: {
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    color: 'var(--color-accent-strong)',
    fontVariantNumeric: 'tabular-nums',
  },
  wahlText: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    maxWidth: '40ch',
  },
  wahlAbbrechen: {
    marginTop: 'var(--space-sm)',
    minWidth: 220,
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-md)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },

  // ── Insert armed ─────────────────────────────────────────
  einfuegenPanel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 'var(--space-md)',
    padding: 'var(--space-lg)',
    borderRadius: 'var(--radius-md)',
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-2)',
  },
  einfuegenTitel: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.2,
  },
  einfuegenText: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    maxWidth: '40ch',
  },
  einfuegenFehler: {
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--color-warning-text)',
    lineHeight: 1.4,
    maxWidth: '40ch',
  },

  // ── Selected layer ───────────────────────────────────────
  schichtPanel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    padding: 'var(--space-md)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border)',
    backgroundColor: 'var(--surface-2)',
  },
  kennung: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    flexShrink: 0,
  },
  swatch: {
    width: 56,
    height: 56,
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  kennungText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  kennungName: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.15,
  },
  kennungMeta: {
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  vorlaeufig: {
    fontSize: 'var(--font-sm)',
    fontWeight: 800,
    color: 'var(--color-warning-text)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  typ: {
    flexShrink: 0,
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-md)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  tiefeBlock: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-xs)',
  },
  tiefeLabel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
  tiefeReihe: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-xs)',
  },
  /**
   * Coarse and fine, rather than one step size. Without drag, a planned
   * boundary that turned out five metres deeper would be fifty taps of a 10 cm
   * stepper; with a 1 m step it is five and then a correction.
   */
  schritt: {
    minWidth: 'var(--tap-min)',
    height: 'var(--tap-min)',
    flexShrink: 0,
    padding: '0 var(--space-xs)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    fontFamily: 'inherit',
    lineHeight: 1,
    cursor: 'pointer',
  },
  tiefeWert: {
    flex: 1,
    textAlign: 'center',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  obenHinweis: {
    flexShrink: 0,
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    maxWidth: '40ch',
  },
  /** Default danger style: surface background, danger text. */
  loeschen: {
    marginTop: 'auto',
    flexShrink: 0,
    minHeight: 'var(--tap-min)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-danger)',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  /** Armed: the whole button, in danger red, is the confirm target. */
  loeschenScharf: {
    marginTop: 'auto',
    flexShrink: 0,
    minHeight: 'var(--tap-min)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },

  // ── Insert buttons ───────────────────────────────────────
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
  /** Armed, and therefore the way back out. */
  hinzuScharf: {
    border: '3px solid var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-primary)',
  },
};
