import { useState, useRef, useEffect, useCallback } from 'react';
import type { ConfigState } from '../hooks/useImplenia';
import { CardOverlay, type OverlayState } from './CardOverlay';
import { configStyles as styles } from './configStyles';

interface Props {
  config: ConfigState;
}

/**
 * The API-key card is tall enough for its own `CardOverlay`, which is a
 * measured number.
 *
 * An overlay covers its card, so the card's height *is* the message's budget —
 * and this card is the shortest on the screen while carrying the longest
 * message, the one naming measurements left over from the previous
 * construction site. At its content height (229px) that message overflowed by
 * 47px on the kiosk and by nothing at all on a developer Mac: the UI declares
 * no `font-family`, so it renders in whatever the machine has, and the kiosk
 * installs `fonts-dejavu-core` and nothing else — materially wider than any
 * default macOS sans. Measured against a deliberately wide font the overlay
 * needs 276px, and 300 leaves room for a longer one.
 *
 * It costs no space on the screen. The cards sit in a grid whose row is 299px
 * tall already, set by the Server-Adresse card beside it, and 248px of the
 * column below them is empty — so this fills height that was allocated and
 * unused, and two equal-height cards read better than one short one. Deliberately not
 * `alignItems: stretch` on the shared container: that is `start` on purpose
 * (see `column` in configStyles) and would change every config screen,
 * including the Netzwerk one whose two bounded columns are load-bearing.
 */
const keyCardStyle = { minHeight: 300, boxSizing: 'border-box' as const };

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

export function VerbindungConfig({ config }: Props) {
  // ── API key ──────────────────────────────────────────────────────────────
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyOverlay, setKeyOverlay] = useState<OverlayState | null>(null);
  const [pendingDeleteKey, setPendingDeleteKey] = useState(false);
  const [validation, setValidation] = useState<{ status: 'idle' | 'checking' | 'ok' | 'error'; message?: string }>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Server URL ───────────────────────────────────────────────────────────
  const [urlPreset, setUrlPreset] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
  const [urlOverlay, setUrlOverlay] = useState<OverlayState | null>(null);

  useEffect(() => {
    const preset = resolveUrlPreset(config.apiUrl);
    setUrlPreset(preset);
    if (preset === 'custom') setApiUrl(config.apiUrl ?? '');
  }, [config.apiUrl]);

  const validateApi = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    if (config.hasApiKey && config.apiUrl) validateApi();
  }, [config.hasApiKey, config.apiUrl, validateApi]);

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
        // A body that will not parse must not turn an accepted key into
        // „Netzwerkfehler" — it only costs the warning this reads.
        const saved = await res.json().catch(() => ({}));
        setApiKey('');
        const result = await validateApi();
        if (result.ok) {
          config.refetch();
          setKeyOverlay(savedOverlay(saved));
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
    <div style={styles.container} onClick={() => setPendingDeleteKey(false)}>
      {/* API Key card */}
      <div style={styles.cardWrapper}>
        <div style={{ ...styles.card, ...keyCardStyle }}>
          <div style={styles.statusRow}>
            <span style={styles.label}>API-Schlüssel</span>
            <span style={{
              ...styles.statusBadge,
              backgroundColor: validation.status === 'error' ? 'var(--color-danger)'
                : config.hasApiKey ? 'var(--color-success)' : 'var(--color-danger)',
              color: '#fff',
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
                  if (pendingDeleteKey) { handleDelete(); setPendingDeleteKey(false); } else { setPendingDeleteKey(true); }
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

      {/* API URL card */}
      <div style={styles.cardWrapper}>
        <div style={styles.card}>
          <div style={styles.statusRow}>
            <span style={styles.label}>Server-Adresse</span>
            <span style={{
              ...styles.statusBadge,
              backgroundColor: config.apiUrl ? 'var(--color-success)' : 'var(--color-danger)',
              color: '#fff',
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
            {/*
              Not gated on devMode any more. A kiosk runs with
              NODE_ENV=production, so the only way to point one at a local or
              staging backend was to rebuild the UI — or to flip NODE_ENV,
              which crash-loops the server, since the dev logger pulls in
              pino-pretty and the kiosk installs with --omit=dev.

              Nothing was being protected: the server accepts any apiUrl that
              parses, this screen already permits deleting the API key, and the
              value shows up with a live validation badge that makes a wrong
              one obvious. Two taps put it back on Production.
            */}
            <button
              style={urlPreset === 'custom' ? styles.presetButtonActive : styles.presetButton}
              onClick={() => setUrlPreset('custom')}
            >
              Lokal
            </button>
          </div>

          {urlPreset === 'custom' && (
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://192.168.2.50:3000"
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

    </div>
  );
}

/**
 * What to say after the key was saved and accepted.
 *
 * A new key means a new construction site — one per pier on a bridge — and the
 * kiosk has just moved everything it remembers per element with it. The plain
 * success banner is right for that, with one exception worth a line: there are
 * measurements on the machine that are not on the platform yet and belong to a
 * site this kiosk is no longer on.
 *
 * They need nothing from the operator — the kiosk kept each site's key and
 * retries under the right one (site-credentials.ts) — so this states a fact
 * rather than asking for anything. It is said at all because this is the one
 * moment somebody is looking, and because a machine carrying unsent data is a
 * machine that should not be wiped or handed on yet.
 *
 * **Baustellen, plural, and never „der vorherigen".** The server counts every
 * site but the one just switched to, which can be more than one: a crew that
 * has worked three piers may still be carrying the first pier's data when it
 * reaches the third. The singular wording came with a machine-wide count that
 * reported the same total whichever key was entered — a sentence that named a
 * site the number had nothing to do with.
 */
function savedOverlay(saved: {
  siteChanged?: boolean;
  pendingReadings?: { sessions: number; readings: number } | null;
}): OverlayState {
  const pending = saved.siteChanged ? saved.pendingReadings : null;
  if (!pending) {
    return { type: 'success', title: 'API-Schlüssel gespeichert' };
  }
  // 140 characters at seven-digit counts, against a card measured to hold the
  // overlay with room to spare — see `keyCardStyle` and `iconSmall`.
  return {
    type: 'warning',
    title: 'API-Schlüssel gespeichert — Daten anderer Baustellen',
    detail:
      `${pending.readings} Messwerte aus ${pending.sessions} Aufzeichnung(en) anderer `
      + 'Baustellen werden automatisch mit deren Schlüsseln hochgeladen, '
      + 'sobald Verbindung besteht.',
  };
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

