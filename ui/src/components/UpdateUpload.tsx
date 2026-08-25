import { useState, useRef } from 'react';

export function UpdateUpload() {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    setMessage(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/update/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ text: data.error || 'Upload fehlgeschlagen', error: true });
      } else {
        setMessage({ text: `Version ${data.version} wird installiert...`, error: false });
      }
    } catch {
      setMessage({ text: 'Verbindung zum Server fehlgeschlagen', error: true });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  return (
    <div style={styles.card}>
      <div style={styles.statusRow}>
        <span style={styles.label}>Software-Update</span>
      </div>

      <p style={styles.hint}>
        Update-Datei (.tar.gz) von USB-Stick oder lokalem Laufwerk auswählen und auf den Server hochladen.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".tar.gz,.gz"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />

      <button
        style={{
          ...styles.button,
          opacity: uploading ? 0.5 : 1,
        }}
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? 'Wird hochgeladen...' : 'Update-Datei auswählen'}
      </button>

      {message && (
        <div style={{
          ...styles.message,
          color: message.error ? '#f44336' : '#4caf50',
        }}>
          {message.text}
        </div>
      )}
    </div>
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
    marginBottom: 'var(--space-md)',
  },
  label: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  hint: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    margin: '0 0 var(--space-md) 0',
  },
  button: {
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: 'var(--tap-min)',
    minWidth: 'var(--tap-min)',
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
    width: '100%',
  },
  message: {
    marginTop: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    textAlign: 'center' as const,
  },
};
