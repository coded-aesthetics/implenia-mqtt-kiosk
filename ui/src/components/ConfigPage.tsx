import { useState, useRef, useEffect } from 'react';
import type { ConfigState } from '../hooks/useImplenia';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { UpdateUpload } from './UpdateUpload';
import { DeviceConfig } from './DeviceConfig';

interface Props {
  config: ConfigState;
  devMode: boolean;
  deviceFrames: Map<number, DeviceFrame>;
}

const API_URLS: Record<string, string> = {
  production: 'https://api.imp-ice-messtechnik.de',
  development: 'https://implenia-machines-backend-dev.fly.dev',
};

function resolveUrlPreset(url: string | null | undefined): string {
  if (!url) return '';
  for (const [key, value] of Object.entries(API_URLS)) {
    if (url.replace(/\/+$/, '') === value.replace(/\/+$/, '')) return key;
  }
  return 'custom';
}

interface OverlayState {
  type: 'success' | 'error';
  title: string;
  detail?: string;
}

function CardOverlay({ overlay, onDismiss }: { overlay: OverlayState; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (overlay.type === 'success') {
      const id = setTimeout(() => dismissRef.current(), 2500);
      return () => clearTimeout(id);
    }
  }, [overlay.type]);

  const isError = overlay.type === 'error';

  return (
    <div
      style={{
        ...overlayStyles.backdrop,
        backgroundColor: isError ? 'rgba(183, 28, 28, 0.95)' : 'rgba(27, 94, 32, 0.95)',
      }}
      onClick={(e) => { e.stopPropagation(); onDismiss(); }}
    >
      <div style={overlayStyles.icon}>{isError ? '✕' : '✓'}</div>
      <div style={overlayStyles.title}>{overlay.title}</div>
      {overlay.detail && <div style={overlayStyles.detail}>{overlay.detail}</div>}
      {isError && <div style={overlayStyles.dismissHint}>Antippen zum Schließen</div>}
    </div>
  );
}

export function ConfigPage({ config, devMode, deviceFrames }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyOverlay, setKeyOverlay] = useState<OverlayState | null>(null);
  const [pendingDeleteKey, setPendingDeleteKey] = useState(false);
  const [pendingDeleteDeviceId, setPendingDeleteDeviceId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // API URL section
  const [urlPreset, setUrlPreset] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
  const [urlOverlay, setUrlOverlay] = useState<OverlayState | null>(null);
  const [validation, setValidation] = useState<{ status: 'idle' | 'checking' | 'ok' | 'error'; message?: string }>({ status: 'idle' });

  useEffect(() => {
    const preset = resolveUrlPreset(config.apiUrl);
    setUrlPreset(preset);
    if (preset === 'custom') setApiUrl(config.apiUrl ?? '');
  }, [config.apiUrl]);

  useEffect(() => {
    if (config.hasApiKey && config.apiUrl) validateApi();
  }, [config.hasApiKey, config.apiUrl]);

  async function validateApi() {
    setValidation({ status: 'checking' });
    try {
      const res = await fetch('/api/config/validate');
      const data = await res.json();
      if (data.ok) {
        setValidation({ status: 'ok', message: data.deviceName ? `Verbunden als „${data.deviceName}"` : 'Verbindung erfolgreich' });
      } else {
        setValidation({ status: 'error', message: data.error });
      }
      return data;
    } catch {
      setValidation({ status: 'error', message: 'Netzwerkfehler bei der Überprüfung' });
      return { ok: false, error: 'Netzwerkfehler' };
    }
  }

  // Magic word setting
  const [magicWord, setMagicWord] = useState(
    () => localStorage.getItem('magicWordEnabled') === 'true',
  );

  function toggleMagicWord() {
    const next = !magicWord;
    setMagicWord(next);
    localStorage.setItem('magicWordEnabled', String(next));
    window.dispatchEvent(new Event('magicWordChanged'));
  }

  async function handleSave() {
    const key = apiKey.trim();
    if (!key) return;

    try {
      const json = atob(key);
      JSON.parse(json);
    } catch {
      setKeyOverlay({
        type: 'error',
        title: 'Ungültiges Format',
        detail: 'Der Schlüssel scheint ungültig formatiert zu sein. Bitte den vollständigen Schlüssel aus dem Implenia-Portal kopieren.',
      });
      return;
    }

    setSaving(true);
    setKeyOverlay(null);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });

      if (res.ok) {
        setApiKey('');
        const result = await validateApi();
        if (result.ok) {
          config.refetch();
          setKeyOverlay({ type: 'success', title: 'API-Schlüssel gespeichert' });
        } else {
          try {
            await fetch('/api/config/api-key', { method: 'DELETE' });
          } catch {
            // If delete fails, key stays stored — refetch will show it, user can retry
          }
          setValidation({ status: 'idle' });
          config.refetch();
          const detail = deriveKeyErrorDetail(result.error);
          setKeyOverlay({ type: 'error', title: 'API-Schlüssel abgelehnt', detail });
        }
      } else {
        const data = await res.json();
        setKeyOverlay({ type: 'error', title: 'Fehler beim Speichern', detail: data.error });
      }
    } catch {
      setKeyOverlay({ type: 'error', title: 'Netzwerkfehler', detail: 'Server nicht erreichbar' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setKeyOverlay(null);

    try {
      await fetch('/api/config/api-key', { method: 'DELETE' });
      setKeyOverlay({ type: 'success', title: 'API-Schlüssel entfernt' });
      setValidation({ status: 'idle' });
      config.refetch();
    } catch {
      setKeyOverlay({ type: 'error', title: 'Fehler beim Entfernen' });
    } finally {
      setSaving(false);
    }
  }

  async function handleUrlSave() {
    const url = urlPreset === 'custom' ? apiUrl.trim() : API_URLS[urlPreset];
    if (!url) return;
    setUrlSaving(true);
    setUrlOverlay(null);

    try {
      const res = await fetch('/api/config/api-url', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiUrl: url }),
      });

      if (res.ok) {
        setApiUrl('');
        config.refetch();
        if (config.hasApiKey) {
          const result = await validateApi();
          if (result.ok) {
            setUrlOverlay({ type: 'success', title: 'Server-Adresse gespeichert' });
          } else {
            setUrlOverlay({ type: 'error', title: 'Server-Adresse gespeichert', detail: `Verbindungstest fehlgeschlagen: ${result.error}` });
          }
        } else {
          setUrlOverlay({ type: 'success', title: 'Server-Adresse gespeichert' });
        }
      } else {
        const data = await res.json();
        setUrlOverlay({ type: 'error', title: 'Fehler beim Speichern', detail: data.error });
      }
    } catch {
      setUrlOverlay({ type: 'error', title: 'Netzwerkfehler', detail: 'Server nicht erreichbar' });
    } finally {
      setUrlSaving(false);
    }
  }

  return (
    <div style={styles.container} onClick={() => { setPendingDeleteKey(false); setPendingDeleteDeviceId(null); }}>
      {/* API Key card */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>API-Schlüssel</span>
            <span style={{
              ...styles.statusBadge,
              backgroundColor: validation.status === 'error' ? '#b71c1c'
                : config.hasApiKey ? '#1b5e20' : '#b71c1c',
            }}>
              {validation.status === 'checking' ? 'Wird geprüft...'
                : validation.status === 'error' ? validation.message
                : config.hasApiKey ? 'Konfiguriert' : 'Nicht konfiguriert'}
            </span>
          </div>

          <input
            ref={inputRef}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API-Schlüssel eingeben"
            style={styles.input}
            autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />

          <div style={styles.buttonRow}>
            <button
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
              style={{
                ...styles.button,
                ...styles.saveButton,
                opacity: saving || !apiKey.trim() ? 0.5 : 1,
              }}
            >
              Speichern
            </button>

            {config.hasApiKey && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (pendingDeleteKey) { handleDelete(); setPendingDeleteKey(false); } else { setPendingDeleteKey(true); setPendingDeleteDeviceId(null); }
                }}
                disabled={saving}
                style={{
                  ...styles.button,
                  ...(pendingDeleteKey ? styles.deleteButtonConfirm : styles.deleteButton),
                  opacity: saving ? 0.5 : 1,
                }}
              >
                {pendingDeleteKey ? 'Wirklich entfernen?' : 'Schlüssel entfernen'}
              </button>
            )}
          </div>

        </div>
        {keyOverlay && <CardOverlay overlay={keyOverlay} onDismiss={() => setKeyOverlay(null)} />}
      </div>

      {/* Software Update card */}
      <UpdateUpload />

      {/* Device config + sensor mapping */}
      <DeviceConfig
        devMode={devMode}
        deviceFrames={deviceFrames}
        pendingDeleteId={pendingDeleteDeviceId}
        onPendingDelete={(id) => { setPendingDeleteDeviceId(id); if (id !== null) setPendingDeleteKey(false); }}
      />

      {/* API URL card */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Server-Adresse</span>
            <span style={{
              ...styles.statusBadge,
              backgroundColor: config.apiUrl ? '#1b5e20' : '#b71c1c',
            }}>
              {config.apiUrl
                ? (() => {
                    const preset = resolveUrlPreset(config.apiUrl);
                    const label = preset === 'production' ? 'Production' : preset === 'development' ? 'Development' : config.apiUrl;
                    return config.apiUrlSource === 'env' ? `${label} (.env)` : label;
                  })()
                : 'Nicht konfiguriert'}
            </span>
          </div>

          {config.apiUrlSource === 'env' && (
            <div style={styles.envHint}>
              Die URL ist über die .env-Datei gesetzt. Ein hier eingegebener Wert hat Vorrang vor der .env-Konfiguration.
            </div>
          )}

          <div style={styles.presetRow}>
            <button
              style={urlPreset === 'production' ? styles.presetButtonActive : styles.presetButton}
              onClick={() => setUrlPreset('production')}
            >
              Production
            </button>
            <button
              style={urlPreset === 'development' ? styles.presetButtonActive : styles.presetButton}
              onClick={() => setUrlPreset('development')}
            >
              Development
            </button>
            {devMode && (
              <button
                style={urlPreset === 'custom' ? styles.presetButtonActive : styles.presetButton}
                onClick={() => setUrlPreset('custom')}
              >
                Lokal
              </button>
            )}
          </div>

          {urlPreset === 'custom' && (
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://localhost:3000"
              style={styles.input}
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter') handleUrlSave(); }}
            />
          )}

          <div style={styles.buttonRow}>
            <button
              onClick={handleUrlSave}
              disabled={urlSaving || (!urlPreset || (urlPreset === 'custom' && !apiUrl.trim()))}
              style={{
                ...styles.button,
                ...styles.saveButton,
                opacity: urlSaving || (!urlPreset || (urlPreset === 'custom' && !apiUrl.trim())) ? 0.5 : 1,
              }}
            >
              Speichern
            </button>
          </div>
        </div>
        {urlOverlay && <CardOverlay overlay={urlOverlay} onDismiss={() => setUrlOverlay(null)} />}
      </div>

      {/* Magic word card */}
      <div style={styles.card}>
        <div style={styles.statusRow}>
          <span style={styles.label}>Sprachaktivierung (experimentell)</span>
        </div>
        <button
          onClick={toggleMagicWord}
          style={{
            ...styles.toggleButton,
            backgroundColor: magicWord ? '#1b5e20' : '#2a2a4a',
          }}
        >
          <span style={{
            ...styles.toggleKnob,
            transform: magicWord ? 'translateX(32px)' : 'translateX(0)',
          }} />
        </button>
        <div style={styles.toggleLabel}>
          {magicWord ? 'Aktiviert' : 'Deaktiviert'}
        </div>
        <div style={styles.envHint}>
          Sagen Sie &quot;Computer&quot; gefolgt von einem Befehl. Das Mikrofon bleibt dauerhaft aktiv.
        </div>
      </div>
    </div>
  );
}

function deriveKeyErrorDetail(apiError: string | undefined): string {
  if (apiError === 'wrong_device_type') {
    return 'Dieser API-Schlüssel gehört nicht zu einem Messgerät mit Schichtzuordnung.';
  }
  if (apiError?.includes('401') || apiError?.includes('403') || apiError?.includes('Ungültig')) {
    return 'Dieser API-Schlüssel ist evtl. für einen anderen Server. Bitte Server-Adresse prüfen.';
  }
  return apiError ?? 'Verbindungstest fehlgeschlagen';
}

const overlayStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-sm)',
    padding: 'var(--space-lg)',
    zIndex: 1,
  },
  icon: {
    fontSize: '4rem',
    fontWeight: 700,
    color: '#fff',
    lineHeight: 1,
  },
  title: {
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    color: '#fff',
    textAlign: 'center',
  },
  detail: {
    fontSize: 'var(--font-base)',
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    lineHeight: 1.4,
    maxWidth: '90%',
  },
  dismissHint: {
    fontSize: 'var(--font-sm)',
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 'var(--space-sm)',
  },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
    alignItems: 'start',
    gap: 'var(--space-lg)',
    padding: 'var(--space-xl)',
    boxSizing: 'border-box' as const,
  },
  cardWrapper: {
    position: 'relative',
  },
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
  input: {
    width: '100%',
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    backgroundColor: 'var(--surface-0)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box' as const,
    minHeight: '56px',
  },
  buttonRow: {
    display: 'flex',
    gap: 'var(--space-md)',
    marginTop: 'var(--space-md)',
    flexWrap: 'wrap' as const,
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
  deleteButton: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--color-danger)',
  },
  deleteButtonConfirm: {
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
  },
  presetRow: {
    display: 'flex',
    gap: '2px',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    marginBottom: 'var(--space-md)',
  },
  presetButton: {
    flex: 1,
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--surface-0)',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
    fontFamily: 'inherit',
  },
  presetButtonActive: {
    flex: 1,
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
    border: 'none',
    cursor: 'pointer',
    minHeight: 'var(--tap-sm)',
    fontFamily: 'inherit',
  },
  envHint: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    marginBottom: 'var(--space-md)',
    padding: '0.75rem var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-accent)',
  },
  toggleButton: {
    position: 'relative' as const,
    width: '72px',
    height: '40px',
    borderRadius: '20px',
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.2s ease',
    padding: 0,
    minHeight: '40px',
  },
  toggleKnob: {
    display: 'block',
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    backgroundColor: '#ffffff',
    transition: 'transform 0.2s ease',
    margin: '4px',
  },
  toggleLabel: {
    fontSize: '1rem',
    color: '#cccccc',
    marginTop: '0.5rem',
    marginBottom: '0.75rem',
  },
};
