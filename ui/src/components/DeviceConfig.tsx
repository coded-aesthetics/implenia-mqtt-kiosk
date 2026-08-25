import { useState, useEffect, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { de } from 'date-fns/locale';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { ChannelPicker } from './ChannelPicker';

interface Device {
  id: number;
  label: string;
  port: string | null;
  baud: number;
  type: 'elvis' | 'simulator';
  connected: boolean;
}

interface MappingRow {
  device_id: number;
  value_index: number;
  sensor_name: string;
}

interface Props {
  devMode: boolean;
  deviceFrames: Map<number, DeviceFrame>;
  pendingDeleteId: number | null;
  onPendingDelete: (id: number | null) => void;
}

export function DeviceConfig({ devMode, deviceFrames, pendingDeleteId, onPendingDelete }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formLabel, setFormLabel] = useState('');
  const [formPort, setFormPort] = useState('');
  const [formBaud, setFormBaud] = useState('9600');
  const [formType, setFormType] = useState<'elvis' | 'simulator'>('elvis');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/config/devices');
      if (res.ok) setDevices(await res.json());
    } catch {}
  }, []);

  const fetchAllMappings = useCallback(async () => {
    try {
      const allMappings: MappingRow[] = [];
      const res = await fetch('/api/config/devices');
      if (!res.ok) return;
      const devs: Device[] = await res.json();
      for (const d of devs) {
        const mRes = await fetch(`/api/config/devices/${d.id}/mappings`);
        if (mRes.ok) {
          const rows: MappingRow[] = await mRes.json();
          allMappings.push(...rows);
        }
      }
      setMappings(allMappings);
    } catch {}
  }, []);

  useEffect(() => {
    fetchDevices();
    fetchAllMappings();
  }, [fetchDevices, fetchAllMappings]);

  useEffect(() => () => clearTimeout(msgTimer.current), []);

  function showMessage(msg: { text: string; error: boolean }) {
    clearTimeout(msgTimer.current);
    setMessage(msg);
    if (!msg.error) {
      msgTimer.current = setTimeout(() => setMessage(null), 3000);
    }
  }

  function resetForm() {
    setFormLabel('');
    setFormPort('');
    setFormBaud('9600');
    setFormType('elvis');
    setAdding(false);
    setEditId(null);
  }

  function startEdit(device: Device) {
    setFormLabel(device.label);
    setFormPort(device.port ?? '');
    setFormBaud(String(device.baud));
    setFormType(device.type);
    setEditId(device.id);
    setAdding(false);
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        label: formLabel,
        port: formPort || undefined,
        baud: parseInt(formBaud, 10) || 9600,
      };

      if (editId !== null) {
        const res = await fetch(`/api/config/devices/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          showMessage({ text: data.error || 'Fehler', error: true });
          return;
        }
        showMessage({ text: 'Gerät aktualisiert', error: false });
      } else {
        body.type = formType;
        const res = await fetch('/api/config/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          showMessage({ text: data.error || 'Fehler', error: true });
          return;
        }
        showMessage({ text: 'Gerät hinzugefügt', error: false });
      }
      resetForm();
      fetchDevices();
    } catch {
      showMessage({ text: 'Netzwerkfehler', error: true });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await fetch(`/api/config/devices/${id}`, { method: 'DELETE' });
      fetchDevices();
      fetchAllMappings();
    } catch {}
  }

  function getMappingCount(deviceId: number): number {
    return mappings.filter((m) => m.device_id === deviceId).length;
  }

  const showForm = adding || editId !== null;

  return (
    <>
      <div style={styles.card}>
        <div style={styles.statusRow}>
          <span style={styles.label}>Geräte &amp; Sensorzuordnung</span>
          <span style={{
            ...styles.statusBadge,
            backgroundColor: devices.length > 0 ? '#1b5e20' : '#b71c1c',
          }}>
            {devices.length > 0 ? `${devices.length} Gerät${devices.length > 1 ? 'e' : ''}` : 'Keine Geräte'}
          </span>
        </div>

        {/* Device list */}
        {devices.map((device) => {
          const frame = deviceFrames.get(device.id);
          const mappedCount = getMappingCount(device.id);

          return (
            <div key={device.id} style={styles.deviceRow}>
              <div style={styles.deviceInfo}>
                <div style={styles.deviceHeader}>
                  <span style={{
                    ...styles.connectionDot,
                    backgroundColor: device.connected ? '#4caf50' : '#f44336',
                  }} />
                  <span style={styles.deviceLabel}>{device.label}</span>
                  <span style={{
                    ...styles.typeBadge,
                    backgroundColor: device.type === 'simulator' ? '#6a1b9a' : 'var(--color-accent)',
                  }}>
                    {device.type === 'simulator' ? 'SIM' : 'ELWS'}
                  </span>
                </div>
                <div style={styles.deviceMeta}>
                  {device.port && <span>{device.port} @ {device.baud}</span>}
                  <span>{mappedCount} von 15 Kanälen zugeordnet</span>
                  {frame && (
                    <span>
                      Letzte Daten:<br />
                      {formatDistanceToNow(frame.receivedAt, { addSuffix: true, locale: de })}
                    </span>
                  )}
                </div>
              </div>
              <div style={styles.deviceActions}>
                <button
                  style={styles.actionButton}
                  onClick={() => startEdit(device)}
                >
                  Bearbeiten
                </button>
                <button
                  style={pendingDeleteId === device.id ? styles.deleteActionConfirm : { ...styles.actionButton, ...styles.deleteAction }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pendingDeleteId === device.id) { handleDelete(device.id); onPendingDelete(null); } else { onPendingDelete(device.id); }
                  }}
                >
                  {pendingDeleteId === device.id ? <>Wirklich<br />entfernen?</> : 'Entfernen'}
                </button>
              </div>
            </div>
          );
        })}

        {/* Add/edit form */}
        {showForm && (
          <div style={styles.form}>
            <input
              type="text"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder="Bezeichnung (z.B. Bohrgerät)"
              style={styles.input}
              autoComplete="off"
            />
            {editId === null && devMode && (
              <div style={styles.typeSelector}>
                <button
                  style={formType === 'elvis' ? styles.typeButtonActive : styles.typeButton}
                  onClick={() => setFormType('elvis')}
                >
                  Elvis (Seriell)
                </button>
                <button
                  style={formType === 'simulator' ? styles.typeButtonActive : styles.typeButton}
                  onClick={() => setFormType('simulator')}
                >
                  Simulator
                </button>
              </div>
            )}
            {formType === 'elvis' && (
              <input
                type="text"
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder="Port (z.B. /dev/ttyUSB0)"
                style={styles.input}
                autoComplete="off"
              />
            )}
            {formType === 'elvis' && <input
              type="number"
              value={formBaud}
              onChange={(e) => setFormBaud(e.target.value)}
              placeholder="Baudrate"
              style={{ ...styles.input, maxWidth: '200px' }}
              autoComplete="off"
            />}
            <div style={styles.buttonRow}>
              <button
                onClick={handleSave}
                disabled={saving || !formLabel.trim()}
                style={{
                  ...styles.button,
                  ...styles.saveButton,
                  opacity: saving || !formLabel.trim() ? 0.5 : 1,
                }}
              >
                Speichern
              </button>
              <button
                onClick={resetForm}
                style={styles.cancelButton}
              >
                Abbrechen
              </button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={styles.bottomActions}>
          {!showForm && (
            <button
              onClick={() => { resetForm(); setAdding(true); }}
              style={{ ...styles.button, ...styles.addButton }}
            >
              Gerät hinzufügen
            </button>
          )}
          {devices.length > 0 && !showForm && (
            <button
              onClick={() => setPickerOpen(true)}
              style={{ ...styles.button, ...styles.mappingButton }}
            >
              Sensorzuordnung
            </button>
          )}
        </div>

        {message && (
          <div style={{
            ...styles.message,
            color: message.error ? '#f44336' : '#4caf50',
          }}>
            {message.text}
          </div>
        )}
      </div>

      {pickerOpen && (
        <ChannelPicker
          devices={devices}
          deviceFrames={deviceFrames}
          mappings={mappings}
          onMappingsChanged={fetchAllMappings}
          onClose={() => { setPickerOpen(false); fetchAllMappings(); }}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-lg)',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 'var(--space-lg)',
  },
  label: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  statusBadge: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-primary)',
    padding: '4px 12px',
    borderRadius: 'var(--radius-lg)',
    fontWeight: 600,
  },
  deviceRow: {
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-md)',
    marginBottom: 'var(--space-sm)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-md)',
    flexWrap: 'wrap' as const,
  },
  deviceInfo: {
    flex: 1,
    minWidth: 0,
  },
  deviceHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    marginBottom: '4px',
  },
  connectionDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  deviceLabel: {
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  typeBadge: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-primary)',
    padding: '2px 8px',
    borderRadius: '4px',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  },
  deviceMeta: {
    display: 'flex',
    gap: 'var(--space-md)',
    fontSize: 'var(--font-sm)',
    color: 'var(--text-secondary)',
    flexWrap: 'wrap' as const,
    marginLeft: '18px',
  },
  deviceActions: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--space-xs)',
    flexShrink: 0,
  },
  actionButton: {
    padding: '6px 12px',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-secondary)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  deleteAction: {
    color: 'var(--color-danger)',
  },
  deleteActionConfirm: {
    padding: '6px 12px',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--space-sm)',
    padding: 'var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    marginBottom: 'var(--space-md)',
  },
  input: {
    width: '100%',
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    backgroundColor: 'var(--surface-1)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box' as const,
    minHeight: '56px',
  },
  typeSelector: {
    display: 'flex',
    gap: '2px',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  typeButton: {
    flex: 1,
    padding: 'var(--space-md)',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  typeButtonActive: {
    flex: 1,
    padding: 'var(--space-md)',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
    border: 'none',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
  },
  buttonRow: {
    display: 'flex',
    gap: 'var(--space-md)',
    marginTop: 'var(--space-xs)',
  },
  button: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: '56px',
    minWidth: 'var(--tap-min)',
  },
  saveButton: {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
    flex: 1,
  },
  cancelButton: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-secondary)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: '56px',
  },
  bottomActions: {
    display: 'flex',
    gap: 'var(--space-md)',
    marginTop: 'var(--space-md)',
    flexWrap: 'wrap' as const,
  },
  addButton: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-secondary)',
    flex: 1,
  },
  mappingButton: {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
    flex: 1,
  },
  message: {
    marginTop: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    textAlign: 'center' as const,
  },
};
