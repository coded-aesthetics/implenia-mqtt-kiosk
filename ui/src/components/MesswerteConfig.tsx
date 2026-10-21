import { navigate } from '../hooks/useHashRouter';
import { configStyles as styles } from './configStyles';

export function MesswerteConfig() {
  return (
    <div style={styles.container}>
      {/* Datenstrom — where calibration now lives, per channel */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Datenstrom &amp; Kalibrierung</span>
          </div>
          <div style={styles.envHint}>
            Welche Topics ankommen, welchen Sensor jedes bedient und was es
            gerade meldet. Je Kanal mit Verlauf und mit Faktor und Versatz,
            falls ein Messwert nicht in der Einheit ankommt, in der er sein
            sollte.
          </div>
          <button onClick={() => navigate('datenstrom')} style={styles.presetButtonActive}>
            Datenstrom öffnen
          </button>
        </div>
      </div>

      {/* Datenübertragung link */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Datenübertragung</span>
          </div>
          <div style={styles.envHint}>
            Wie viele Messwerte zur Plattform und auf den USB-Stick gehen, und
            auf welchem Weg. Die Aufzeichnung auf dem Kiosk bleibt davon
            unberührt — reduziert wird erst beim Hochladen und beim Export.
          </div>
          <button onClick={() => navigate('config/datenuebertragung')} style={styles.presetButtonActive}>
            Datenübertragung öffnen
          </button>
        </div>
      </div>

      {/* Rohrverlängerung link */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Rohrverlängerung</span>
          </div>
          <div style={styles.envHint}>
            Erkennung und Ausblendung von Rohrwechseln anhand des
            Klemmbacken-Signals. Für Geräte mit Klemmbacke, die beim Rohreinbau
            keine Bohrdaten liefern.
          </div>
          <button onClick={() => navigate('rohrverlaengerung')} style={styles.presetButtonActive}>
            Rohrverlängerung öffnen
          </button>
        </div>
      </div>
    </div>
  );
}
