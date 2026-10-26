import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { useGestenSperre } from '../hooks/useGestenSperre';
import { naechsteKorrektur, nurTieferMoeglich } from '../utils/tiefenkorrektur';

/**
 * Correct the depth of the hole being drilled.
 *
 * The depth measuring wheel slips. Over a hole the published depth creeps away
 * from the real one, and the worker on the rig can tell what it really is from
 * the Bohrrohre they have mounted — so they shift it here and keep drilling.
 *
 * ── Why a stepper and not a drag control ─────────────────────
 *
 * The obvious touch control for "move a number by an unknown amount" is a
 * rubber band: drag away from the centre, the value runs faster the further
 * you pull, let go and it snaps back. It reads well and it is wrong here. It
 * integrates over *time*, so you steer a moving number by holding a finger
 * still, overshoot is the normal outcome and there is no way to undo precisely
 * — and it needs a pointer-capture plus animation loop on a Celeron J1900 for
 * something two buttons do exactly.
 *
 * Discrete steps keep what the band was for. Holding a button repeats and
 * accelerates, which is the same "the harder I pull the faster it goes" with
 * the tension expressed in time rather than distance, and releasing always
 * lands on a clean multiple of 10 cm. One tap is still one step.
 *
 * Steps are metres and centimetres, deliberately **not** pipe lengths: slip is
 * a slow creep, not a missed pipe, so the error does not arrive in units of
 * Bohrrohr and offering it that way would invite a correction of the wrong
 * size.
 *
 * ── Why it submits a delta ───────────────────────────────────
 *
 * The rig keeps drilling while this is open, so the depth on screen moves. The
 * worker dials in a *difference*, the preview tracks the live value, and the
 * server applies that difference whenever the request lands. A target depth
 * would be stale by whatever was drilled in between.
 *
 * Full-screen rather than a dialog, like `GeologiePicker` and for the same
 * reason: CLAUDE.md rules modals out, every exit here is a 64px+ target, and
 * nothing happens until `Übernehmen` is tapped. An accidental tap on the depth
 * costs one tap on Abbrechen — or nothing at all, because the screen closes
 * itself after LEERLAUF_MS without a touch rather than sitting there hiding
 * the drilling profile.
 */

interface Props {
  /** Live depth as the rig reports it, already corrected. Null if none yet. */
  tiefe: number | null;
  /** Metres already corrected on this element, for the slip diagnosis. */
  bisherigeKorrektur: number | null;
  /** Returns a German error message, or null when it worked. */
  onUebernehmen: (deltaMeter: number) => Promise<string | null>;
  onAbbrechen: () => void;
}

/**
 * The three steps, in centimetres — and which of them repeat while held.
 *
 * The metre does not. A held metre button reached eighteen metres in two
 * seconds, which is not a correction anybody means: slip is a creep of
 * decimetres to a couple of metres over a hole, so three taps cover the coarse
 * case and the smaller steps are for trimming. Nothing in this screen should
 * be able to move the depth of a hole faster than a worker can read it, which
 * is also why the run has a floor — see SCHNELLSTE_MS.
 *
 * The centimetre is below what anybody can judge from the pipes, and it is
 * here anyway: it is the precision the depth is stored at, and the one step
 * that can land on an exact value a worker read off the rig.
 */
const SCHRITTE: readonly { cm: number; wiederholt: boolean }[] = [
  { cm: 100, wiederholt: false },
  { cm: 10, wiederholt: true },
  { cm: 1, wiederholt: true },
];

/** No touch for this long and the screen gives the drilling profile back. */
const LEERLAUF_MS = 20_000;

export function TiefenKorrektur({ tiefe, bisherigeKorrektur, onUebernehmen, onAbbrechen }: Props) {
  const [deltaCm, setDeltaCm] = useState(0);
  const [fehler, setFehler] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const { sperrProps, darfHandeln } = useGestenSperre();

  // The live depth, read by the step handlers without re-creating them: a
  // reading arrives several times a second while a button is held down.
  const tiefeRef = useRef(tiefe);
  tiefeRef.current = tiefe;

  const abbrechenRef = useRef(onAbbrechen);
  abbrechenRef.current = onAbbrechen;

  const [leerlauf, setLeerlauf] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => abbrechenRef.current(), LEERLAUF_MS);
    return () => clearTimeout(id);
  }, [leerlauf]);

  const schritt = (cm: number) => {
    setFehler(null);
    // The bound is read off the live depth on every press, because what is
    // submitted is a difference — see naechsteKorrektur, which is also where
    // the one thing that is easy to get wrong about it is written down.
    setDeltaCm((vorher) => naechsteKorrektur(vorher, cm, tiefeRef.current));
  };

  const uebernehmen = async () => {
    if (deltaCm === 0 || speichert) return;
    setSpeichert(true);
    const problem = await onUebernehmen(deltaCm / 100);
    setSpeichert(false);
    if (problem) {
      setFehler(problem);
      setLeerlauf((n) => n + 1);
    }
    // On success the parent closes this screen.
  };

  const delta = deltaCm / 100;
  const neueTiefe = tiefe === null ? null : tiefe + delta;

  return (
    <div
      style={styles.overlay}
      onPointerDown={() => {
        // Arms the ghost-click guard, exactly as spreading sperrProps would —
        // spelled out because this handler also has its own work to do.
        sperrProps.onPointerDown();
        // Any touch keeps the screen open; untouched, it closes itself.
        setLeerlauf((n) => n + 1);
      }}
    >
      <div style={styles.kopf}>
        <span style={styles.titel}>Tiefe korrigieren</span>
        <span style={styles.schub} />
        <button
          style={styles.abbrechen}
          onClick={(e) => darfHandeln(e) && onAbbrechen()}
        >
          Abbrechen
        </button>
      </div>

      {tiefe === null ? (
        <div style={styles.hinweisMitte}>
          Es liegt noch kein Tiefenmesswert vor. Die Tiefe kann erst korrigiert werden,
          wenn das Gerät eine Tiefe sendet. Bitte prüfen, ob dem Tiefensensor ein Topic
          zugeordnet ist (Einstellungen → Messwerte).
        </div>
      ) : (
        <div style={styles.mitte}>
          <div style={styles.stapel}>
            <span style={styles.richtung}>Flacher</span>
            {SCHRITTE.map(({ cm, wiederholt }) => (
              <SchrittKnopf
                key={`minus-${cm}`}
                label={`− ${formatNumber(cm / 100)} m`}
                wiederholt={wiederholt}
                onSchritt={() => schritt(-cm)}
              />
            ))}
          </div>

          <div style={styles.anzeige}>
            <span style={styles.anzeigeLabel}>Neue Tiefe</span>
            <span style={styles.anzeigeWert}>{formatNumber(neueTiefe ?? 0)} m</span>
            <span style={styles.anzeigeZeile}>
              Gerät: {formatNumber(tiefe)} m
            </span>
            <span style={deltaCm === 0 ? styles.anzeigeZeile : styles.anzeigeDelta}>
              Korrektur: {deltaCm > 0 ? '+' : ''}{formatNumber(delta)} m
            </span>
            {bisherigeKorrektur != null && bisherigeKorrektur !== 0 && (
              <span style={styles.anzeigeZeile}>
                Bisher auf diesem Element: {bisherigeKorrektur > 0 ? '+' : ''}
                {formatNumber(bisherigeKorrektur)} m
              </span>
            )}
            {/*
              Said, rather than left to be discovered by pressing: the three
              „Flacher" buttons cannot move a depth that is already at or above
              ground level, and three buttons that do nothing for no stated
              reason is the dead end this screen is not allowed to be.
            */}
            {nurTieferMoeglich(tiefe) && (
              <span style={styles.anzeigeHinweis}>
                Das Gerät meldet {formatNumber(tiefe)} m, also keine Tiefe unter Grund.
                Deshalb ist nur „Tiefer" möglich.
              </span>
            )}
          </div>

          <div style={styles.stapel}>
            <span style={styles.richtung}>Tiefer</span>
            {SCHRITTE.map(({ cm, wiederholt }) => (
              <SchrittKnopf
                key={`plus-${cm}`}
                label={`+ ${formatNumber(cm / 100)} m`}
                wiederholt={wiederholt}
                onSchritt={() => schritt(cm)}
              />
            ))}
          </div>
        </div>
      )}

      {fehler && (
        <div style={styles.fehler} onClick={(e) => darfHandeln(e) && setFehler(null)}>
          {fehler}
        </div>
      )}

      {tiefe !== null && (
        <button
          style={{
            ...styles.uebernehmen,
            ...(deltaCm === 0 || speichert ? styles.uebernehmenAus : {}),
          }}
          disabled={deltaCm === 0 || speichert}
          onClick={(e) => darfHandeln(e) && void uebernehmen()}
        >
          {speichert ? 'Wird übernommen…' : 'Übernehmen'}
        </button>
      )}
    </div>
  );
}

/** First repeat after this long — a tap must not become two. */
const HALTEN_MS = 600;
/** Then every this long, shortening by FAKTOR down to SCHNELLSTE_MS. */
const WIEDERHOLUNG_MS = 220;
/**
 * The floor, which is what the run's top speed is: 10 cm every 120 ms, so a
 * held button moves the depth by well under a metre a second. Fast enough that
 * two metres is a comfortable hold, slow enough that the number stays readable
 * while it runs — which is the only thing that lets the worker stop on time.
 */
const SCHNELLSTE_MS = 120;
const FAKTOR = 0.8;

/**
 * A step button, repeating while held where the step is small enough for that.
 *
 * Acts on `pointerdown`, not on click: a touchscreen fires a compatibility
 * click after `touchend` that hit-tests the DOM as it is *then*, and a button
 * that acts on press cannot be triggered by the tail of somebody else's
 * gesture. See useGestenSperre.
 */
function SchrittKnopf(
  { label, wiederholt, onSchritt }:
  { label: string; wiederholt: boolean; onSchritt: () => void },
) {
  const timer = useRef<number | null>(null);
  const schrittRef = useRef(onSchritt);
  schrittRef.current = onSchritt;

  const stopp = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // A finger lifted outside the button, a pointer cancelled by the browser, or
  // the screen closing mid-press must all stop the repeat. A runaway interval
  // would keep moving the depth of a hole nobody is looking at.
  useEffect(() => stopp, []);

  const start = () => {
    stopp();
    schrittRef.current();
    if (!wiederholt) return;
    let pause = HALTEN_MS;
    const tick = () => {
      schrittRef.current();
      pause = Math.max(SCHNELLSTE_MS, pause === HALTEN_MS ? WIEDERHOLUNG_MS : pause * FAKTOR);
      timer.current = window.setTimeout(tick, pause);
    };
    timer.current = window.setTimeout(tick, pause);
  };

  return (
    <button
      style={styles.schritt}
      onPointerDown={start}
      onPointerUp={stopp}
      onPointerLeave={stopp}
      onPointerCancel={stopp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
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
    padding: 'var(--space-md) var(--space-lg)',
    gap: 'var(--space-md)',
    boxSizing: 'border-box',
    overflow: 'hidden',
    touchAction: 'manipulation',
    userSelect: 'none',
  },
  kopf: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    flexShrink: 0,
  },
  schub: { flex: 1 },
  titel: {
    fontSize: 'var(--font-lg)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  abbrechen: {
    minWidth: 200,
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
  mitte: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-xl)',
  },
  hinweisMitte: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    maxWidth: 700,
    margin: '0 auto',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    lineHeight: 1.4,
    color: 'var(--text-primary)',
  },
  stapel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    flexShrink: 0,
  },
  richtung: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  schritt: {
    // Far above the 64px minimum on purpose: this is tapped repeatedly, with
    // gloves, on a rig that is running. Three of them per side still leave
    // room at 1024x768 — the stack is 3 x 120 plus its label.
    width: 240,
    height: 120,
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
  },
  anzeige: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.2rem',
    minWidth: 360,
  },
  anzeigeLabel: {
    fontSize: 'var(--font-sm)',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  anzeigeWert: {
    fontSize: 'var(--font-hero)',
    fontWeight: 800,
    lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
  },
  anzeigeZeile: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  anzeigeHinweis: {
    marginTop: 'var(--space-xs)',
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    lineHeight: 1.35,
    color: 'var(--text-primary)',
  },
  anzeigeDelta: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--color-accent)',
    fontVariantNumeric: 'tabular-nums',
  },
  fehler: {
    flexShrink: 0,
    padding: 'var(--space-md)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-danger-muted)',
    color: 'var(--color-danger-strong)',
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    lineHeight: 1.4,
    textAlign: 'center',
  },
  uebernehmen: {
    flexShrink: 0,
    minHeight: 88,
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  uebernehmenAus: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-dim)',
    cursor: 'default',
  },
};
