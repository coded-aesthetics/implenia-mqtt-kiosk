import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Schicht } from '@coded-aesthetics/din4023/profile';
import { naechsteGrenze, nameVon } from '../utils/geologie';
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

export type PickerArt = 'schicht' | 'hindernis';

export interface GeologieErfassung {
  /** Does this Verfahren record geology, and is something being recorded? */
  verfuegbar: boolean;
  /** The planned boundary worth confirming right now, if any. */
  vorschlag: { tiefe: number; nr: number } | null;
  /** Which picker is open, if any. */
  picker: PickerArt | null;
  oeffnePicker: (art: PickerArt) => void;
  schliessePicker: () => void;
  /** Record a ground type at the current depth. */
  erfasse: (nr: number, name?: string) => Promise<void>;
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
  /** The planned profile, for the suggestion. */
  vorgabeSchichten?: readonly Schicht[] | null;
  /** Live depth in metres, where the screen knows it. */
  tiefe?: number | null;
}

export function useGeologieErfassung({
  sessionId, active, operatingMode, vorgabeSchichten, tiefe,
}: Args): GeologieErfassung {
  const [verfuegbar, setVerfuegbar] = useState(false);
  const [picker, setPicker] = useState<PickerArt | null>(null);
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
        if (!abgebrochen) setVerfuegbar(ctx?.verfuegbar === true);
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
    setPicker(null);
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
  const vorschlag = useMemo(() => {
    if (!drillt || !verfuegbar || !vorgabeSchichten || tiefe == null) return null;
    const grenze = naechsteGrenze(vorgabeSchichten, tiefe, FENSTER_M);
    if (!grenze || grenze.nr === letzteNr) return null;
    return grenze;
  }, [drillt, verfuegbar, vorgabeSchichten, tiefe, letzteNr]);

  const erfasse = useCallback(async (nr: number, name?: string) => {
    setPicker(null);
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

  return {
    verfuegbar: drillt && verfuegbar,
    vorschlag,
    picker,
    oeffnePicker: setPicker,
    schliessePicker: () => setPicker(null),
    erfasse,
    rueckmeldung,
    fehler,
  };
}
