import { useState, useRef, useEffect, useCallback } from 'react';
import type { ConfigState } from '../hooks/useImplenia';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { UpdateUpload } from './UpdateUpload';
import { navigate } from '../hooks/useHashRouter';
import { MqttSettings } from './MqttSettings';
import { RohrwechselSettings } from './RohrwechselSettings';
import { DeviceConfig } from './DeviceConfig';
import { CardOverlay, type OverlayState } from './CardOverlay';
import { ResetCard } from './ResetCard';
import { VoiceCard } from './VoiceCard';
import { configStyles as styles } from './configStyles';

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



export function ConfigPage({ config, devMode, deviceFrames }: Props) {
  // Which data-source section to show. Mirrors the wizard's transport choice.
  const [transport, setTransport] = useState<'mqtt' | 'serial' | null>(null);
  const [transportConfigured, setTransportConfigured] = useState(true);

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

  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyOverlay, setKeyOverlay] = useState<OverlayState | null>(null);
  const [pendingDeleteKey, setPendingDeleteKey] = useState(false);
  const [pendingDeleteDeviceId, setPendingDeleteDeviceId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

      {/* Data source: the transport decides what this section is */}
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
          onPendingDelete={(id) => { setPendingDeleteDeviceId(id); if (id !== null) setPendingDeleteKey(false); }}
        />
      )}

      {/* Applies to every transport and every Verfahren. */}
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

      {/* Applies to both transports: every rotary drilling rig extends its
          Bohrrohr, whatever it is connected by. */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Rohrverlängerung</span>
          </div>
          <RohrwechselSettings />
        </div>
      </div>

      <ResetCard />

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

      <VoiceCard />
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


