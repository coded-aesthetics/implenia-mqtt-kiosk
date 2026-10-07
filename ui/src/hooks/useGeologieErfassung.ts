import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Schicht } from '@coded-aesthetics/din4023/profile';
import { grundBei } from '@coded-aesthetics/din4023/profile';
import {
  HINDERNISSE, MAX_SPALTEN_KACHELN, istHindernis, naechsteGrenze, nameVon,
  vorgabeArten,
} from '../utils/geologie';
import { formatNumber } from '../utils/format';

/**
 * Recording a layer change while the rig is going down.
 *
 * Lifted out of the screen because two places need the same state: the
 * recording bar draws the buttons, and the drilling profile marks the boundary
 * the suggestion refers to. Two copies of this would let the button offer one
 * boundary while the chart highlighted another.
 *
 * `tiefe` is optional, and the distinction matters: **recording a layer needs
 * no depth at all** — the server dates the reading at the exact `received_at`
 * of its own latest depth reading, because implenia-web aligns geology to depth
 * by millisecond equality and a browser-measured depth one sample out of step
 * produces no layer. Only the *suggestion* needs to know where the drill is, so
 * a Verfahren whose screen has no depth hero still gets working buttons, just
 * without the pre-loaded answer.
 */

/** How close to a planned boundary the suggestion appears, in metres. */
const FENSTER_M = 0.3;

/** All six obstruction kinds — few enough that the column shows them all. */
const HINDERNIS_NRS = HINDERNISSE.map((e) => e.nr);

export type PickerArt = 'schicht' | 'hindernis';

export interface GeologieErfassung {
  /** Does this Verfahren record geology, and is something being recorded? */
  verfuegbar: boolean;
  /** The planned boundary worth confirming right now, if any. */
  vorschlag: { tiefe: number; nr: number } | null;
  /**
   * The quick picker shown in the drilling screen's profile column, if open.
   *
   * Two levels on purpose. This one offers only what the Vorgabe names — three
   * to five soils, or the six obstruction kinds — which is what the operator
   * picks virtually every time, and it fits in the column so the screen does
   * not change. `vollbild` is the full DIN vocabulary behind "Andere", for the
   * ground nobody planned for.
   */
  auswahl: PickerArt | null;
  /** The ground types the quick picker offers, in column order. */
  kandidaten: number[];
  /** True when the Vorgabe names more soils than the column can show. */
  mehrVorhanden: boolean;
  /** The planned ground at the current depth, for marking the list. */
  aktuelleArt: number | null;
  /** The full-screen picker, if open. */
  vollbild: PickerArt | null;
  /** Open the quick picker, or the full one where no column can show it. */
  oeffne: (art: PickerArt) => void;
  /** Escalate from the quick picker to the full DIN vocabulary. */
  oeffneAndere: () => void;
  schliesse: () => void;
  /** Record a ground type at the current depth. */
  erfasse: (nr: number, name?: string) => Promise<void>;
  /**
   * The last recorded code is an obstruction, so the drill is inside one.
   *
   * Seeded from the server rather than kept only in the browser: a PM2 restart
   * mid-obstruction would otherwise lose it and offer the operator no way to
   * close the obstruction in one tap.
   */
  imHindernis: boolean;
  /**
   * Leave the obstruction, returning to the ground the Vorgabe plans here.
   *
   * One tap and no pick, because the answer is knowable: the obstruction
   * interrupted a planned layer, and `grundBei` says which. Falls back to the
   * picker when there is no plan to fall back on.
   */
  beendeHindernis: () => Promise<void>;
  /** Transient confirmation, e.g. "Schluff ab 3,40 m". */
  rueckmeldung: string | null;
  /** Transient, German, actionable. */
  fehler: string | null;
}

interface Args {
  /** Null when nothing is being recorded. */
  sessionId: number | null;
  active: boolean;
  /** What the rig is doing; geology entry only applies while drilling. */
  operatingMode: string | null;
  /** The planned profile, for the suggestion and the quick picker. */
  vorgabeSchichten?: readonly Schicht[] | null;
  /** Live depth in metres, where the screen knows it. */
  tiefe?: number | null;
  /**
   * Whether a screen is showing that can render the quick picker in place of a
   * profile column. Only the drilling screen can; elsewhere the full-screen
   * picker is the only option.
   */
  spalteVerfuegbar?: boolean;
}

export function useGeologieErfassung({
  sessionId, active, operatingMode, vorgabeSchichten, tiefe, spalteVerfuegbar,
}: Args): GeologieErfassung {
  const [verfuegbar, setVerfuegbar] = useState(false);
  const [auswahl, setAuswahl] = useState<PickerArt | null>(null);
  const [vollbild, setVollbild] = useState<PickerArt | null>(null);
  const [rueckmeldung, setRueckmeldung] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  /**
   * The last ground type recorded in this session.
   *
   * Only stops the button re-offering a change the operator has just
   * confirmed. Local state on purpose: losing it to a restart means the
   * suggestion reappears once, which costs nothing, while persisting it would
   * put a second copy of the recorded profile outside the database.
   */
  const [letzteNr, setLetzteNr] = useState<number | null>(null);

  const drillt = active && operatingMode === 'bohren';

  // Whether this Verfahren records geology at all is a property of the session,
  // so it is asked once per session rather than polled.
  useEffect(() => {
    if (sessionId === null || !active) {
      setVerfuegbar(false);
      return;
    }
    let abgebrochen = false;
    fetch(`/api/recording/${sessionId}/geology-context`)
      .then((r) => (r.ok ? r.json() : null))
      .then((ctx) => {
        if (abgebrochen) return;
        setVerfuegbar(ctx?.verfuegbar === true);
        // The last code already recorded. This is what makes "inside an
        // obstruction" outlive a PM2 restart — without it the operator would
        // come back to a screen offering no way to close the obstruction.
        const beobachtet = Array.isArray(ctx?.beobachtet) ? ctx.beobachtet : [];
        const letzte = beobachtet[beobachtet.length - 1];
        if (letzte && Number.isInteger(letzte.nr)) setLetzteNr(letzte.nr);
      })
      .catch(() => {
        // A Verfahren that cannot be asked gets no buttons. Nothing else about
        // the recording is affected.
        if (!abgebrochen) setVerfuegbar(false);
      });
    return () => { abgebrochen = true; };
  }, [sessionId, active]);

  // A new session starts with nothing confirmed.
  useEffect(() => {
    setLetzteNr(null);
    setAuswahl(null);
    setVollbild(null);
    setRueckmeldung(null);
    setFehler(null);
  }, [sessionId]);

  // Both messages are transient confirmations, not state the operator manages.
  useEffect(() => {
    if (!rueckmeldung) return;
    const id = setTimeout(() => setRueckmeldung(null), 6000);
    return () => clearTimeout(id);
  }, [rueckmeldung]);
  useEffect(() => {
    if (!fehler) return;
    const id = setTimeout(() => setFehler(null), 10000);
    return () => clearTimeout(id);
  }, [fehler]);

  /**
   * The planned boundary the drilling is closest to — the whole mechanism for
   * the layer changes operators forget.
   *
   * Instead of a reminder to dismiss, the button pre-loads the expected answer
   * and relabels, so one tap confirms the planned change. Ignoring it costs
   * nothing: no popup, no state to clear, nothing on the screen moves.
   */
  /** The soils this Vorgabe names, trimmed to what the column can show. */
  const alleArten = useMemo(() => vorgabeArten(vorgabeSchichten), [vorgabeSchichten]);
  const kandidaten = useMemo(
    () => (auswahl === 'hindernis'
      ? HINDERNIS_NRS
      : alleArten.slice(0, MAX_SPALTEN_KACHELN)),
    [auswahl, alleArten],
  );
  const mehrVorhanden = auswahl === 'schicht' && alleArten.length > MAX_SPALTEN_KACHELN;

  /** The ground the plan expects right here, for marking the list. */
  const aktuelleArt = useMemo(() => {
    if (!vorgabeSchichten || tiefe == null) return null;
    return grundBei(vorgabeSchichten as Parameters<typeof grundBei>[0], tiefe);
  }, [vorgabeSchichten, tiefe]);

  const imHindernis = letzteNr !== null && istHindernis(letzteNr);

  const vorschlag = useMemo(() => {
    if (!drillt || !verfuegbar || !vorgabeSchichten || tiefe == null) return null;
    const grenze = naechsteGrenze(vorgabeSchichten, tiefe, FENSTER_M);
    if (!grenze || grenze.nr === letzteNr) return null;
    return grenze;
  }, [drillt, verfuegbar, vorgabeSchichten, tiefe, letzteNr]);

  const erfasse = useCallback(async (nr: number, name?: string) => {
    setAuswahl(null);
    setVollbild(null);
    setFehler(null);
    try {
      const res = await fetch('/api/recording/geology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nr, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFehler(data.error || `Die Geologie konnte nicht erfasst werden (Fehler ${res.status}).`);
        return;
      }
      setLetzteNr(nr);
      const gezeigt = name?.trim() || nameVon(nr);
      setRueckmeldung(
        data.tiefe != null
          ? `${gezeigt} ab ${formatNumber(data.tiefe)} m`
          : gezeigt,
      );
    } catch (err) {
      setFehler(`Die Geologie konnte nicht erfasst werden: ${(err as Error).message}`);
    }
  }, []);

  /**
   * Open a picker — the quick one where a column can show it, the full one
   * otherwise. Tapping the same kind again closes it, so the button that opens
   * the list also dismisses it and the list needs no cancel tile of its own.
   */
  const oeffne = useCallback((art: PickerArt) => {
    if (!spalteVerfuegbar) {
      setVollbild((v) => (v === art ? null : art));
      return;
    }
    setAuswahl((a) => (a === art ? null : art));
  }, [spalteVerfuegbar]);

  const oeffneAndere = useCallback(() => {
    setAuswahl(null);
    setVollbild('schicht');
  }, []);

  const schliesse = useCallback(() => {
    setAuswahl(null);
    setVollbild(null);
  }, []);

  const beendeHindernis = useCallback(async () => {
    const zurueck = aktuelleArt;
    if (zurueck == null) {
      // No plan to resume, so the operator has to say what the ground is.
      oeffne('schicht');
      return;
    }
    await erfasse(zurueck, nameVon(zurueck));
  }, [aktuelleArt, erfasse, oeffne]);

  return {
    verfuegbar: drillt && verfuegbar,
    vorschlag,
    auswahl,
    kandidaten,
    mehrVorhanden,
    aktuelleArt,
    vollbild,
    oeffne,
    oeffneAndere,
    schliesse,
    erfasse,
    imHindernis,
    beendeHindernis,
    rueckmeldung,
    fehler,
  };
}
