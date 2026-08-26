import { useState, useEffect, useMemo } from 'react';
import type { DeviceFrame } from '../hooks/useWebSocket';

interface Device {
  id: number;
  label: string;
  type: 'elvis' | 'simulator';
  connected: boolean;
}

interface MappingRow {
  device_id: number;
  value_index: number;
  sensor_name: string;
}

interface MqttSensor {
  name: string;
  type: string;
  unit: string;
  alias: string;
}

interface Props {
  devices: Device[];
  deviceFrames: Map<number, DeviceFrame>;
  mappings: MappingRow[];
  onClose: () => void;
  onMappingsChanged: () => void;
}

const CHANNEL_COUNT = 15;

export function ChannelPicker({ devices, deviceFrames, mappings, onClose, onMappingsChanged }: Props) {
  const [sensors, setSensors] = useState<MqttSensor[]>([]);
  const [selectedSensor, setSelectedSensor] = useState<MqttSensor | null>(null);
  const [pendingUnassign, setPendingUnassign] = useState<string | null>(null);
  const [pendingReset, setPendingReset] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/verfahren/dsv/sensors?source=mqtt')
      .then(async (r) => {
        if (!r.ok) return;
        setSensors(await r.json());
      })
      .catch(() => {});
  }, []);

  const mappingLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of mappings) {
      map.set(`${m.device_id}:${m.value_index}`, m.sensor_name);
    }
    return map;
  }, [mappings]);

  const reverseLookup = useMemo(() => {
    const map = new Map<string, { deviceId: number; deviceLabel: string; valueIndex: number }>();
    for (const m of mappings) {
      const device = devices.find((d) => d.id === m.device_id);
      map.set(m.sensor_name, {
        deviceId: m.device_id,
        deviceLabel: device?.label ?? `Gerät ${m.device_id}`,
        valueIndex: m.value_index,
      });
    }
    return map;
  }, [mappings, devices]);

  async function assignChannel(deviceId: number, valueIndex: number) {
    if (!selectedSensor || saving) return;

    setSaving(true);
    try {
      const existingRes = await fetch(`/api/config/devices/${deviceId}/mappings`);
      const existing: MappingRow[] = existingRes.ok ? await existingRes.json() : [];

      const updated = existing
        .filter((m) => m.value_index !== valueIndex && m.sensor_name !== selectedSensor.name)
        .map((m) => ({ valueIndex: m.value_index, sensorName: m.sensor_name }));
      updated.push({ valueIndex, sensorName: selectedSensor.name });

      await fetch(`/api/config/devices/${deviceId}/mappings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: updated }),
      });

      for (const otherDevice of devices) {
        if (otherDevice.id === deviceId) continue;
        const otherRes = await fetch(`/api/config/devices/${otherDevice.id}/mappings`);
        if (!otherRes.ok) continue;
        const otherMappings: MappingRow[] = await otherRes.json();
        const hadSensor = otherMappings.some((m) => m.sensor_name === selectedSensor.name);
        if (hadSensor) {
          const cleaned = otherMappings
            .filter((m) => m.sensor_name !== selectedSensor.name)
            .map((m) => ({ valueIndex: m.value_index, sensorName: m.sensor_name }));
          await fetch(`/api/config/devices/${otherDevice.id}/mappings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mappings: cleaned }),
          });
        }
      }

      onMappingsChanged();
      setSelectedSensor(null);
    } catch {
    } finally {
      setSaving(false);
    }
  }

  async function unassignSensor(sensorName: string) {
    if (saving) return;
    setSaving(true);
    try {
      for (const device of devices) {
        const res = await fetch(`/api/config/devices/${device.id}/mappings`);
        if (!res.ok) continue;
        const rows: MappingRow[] = await res.json();
        if (!rows.some((m) => m.sensor_name === sensorName)) continue;
        const cleaned = rows
          .filter((m) => m.sensor_name !== sensorName)
          .map((m) => ({ valueIndex: m.value_index, sensorName: m.sensor_name }));
        await fetch(`/api/config/devices/${device.id}/mappings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings: cleaned }),
        });
      }
      onMappingsChanged();
    } catch {
    } finally {
      setSaving(false);
    }
  }

  async function resetAllMappings() {
    if (saving) return;
    setSaving(true);
    try {
      for (const device of devices) {
        await fetch(`/api/config/devices/${device.id}/mappings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings: [] }),
        });
      }
      onMappingsChanged();
      setPendingReset(false);
    } catch {
    } finally {
      setSaving(false);
    }
  }

  const hasAnyAssignment = mappings.length > 0;

  function clearPending() {
    setPendingUnassign(null);
    setPendingReset(false);
  }

  // Step 1: Sensor list
  if (!selectedSensor) {
    return (
      <div style={styles.overlay} onClick={clearPending}>
        <div style={styles.panel}>
          <div style={styles.header}>
            <h2 style={styles.title}>Sensorzuordnung</h2>
            <div style={styles.headerActions}>
              {hasAnyAssignment && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pendingReset) { resetAllMappings(); } else { setPendingUnassign(null); setPendingReset(true); }
                  }}
                  disabled={saving}
                  style={pendingReset ? styles.resetButtonConfirm : styles.resetButton}
                >
                  {pendingReset ? 'Wirklich zurücksetzen?' : 'Alle zurücksetzen'}
                </button>
              )}
              <button onClick={onClose} style={styles.closeButton}>Schließen</button>
            </div>
          </div>

          {sensors.length === 0 && (
            <div style={styles.hint}>
              Sensordefinitionen werden geladen...
            </div>
          )}

          {sensors.length > 0 && (
            <div style={styles.helpText}>
              Antippen um Kanal zuzuweisen. Zugewiesenen Sensor antippen um Zuordnung aufzuheben.
            </div>
          )}

          <div style={styles.sensorGrid}>
            {sensors.map((sensor) => {
              const assignment = reverseLookup.get(sensor.name);
              const isPending = pendingUnassign === sensor.name;

              function handleTap() {
                setPendingReset(false);
                if (isPending) {
                  unassignSensor(sensor.name);
                  setPendingUnassign(null);
                } else if (assignment) {
                  setPendingUnassign(sensor.name);
                } else {
                  setPendingUnassign(null);
                  setSelectedSensor(sensor);
                }
              }

              return (
                <button
                  key={sensor.name}
                  style={{
                    ...styles.sensorTile,
                    ...(isPending ? styles.sensorTilePending : assignment ? styles.sensorTileAssigned : {}),
                  }}
                  onClick={(e) => { e.stopPropagation(); handleTap(); }}
                  disabled={saving}
                >
                  <span style={styles.sensorName}>{sensor.name}</span>
                  {isPending ? (
                    <span style={styles.pendingLabel}>Wirklich aufheben?</span>
                  ) : (
                    <>
                      {sensor.unit && <span style={styles.sensorUnit}>{sensor.unit}</span>}
                      <span style={assignment ? styles.assigned : styles.unassigned}>
                        {assignment
                          ? `${assignment.deviceLabel} · Kanal ${assignment.valueIndex}`
                          : 'Nicht zugeordnet'}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Channel grid with live values
  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <div>
            <button onClick={() => setSelectedSensor(null)} style={styles.backButton}>← Zurück</button>
            <h2 style={styles.channelTitle}>
              Quelle für <span style={styles.highlight}>{selectedSensor.name}</span> wählen
              {selectedSensor.unit && <span style={styles.channelUnit}> ({selectedSensor.unit})</span>}
            </h2>
          </div>
        </div>

        {devices.map((device) => {
          const frame = deviceFrames.get(device.id);
          return (
            <div key={device.id} style={styles.deviceSection}>
              <div style={styles.deviceSectionHeader}>
                <span style={{
                  ...styles.connectionDot,
                  backgroundColor: device.connected ? '#4caf50' : '#f44336',
                }} />
                <span style={styles.deviceSectionLabel}>{device.label}</span>
                <span style={{
                  ...styles.typeBadgeSmall,
                  backgroundColor: device.type === 'simulator' ? '#6a1b9a' : 'var(--color-accent)',
                }}>
                  {device.type === 'simulator' ? 'SIM' : 'ELWS'}
                </span>
              </div>
              <div style={styles.channelGrid}>
                {Array.from({ length: CHANNEL_COUNT }, (_, i) => {
                  const value = frame?.values[i];
                  const mappedSensor = mappingLookup.get(`${device.id}:${i}`);
                  const isCurrentSensor = mappedSensor === selectedSensor.name;

                  if (mappedSensor && !isCurrentSensor) return null;

                  return (
                    <button
                      key={i}
                      style={{
                        ...styles.channelCell,
                        ...(isCurrentSensor ? styles.channelCellActive : {}),
                        ...(saving ? { opacity: 0.5, pointerEvents: 'none' as const } : {}),
                      }}
                      onClick={() => assignChannel(device.id, i)}
                    >
                      <span style={styles.channelIndex}>Kanal {i}</span>
                      <span style={styles.channelValue}>
                        {value !== undefined ? value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–'}
                      </span>
                      {isCurrentSensor && (
                        <span style={styles.channelCurrent}>● Zugeordnet</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'var(--surface-1)',
    zIndex: 1000,
    overflow: 'auto',
  },
  panel: {
    padding: 'var(--space-lg)',
    maxWidth: '1024px',
    margin: '0 auto',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 'var(--space-lg)',
    flexShrink: 0,
  },
  title: {
    fontSize: 'var(--font-lg)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
  },
  headerActions: {
    display: 'flex',
    gap: 'var(--space-sm)',
    alignItems: 'center',
  },
  closeButton: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-secondary)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  resetButton: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  resetButtonConfirm: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  backButton: {
    padding: '0.5rem 1rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'transparent',
    color: 'var(--color-accent)',
    border: 'none',
    cursor: 'pointer',
    marginBottom: 'var(--space-xs)',
    paddingLeft: 0,
  },
  channelTitle: {
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
  },
  channelUnit: {
    fontSize: 'var(--font-base)',
    fontWeight: 400,
    color: 'var(--text-muted)',
  },
  highlight: {
    color: 'var(--color-accent)',
  },
  hint: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    padding: 'var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-accent)',
    marginBottom: 'var(--space-md)',
  },
  sensorGrid: {
    flex: 1,
    overflow: 'auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 'var(--space-sm)',
    alignContent: 'start',
  },
  helpText: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    marginBottom: 'var(--space-sm)',
    flexShrink: 0,
  },
  sensorTile: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-sm)',
    backgroundColor: 'var(--surface-2)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: '80px',
    textAlign: 'center' as const,
    gap: '2px',
  },
  sensorTileAssigned: {
    borderColor: 'var(--color-success)',
  },
  sensorTilePending: {
    borderColor: 'var(--color-danger)',
    backgroundColor: 'var(--color-danger)',
  },
  pendingLabel: {
    fontSize: 'var(--font-sm)',
    color: '#fff',
    fontWeight: 600,
  },
  sensorName: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.2,
  },
  sensorUnit: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
  assigned: {
    fontSize: 'var(--font-sm)',
    color: 'var(--color-success)',
    fontWeight: 600,
  },
  unassigned: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
  deviceSection: {
    marginBottom: 'var(--space-lg)',
  },
  deviceSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    marginBottom: 'var(--space-sm)',
  },
  connectionDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  deviceSectionLabel: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  typeBadgeSmall: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-primary)',
    padding: '2px 8px',
    borderRadius: '4px',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  },
  channelGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 'var(--space-sm)',
  },
  channelCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-sm) var(--space-xs)',
    backgroundColor: 'var(--surface-2)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: '90px',
    transition: 'border-color 0.15s',
  },
  channelCellActive: {
    borderColor: 'var(--color-accent)',
    backgroundColor: 'var(--surface-3)',
  },
  channelIndex: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '2px',
  },
  channelValue: {
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.2,
  },
  channelMapped: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    marginTop: '2px',
    textAlign: 'center' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '100%',
  },
  channelCurrent: {
    fontSize: 'var(--font-sm)',
    color: 'var(--color-accent)',
    fontWeight: 700,
    marginTop: '2px',
  },
};
