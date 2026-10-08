import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Schicht } from '@coded-aesthetics/din4023/profile';
import { grundBei } from '@coded-aesthetics/din4023/profile';
import {
  HINDERNISSE, istHindernis, liveProfil, naechsteGrenze, nameVon,
  spaltenKandidaten, vomServer, vorgabeArten, type Profil, type ServerSchicht,
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

/**
 * Announces a geology entry made outside React.
 *
 * The voice commands post to `/api/recording/geology` directly — they are built
 * once, outside the component tree, and have no way to call into this hook.
 * Without this the hook never learns a layer was recorded: `imHindernis` stays
 * false, so the hands-free operator the one-tap "Hindernis Ende" exists for is
 * the one person who cannot use it; the live profile never shows the layer; and
 * the suggestion keeps offering ground that was already spoken.
 */
export const GEOLOGIE_ERFASST = 'kiosk:geologie-erfasst';

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
  /**
   * The ground the drill is in: what the operator last recorded, or — until
   * they have recorded anything — what the Vorgabe plans at this depth.
   *
   * What the picker highlights. Marking the plan instead was wrong in exactly
   * the case that matters: an operator who had recorded Kies at 4,2 m came back
   * after a restart to a picker marking Schluff, because that is what the
   * Schichtauftrag expects there. The plan is still marked, as the plan.
   */
  aktiveArt: number | null;
  /** The planned ground at the current depth, marked as such. */
  vorgabeArt: number | null;
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
  /**
   * The profile to draw while drilling: observed layers solid, the plan dashed
   * below, and the layer the drill is in ending at the drill. Null until the
   * server has answered.
   */
  profil: Profil | null;
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
  /**
   * The server's view of this session's geology: the profile it would commit,
   * and the layers already observed.
   *
   * Server-derived rather than accumulated in the browser, so it survives a PM2
   * restart and so the chart shows what will actually be uploaded rather than a
   * second, divergent tally.
   */
  const [kontext, setKontext] = useState<{
    profil: { schichten: ServerSchicht[]; endTiefe: number } | null;
    letzteTiefe: number | null;
  }>({ profil: null, letzteTiefe: null });
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
  /** The session a context response must still belong to when it lands. */
  const aktuelleSession = useRef<number | null>(null);

  const drillt = active && operatingMode === 'bohren';

  /**
   * Read the server's view of this session's geology.
   *
   * Called once when the session appears and again after every entry — not
   * polled. Observations only change when something is recorded, and the server
   * is local, so a round trip per tap costs nothing and keeps one source of
   * truth instead of a browser-side tally that a restart would lose.
   */
  const ladeKontext = useCallback(async (id: number) => {
    // Every response is checked against the session that is current when it
    // lands. Without this, a request still in flight when the operator stops
    // one element and starts the next overwrites the new session's state with
    // the old one's — and if the old element ended inside an obstruction, the
    // new one's bar offers "Hindernis Ende", which writes a bogus layer to it.
    aktuelleSession.current = id;
    try {
      const res = await fetch(`/api/recording/${id}/geology-context`);
      if (aktuelleSession.current !== id) return;
      if (!res.ok) throw new Error(String(res.status));
      const ctx = await res.json();
      if (aktuelleSession.current !== id) return;
      setVerfuegbar(ctx?.verfuegbar === true);
      const beobachtet = Array.isArray(ctx?.beobachtet) ? ctx.beobachtet : [];
      const letzte = beobachtet[beobachtet.length - 1];
      setKontext({
        profil: ctx?.profil ?? null,
        letzteTiefe: letzte && Number.isFinite(letzte.tiefe) ? letzte.tiefe : null,
      });
      // The last code already recorded. This is what makes "inside an
      // obstruction" outlive a PM2 restart — without it the operator would come
      // back to a screen offering no way to close the obstruction.
      if (letzte && Number.isInteger(letzte.nr)) setLetzteNr(letzte.nr);
    } catch {
      // A Verfahren that cannot be asked gets no buttons. Nothing else about
      // the recording is affected.
      if (aktuelleSession.current === id) setVerfuegbar(false);
    }
  }, []);

  useEffect(() => {
    if (sessionId === null || !active) {
      setVerfuegbar(false);
      setKontext({ profil: null, letzteTiefe: null });
      return;
    }
    void ladeKontext(sessionId);
  }, [sessionId, active, ladeKontext]);

  // A spoken entry is a write this hook did not make; re-read so the buttons
  // and the live profile agree with the database. See GEOLOGIE_ERFASST.
  useEffect(() => {
    if (sessionId === null || !active) return;
    const onErfasst = (): void => { void ladeKontext(sessionId); };
    window.addEventListener(GEOLOGIE_ERFASST, onErfasst);
    return () => window.removeEventListener(GEOLOGIE_ERFASST, onErfasst);
  }, [sessionId, active, ladeKontext]);

  // A new session starts with nothing confirmed.
  useEffect(() => {
    aktuelleSession.current = sessionId;
    setLetzteNr(null);
    setKontext({ profil: null, letzteTiefe: null });
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
  /** The ground the plan expects right here. */
  const vorgabeArt = useMemo(() => {
    if (!vorgabeSchichten || tiefe == null) return null;
    return grundBei(vorgabeSchichten as Parameters<typeof grundBei>[0], tiefe);
  }, [vorgabeSchichten, tiefe]);
  /**
   * Where the drill actually is. What was recorded outranks what was planned —
   * the operator saw the ground, the Schichtauftrag only predicted it.
   */
  const aktiveArt = letzteNr ?? vorgabeArt;
  const kandidaten = useMemo(
    () => (auswahl === 'hindernis'
      ? HINDERNIS_NRS
      : spaltenKandidaten(alleArten, aktiveArt)),
    [auswahl, alleArten, aktiveArt],
  );

  const imHindernis = letzteNr !== null && istHindernis(letzteNr);

  /**
   * What the drilling chart draws: everything observed, with the layer the
   * drill is currently in stopping at the current depth and the plan resuming
   * below it. See liveProfil — it is deliberately not the committed shape.
   */
  const profil = useMemo(
    () => liveProfil(vomServer(kontext.profil), kontext.letzteTiefe, vorgabeSchichten, tiefe ?? null),
    [kontext, vorgabeSchichten, tiefe],
  );

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
      // Re-read rather than patch a local copy: the server decides which depth
      // reading the entry landed on, so only it knows where the layer starts.
      if (sessionId !== null) void ladeKontext(sessionId);
    } catch (err) {
      setFehler(`Die Geologie konnte nicht erfasst werden: ${(err as Error).message}`);
    }
  }, [sessionId, ladeKontext]);

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
    // The plan, not the active ground: the active ground *is* the obstruction
    // being left, and what the obstruction interrupted is what the Vorgabe
    // names here.
    const zurueck = vorgabeArt;
    if (zurueck == null) {
      // No plan to resume, so the operator has to say what the ground is.
      oeffne('schicht');
      return;
    }
    await erfasse(zurueck, nameVon(zurueck));
  }, [vorgabeArt, erfasse, oeffne]);

  return {
    verfuegbar: drillt && verfuegbar,
    vorschlag,
    auswahl,
    kandidaten,
    aktiveArt,
    vorgabeArt,
    vollbild,
    oeffne,
    oeffneAndere,
    schliesse,
    erfasse,
    imHindernis,
    beendeHindernis,
    profil,
    rueckmeldung,
    fehler,
  };
}
