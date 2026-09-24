import { useState, useEffect, useCallback } from 'react';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { navigate } from '../hooks/useHashRouter';
import { MqttSettings } from './MqttSettings';
import { DeviceConfig } from './DeviceConfig';
import { configStyles as styles } from './configStyles';

interface Props {
  devMode: boolean;
  deviceFrames: Map<number, DeviceFrame>;
}

export function DatenquelleConfig({ devMode, deviceFrames }: Props) {
  const [transport, setTransport] = useState<'mqtt' | 'serial' | null>(null);
  const [transportConfigured, setTransportConfigured] = useState(true);
  const [pendingDeleteDeviceId, setPendingDeleteDeviceId] = useState<number | null>(null);

  const loadTransport = useCallback(() => {
    fetch('/api/config/transport')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setTransport(d.transport);
        setTransportConfigured(d.configured);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadTransport(); }, [loadTransport]);

  return (
    <div style={styles.container} onClick={() => setPendingDeleteDeviceId(null)}>
      {/* Transport display */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Datenquelle</span>
            {!transportConfigured && (
              <span style={{ ...styles.statusBadge, backgroundColor: '#e65100' }}>
                Nicht gewählt
              </span>
            )}
          </div>
          <div style={styles.settledValue}>
            {transport === 'serial' ? 'Serielle Verbindung (USB)' : 'MQTT-Box'}
          </div>
          <div style={styles.envHint}>
            {transportConfigured
              ? 'Bei der Einrichtung festgelegt. Eine Änderung erfordert ein Zurücksetzen der Software.'
              : 'Es wurde noch keine Datenquelle gewählt. Angezeigt wird die Voreinstellung MQTT-Box.'}
          </div>
        </div>
      </div>

      {transport === 'mqtt' && (
        <>
          <div style={styles.cardWrapper}>
            <div style={styles.card}>
              <div style={styles.statusRow}>
                <span style={styles.label}>MQTT-Einstellungen</span>
              </div>
              <MqttSettings />
            </div>
          </div>

          <div style={styles.cardWrapper}>
            <div style={styles.card}>
              <div style={styles.statusRow}>
                <span style={styles.label}>Sensorzuordnung</span>
              </div>
              <div style={styles.envHint}>
                Welches Topic welchen Sensor liefert. Die Zuordnung gelingt am
                einfachsten, während die Maschine läuft — dann sind die Werte an
                ihrer Bewegung zu erkennen.
              </div>
              <button onClick={() => navigate('sensors')} style={styles.presetButtonActive}>
                Sensorzuordnung öffnen
              </button>
            </div>
          </div>
        </>
      )}

      {transport === 'serial' && (
        <DeviceConfig
          devMode={devMode}
          deviceFrames={deviceFrames}
          pendingDeleteId={pendingDeleteDeviceId}
          onPendingDelete={(id) => setPendingDeleteDeviceId(id)}
        />
      )}
    </div>
  );
}

