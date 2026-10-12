import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { SensorReading } from '../hooks/useWebSocket';
import type { VorgabenData, VerfahrenSensorsState } from '../hooks/useImplenia';
import { findSoll, findSensorNumber } from '../utils/sensors';
import { formatNumber } from '../utils/format';
import { RotationDial } from './RotationDial';
import { NeigungDial } from './NeigungDial';
import {
  bewerteHorizontal, bewerteVertikal, sensorFuerRolle,
  ROLLE_HORIZONTAL, ROLLE_VERTIKAL, VORGABE_HORIZONTAL, VORGABE_VERTIKAL,
  TOLERANZ_HORIZONTAL, TOLERANZ_VERTIKAL, VERALTET_MS,
  type AusrichtungStatus, type Bewertung,
} from '../utils/ausrichtung';

/**
 * Aiming the rig before drilling: turn it until the rotation matches, set the
 * mast until the inclination matches.
 *
 * Two controls, nothing else — the one thing the operator is doing at that
 * moment. Each shows the live angle as a number and as a pointer, the Soll as
 * a green mark with its tolerance band, and underneath, in words, which way to
 * move. The words are not decoration: colour alone cannot say "nach rechts",
 * and that is the whole instruction.
 *
 * **It never blocks.** The screen is reached and left through the phase
 * stepper, there is no confirmation, and nothing here gates the recording: a
 * machine can be drilled without ever opening it. A missing angle, a missing
 * Vorgabe or a dead topic degrade to a named state with a way out, because the
 * alternative — a worker stuck in front of a dial that says nothing — costs
 * drilling time.
 *
 * The sensor name under each title is deliberate. The live angles are found by
 * **role** (`inclination_x` / `inclination_y`), and which of a rig's two axes
 * is which is not written down anywhere — so the screen says which sensor it
 * is reading, and a swapped pair is one glance away instead of a wrongly
 * turned machine.
 */

interface Props {
  readings: Map<string, SensorReading>;
  vorgaben: VorgabenData | null;
  /**
   * The active Verfahren's sensors from the local CSV, **with their load
   * state** — "still loading" and "could not be loaded" must not read as "this
   * Verfahren has no angle sensors", which is a different message and a far
   * more final one.
   */
  sensoren: VerfahrenSensorsState;
}

/** Re-render on a timer so an angle that stopped arriving goes stale on screen. */
function useJetzt(intervalMs: number): number {
  const [jetzt, setJetzt] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setJetzt(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return jetzt;
}

/** The deviation's own three tones, plus one for "no judgement possible". */
type Ton = AusrichtungStatus | 'neutral';

const DREH_PFEIL = 'M4 12a8 8 0 1 1 2.3 5.6M4 18v-4h4';
const HAKEN = 'M4 12.5 9.5 18 20 6';
const NEIGEN = 'M6 4v16M6 20h14M6 7l11 11';
const STEILER = 'M6 4v16M6 20h14M6 7l6 13';
const UHR = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2.5';

interface Streifen {
  ton: Ton;
  text: string;
  iconPath: string;
  spiegeln?: boolean;
}

/** What the bar under a dial says, and in which tone. */
function streifen(
  bewertung: Bewertung | null,
  soll: number | null,
  ist: { receivedAt: number } | null,
  veraltet: boolean,
  jetzt: number,
  art: 'rotation' | 'neigung',
  laedt: boolean,
): Streifen {
  if (laedt) {
    return { ton: 'neutral', text: 'Sensoren werden geladen …', iconPath: UHR };
  }
  if (soll === null) {
    return { ton: 'neutral', text: 'Keine Vorgabe', iconPath: UHR };
  }
  if (ist === null) {
    return { ton: 'neutral', text: 'Kein Signal', iconPath: UHR };
  }
  if (veraltet) {
    const sek = Math.max(0, Math.round((jetzt - ist.receivedAt) / 1000));
    return { ton: 'neutral', text: `Letzter Wert vor ${sek} s`, iconPath: UHR };
  }
  if (!bewertung) {
    return { ton: 'neutral', text: 'Kein Signal', iconPath: UHR };
  }
  if (bewertung.status === 'ok') {
    return { ton: 'ok', text: bewertung.hinweis, iconPath: HAKEN };
  }
  if (art === 'rotation') {
    return {
      ton: bewertung.status,
      text: bewertung.hinweis,
      iconPath: DREH_PFEIL,
      spiegeln: bewertung.abweichung > 0,
    };
  }
  return {
    ton: bewertung.status,
    text: bewertung.hinweis,
    iconPath: bewertung.abweichung > 0 ? NEIGEN : STEILER,
  };
}

/**
 * The line under a dial's title: which sensor it is reading, and where 0 is.
 *
 * "Kein Sensor zugeordnet" is a verdict, so it waits for the CSV to have
 * actually answered.
 */
function untertitel(name: string | null, laedt: boolean, nullpunkt: string): string {
  if (name) return `${name} · ${nullpunkt}`;
  return laedt ? 'Sensoren werden geladen …' : 'Kein Sensor zugeordnet';
}

export function AusrichtenScreen({ readings, vorgaben, sensoren }: Props) {
  const jetzt = useJetzt(1000);

  const { sensoren: liste, status: sensorStatus, neuLaden } = sensoren;
  const laedt = sensorStatus === 'laedt';

  const hName = sensorFuerRolle(liste, ROLLE_HORIZONTAL);
  const vName = sensorFuerRolle(liste, ROLLE_VERTIKAL);

  const hSoll = findSoll(vorgaben, VORGABE_HORIZONTAL);
  const vSoll = findSoll(vorgaben, VORGABE_VERTIKAL);

  const hIst = hName ? findSensorNumber(readings, hName) : null;
  const vIst = vName ? findSensorNumber(readings, vName) : null;

  const hVeraltet = hIst !== null && jetzt - hIst.receivedAt > VERALTET_MS;
  const vVeraltet = vIst !== null && jetzt - vIst.receivedAt > VERALTET_MS;

  const hBewertung = hIst !== null && hSoll !== null && !hVeraltet
    ? bewerteHorizontal(hIst.value, hSoll, TOLERANZ_HORIZONTAL)
    : null;
  const vBewertung = vIst !== null && vSoll !== null && !vVeraltet
    ? bewerteVertikal(vIst.value, vSoll, TOLERANZ_VERTIKAL)
    : null;

  /*
   * One hint at a time, the most blocking first, and each one says what to do
   * about it. A sensor with no topic is the only one with a button: it is
   * fixable on the kiosk, which is where the button goes.
   */
  const ohneTopic = [
    hName && hIst === null ? hName : null,
    vName && vIst === null ? vName : null,
  ].filter((n): n is string => n !== null);

  let hinweis: { text: string; aktion?: { label: string; onClick: () => void } } | null = null;
  if (sensorStatus === 'fehler') {
    hinweis = {
      text: 'Die Sensorliste dieses Verfahrens konnte nicht geladen werden. '
        + 'Der Kiosk versucht es automatisch weiter — oder jetzt sofort erneut laden.',
      aktion: { label: 'Erneut laden', onClick: neuLaden },
    };
  } else if (laedt) {
    // Nothing to say yet, and "keine Winkelsensoren" would be a lie.
  } else if (!hName || !vName) {
    hinweis = {
      text: 'Für dieses Verfahren sind keine Winkelsensoren definiert. '
        + 'Das Ausrichten steht hier nicht zur Verfügung.',
    };
  } else if (ohneTopic.length > 0) {
    hinweis = {
      text: `Für ${ohneTopic.map((n) => `„${n}"`).join(' und ')} kommt kein Wert an. `
        + 'Bitte in der Sensorzuordnung das passende Topic zuordnen.',
      aktion: { label: 'Sensorzuordnung', onClick: () => navigate('sensors') },
    };
  } else if (hSoll === null || vSoll === null) {
    const fehlend = [
      hSoll === null ? VORGABE_HORIZONTAL : null,
      vSoll === null ? VORGABE_VERTIKAL : null,
    ].filter((n): n is string => n !== null);
    hinweis = {
      text: `Im Schichtauftrag fehlt ${fehlend.map((n) => `„${n}"`).join(' und ')}. `
        + 'Ohne Vorgabe kann hier nicht ausgerichtet werden — bitte den Schichtauftrag prüfen.',
    };
  }

  return (
    <div style={styles.container}>
      <div style={styles.reihe}>
        <Karte
          titel="Horizontalneigung"
          untertitel={untertitel(hName, laedt, '0° = Referenzrichtung')}
          soll={hSoll}
          streifen={streifen(hBewertung, hSoll, hIst, hVeraltet, jetzt, 'rotation', laedt)}
        >
          <RotationDial
            ist={hIst?.value ?? null}
            soll={hSoll}
            toleranz={TOLERANZ_HORIZONTAL}
            veraltet={hVeraltet}
          />
        </Karte>

        <Karte
          titel="Vertikalneigung"
          untertitel={untertitel(vName, laedt, '0° = senkrecht')}
          soll={vSoll}
          streifen={streifen(vBewertung, vSoll, vIst, vVeraltet, jetzt, 'neigung', laedt)}
        >
          <NeigungDial
            ist={vIst?.value ?? null}
            soll={vSoll}
            toleranz={TOLERANZ_VERTIKAL}
            veraltet={vVeraltet}
          />
        </Karte>
      </div>

      {hinweis && (
        <div style={styles.hinweis}>
          <span style={styles.hinweisText}>{hinweis.text}</span>
          {hinweis.aktion && (
            <button style={styles.hinweisButton} onClick={hinweis.aktion.onClick}>
              {hinweis.aktion.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface KartenProps {
  titel: string;
  untertitel: string;
  soll: number | null;
  streifen: Streifen;
  children: ReactNode;
}

function Karte({ titel, untertitel, soll, streifen: s, children }: KartenProps) {
  return (
    <section style={styles.karte}>
      <div style={styles.kopf}>
        <div style={styles.kopfText}>
          <span style={styles.kartenTitel}>{titel}</span>
          <span style={styles.kartenMeta}>{untertitel}</span>
        </div>
        <span style={soll === null ? styles.sollChipFehlt : styles.sollChip}>
          {soll === null ? 'Keine Vorgabe' : `Soll ${formatNumber(soll, 1)}°`}
        </span>
      </div>

      {/*
        The dial takes whatever is left between the heading and the bar, and
        centres itself in it. Fixed sizes left a band of dead space under the
        dial on a screen with no recording bar and threatened to overflow one
        with a hint row — on a display where nothing may ever scroll.
      */}
      <div style={styles.dialBereich}>{children}</div>

      <div style={{ ...styles.streifen, ...TON_STYLE[s.ton] }}>
        <svg
          width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ flexShrink: 0, transform: s.spiegeln ? 'scaleX(-1)' : undefined }}
        >
          <path d={s.iconPath} />
        </svg>
        <span style={styles.streifenText}>{s.text}</span>
      </div>
    </section>
  );
}

const TON_STYLE: Record<Ton, CSSProperties> = {
  ok: { backgroundColor: 'var(--color-success-muted)', color: 'var(--color-success-strong)' },
  nah: { backgroundColor: 'var(--color-warning-tint)', color: 'var(--color-warning-text)' },
  weit: { backgroundColor: 'var(--color-danger-tint)', color: 'var(--color-danger-strong)' },
  neutral: { backgroundColor: 'var(--surface-3)', color: 'var(--text-primary)' },
};

const styles: Record<string, CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    padding: 'var(--space-md)',
  },
  reihe: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 'var(--space-lg)',
  },
  karte: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    padding: 'var(--space-sm) var(--space-md)',
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
  },
  dialBereich: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  kopf: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-sm)',
  },
  kopfText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  kartenTitel: {
    fontSize: 'var(--font-md)',
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  },
  kartenMeta: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  sollChip: {
    padding: '0.2rem 0.7rem',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-success-muted)',
    color: 'var(--color-success-strong)',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    whiteSpace: 'nowrap',
  },
  sollChipFehlt: {
    padding: '0.2rem 0.7rem',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-warning-tint)',
    color: 'var(--color-warning-text)',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    whiteSpace: 'nowrap',
  },
  streifen: {
    width: '100%',
    minHeight: 76,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-md)',
    borderRadius: 'var(--radius-md)',
  },
  streifenText: {
    fontSize: 'var(--font-lg)',
    fontWeight: 800,
    whiteSpace: 'nowrap',
  },
  hinweis: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    padding: 'var(--space-sm) var(--space-md)',
    backgroundColor: 'var(--color-warning-tint)',
    border: '1px solid var(--color-warning)',
    borderRadius: 'var(--radius-md)',
  },
  hinweisText: {
    flex: 1,
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--color-warning-text)',
  },
  hinweisButton: {
    minHeight: 'var(--tap-min)',
    minWidth: 'var(--tap-min)',
    padding: '0 var(--space-lg)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: 'var(--font-base)',
    fontWeight: 800,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
