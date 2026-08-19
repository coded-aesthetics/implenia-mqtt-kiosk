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
    gap: 'var(--space-lg)',
    padding: 'var(--space-xl)',
    boxSizing: 'border-box' as const,
  },
  card: {
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-lg)',
    width: '100%',
    maxWidth: '500px',
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
    backgroundColor: 'var(--color-danger-muted)',
    color: 'var(--text-primary)',
  },
  message: {
    marginTop: 'var(--space-md)',
    fontSize: 'var(--font-base)',
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
    minHeight: 'var(--tap-sm)',
  },
  expandArrow: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
  },
  urlStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  urlValue: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    wordBreak: 'break-all' as const,
  },
  expandBody: {
    marginTop: '1.25rem',
  },
  envHint: {
    fontSize: '0.95rem',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    marginBottom: 'var(--space-md)',
    padding: '0.75rem var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderRadius: 'var(--radius-md)',
    borderLeft: '3px solid var(--color-accent)',
  },
};
