import { navigate } from '../hooks/useHashRouter';
import { configStyles as styles } from './configStyles';

export function MesswerteConfig() {
  return (
    <div style={styles.container}>
      {/* Kalibrierung link */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Kalibrierung</span>
          </div>
          <div style={styles.envHint}>
            Faktor und Versatz je Sensor, wenn ein Messwert nicht in der Einheit
            ankommt, in der er sein sollte. Gehört eigentlich ans Gerät — hier für
            Geräte, an denen das gerade nicht geht.
          </div>
          <button onClick={() => navigate('kalibrierung')} style={styles.presetButtonActive}>
            Kalibrierung öffnen
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
