import { useState, useRef } from 'react';
import type { ConfigState } from '../hooks/useImplenia';

interface Props {
  config: ConfigState;
  expandSection?: string;
}

export function ConfigPage({ config, expandSection }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // API URL section
  const [apiUrlOpen, setApiUrlOpen] = useState(expandSection === 'api-url');
  const [apiUrl, setApiUrl] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
  const [urlMessage, setUrlMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function handleSave() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });

      if (res.ok) {
        setApiKey('');
        setMessage({ text: 'API-Schlüssel gespeichert', error: false });
        config.refetch();
      } else {
        const data = await res.json();
        setMessage({ text: data.error || 'Fehler beim Speichern', error: true });
      }
    } catch {
      setMessage({ text: 'Netzwerkfehler', error: true });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setMessage(null);

    try {
      await fetch('/api/config', { method: 'DELETE' });
      setMessage({ text: 'API-Schlüssel entfernt', error: false });
      config.refetch();
    } catch {
      setMessage({ text: 'Fehler beim Entfernen', error: true });
    } finally {
      setSaving(false);
    }
  }

  async function handleUrlSave() {
    const trimmed = apiUrl.trim();
    if (!trimmed) return;
    setUrlSaving(true);
    setUrlMessage(null);

    try {
      const res = await fetch('/api/config/api-url', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiUrl: trimmed }),
      });

      if (res.ok) {
        setApiUrl('');
        setUrlMessage({ text: 'API-URL gespeichert', error: false });
        config.refetch();
      } else {
        const data = await res.json();
        setUrlMessage({ text: data.error || 'Fehler beim Speichern', error: true });
      }
    } catch {
      setUrlMessage({ text: 'Netzwerkfehler', error: true });
    } finally {
      setUrlSaving(false);
    }
  }

  return (
    <div style={styles.container}>
      {/* API Key card */}
      <div style={styles.card}>
        <div style={styles.statusRow}>
          <span style={styles.label}>API-Schlüssel</span>
          <span style={{
            ...styles.statusBadge,
            backgroundColor: config.hasApiKey ? '#1b5e20' : '#b71c1c',
          }}>
            {config.hasApiKey ? 'Konfiguriert' : 'Nicht konfiguriert'}
          </span>
        </div>

        <input
          ref={inputRef}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API-Token eingeben"
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
              onClick={handleDelete}
              disabled={saving}
              style={{
                ...styles.button,
                ...styles.deleteButton,
                opacity: saving ? 0.5 : 1,
              }}
            >
              Schlüssel entfernen
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

      {/* API URL expandable card */}
      <div style={styles.card}>
        <button
          onClick={() => setApiUrlOpen(!apiUrlOpen)}
          style={styles.expandHeader}
        >
          <span style={styles.label}>API-URL (Server-Adresse)</span>
          <span style={styles.expandArrow}>{apiUrlOpen ? '▲' : '▼'}</span>
        </button>

        {/* Status line — always visible */}
        {config.apiUrl ? (
          <div style={styles.urlStatus}>
            <span style={{ ...styles.statusBadge, backgroundColor: '#1b5e20' }}>
              {config.apiUrlSource === 'env' ? 'Konfiguriert (.env)' : 'Konfiguriert'}
            </span>
            <span style={styles.urlValue}>{config.apiUrl}</span>
          </div>
        ) : (
          <div style={styles.urlStatus}>
            <span style={{ ...styles.statusBadge, backgroundColor: '#b71c1c' }}>
              Nicht konfiguriert
            </span>
          </div>
        )}

        {apiUrlOpen && (
          <div style={styles.expandBody}>
            {config.apiUrlSource === 'env' && (
              <div style={styles.envHint}>
                Die URL ist über die .env-Datei gesetzt. Ein hier eingegebener Wert hat Vorrang vor der .env-Konfiguration.
              </div>
            )}

            {!config.apiUrl && (
              <div style={styles.envHint}>
                Tragen Sie die Implenia-API-URL hier ein, oder setzen Sie IMPLENIA_API_URL in der .env-Datei im Projektverzeichnis und starten Sie den Server neu.
              </div>
            )}

            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.implenia.example.com"
              style={styles.input}
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter') handleUrlSave(); }}
            />

            <div style={styles.buttonRow}>
              <button
                onClick={handleUrlSave}
                disabled={urlSaving || !apiUrl.trim()}
                style={{
                  ...styles.button,
                  ...styles.saveButton,
                  opacity: urlSaving || !apiUrl.trim() ? 0.5 : 1,
                }}
              >
                Speichern
              </button>
            </div>

            {urlMessage && (
              <div style={{
                ...styles.message,
                color: urlMessage.error ? '#f44336' : '#4caf50',
              }}>
                {urlMessage.text}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1.5rem',
    padding: '2rem',
    boxSizing: 'border-box' as const,
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '1.5rem',
    width: '100%',
    maxWidth: '500px',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  label: {
    fontSize: '1.1rem',
    color: '#cccccc',
    fontWeight: 600,
  },
  statusBadge: {
    fontSize: '0.85rem',
    color: '#ffffff',
    padding: '4px 12px',
    borderRadius: '12px',
    fontWeight: 600,
  },
  input: {
    width: '100%',
    padding: '1rem',
    fontSize: '1.1rem',
    backgroundColor: '#0f0f23',
    border: '2px solid #2a2a4a',
    borderRadius: '8px',
    color: '#ffffff',
    outline: 'none',
    boxSizing: 'border-box' as const,
    minHeight: '56px',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1rem',
    flexWrap: 'wrap' as const,
  },
  button: {
    padding: '0.75rem 1.5rem',
    fontSize: '1.1rem',
    fontWeight: 600,
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    minHeight: '56px',
    minWidth: '64px',
  },
  saveButton: {
    backgroundColor: '#1976d2',
    color: '#ffffff',
    flex: 1,
  },
  deleteButton: {
    backgroundColor: '#c62828',
    color: '#ffffff',
  },
  message: {
    marginTop: '1rem',
    fontSize: '1rem',
    fontWeight: 600,
    textAlign: 'center' as const,
  },
  expandHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    marginBottom: '0.75rem',
    minHeight: '48px',
  },
  expandArrow: {
    fontSize: '1rem',
    color: '#8899aa',
  },
  urlStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  urlValue: {
    fontSize: '0.9rem',
    color: '#8899aa',
    wordBreak: 'break-all' as const,
  },
  expandBody: {
    marginTop: '1.25rem',
  },
  envHint: {
    fontSize: '0.95rem',
    color: '#8899aa',
    lineHeight: 1.5,
    marginBottom: '1rem',
    padding: '0.75rem 1rem',
    backgroundColor: '#0f0f23',
    borderRadius: '8px',
    borderLeft: '3px solid #1976d2',
  },
};
