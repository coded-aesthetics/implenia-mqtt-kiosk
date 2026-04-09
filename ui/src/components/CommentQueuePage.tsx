import { useState } from 'react';
import type { QueuedComment } from '../hooks/useCommentQueue';

interface Props {
  queue: QueuedComment[];
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}

const STATUS_CONFIG: Record<QueuedComment['status'], { label: string; color: string }> = {
  transcribing: { label: 'Transkribiert...', color: '#e6a700' },
  ready: { label: 'Bereit', color: '#4a90d9' },
  sending: { label: 'Sendet...', color: '#4a90d9' },
  sent: { label: 'Gesendet', color: '#4caf50' },
  error: { label: 'Fehler', color: '#f44336' },
};

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'gerade eben';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  return `vor ${hours} Std.`;
}

function CommentCard({
  item, onEdit, onDelete, onRetry,
}: {
  item: QueuedComment;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const status = STATUS_CONFIG[item.status];

  function startEdit() {
    setEditValue(item.text);
    setEditing(true);
  }

  function saveEdit() {
    onEdit(item.id, editValue);
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
  }

  return (
    <div style={styles.card}>
      {/* Header row: element name + status + time */}
      <div style={styles.cardHeader}>
        <div style={styles.cardMeta}>
          <span style={styles.elementName}>{item.elementName}</span>
          <span style={styles.timeAgo}>{timeAgo(item.createdAt)}</span>
        </div>
        <div style={{ ...styles.statusBadge, backgroundColor: status.color + '22', color: status.color }}>
          <span style={{ ...styles.statusDot, backgroundColor: status.color }} />
          {status.label}
        </div>
      </div>

      {/* Text content or edit textarea */}
      {editing ? (
        <div>
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            style={styles.textarea}
            autoFocus
          />
          <div style={styles.actionRow}>
            <button
              onClick={saveEdit}
              style={{ ...styles.actionButton, ...styles.saveButton }}
            >
              Speichern
            </button>
            <button
              onClick={cancelEdit}
              style={{ ...styles.actionButton, ...styles.cancelButton }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{
            ...styles.textContent,
            ...(item.status === 'transcribing' ? styles.textTranscribing : {}),
          }}>
            {item.text || '...'}
          </div>

          {item.errorMessage && (
            <div style={styles.errorMessage}>{item.errorMessage}</div>
          )}

          {/* Action buttons */}
          <div style={styles.actionRow}>
            {item.status !== 'transcribing' && item.status !== 'sending' && (
              <button
                onClick={startEdit}
                style={{ ...styles.actionButton, ...styles.editButton }}
              >
                Bearbeiten
              </button>
            )}
            {item.status === 'error' && (
              <button
                onClick={() => onRetry(item.id)}
                style={{ ...styles.actionButton, ...styles.retryButton }}
              >
                Erneut senden
              </button>
            )}
            <button
              onClick={() => onDelete(item.id)}
              style={{ ...styles.actionButton, ...styles.deleteButton }}
            >
              Löschen
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function CommentQueuePage({ queue, onEdit, onDelete, onRetry }: Props) {
  if (queue.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>Keine Kommentare</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {queue.map((item) => (
        <CommentCard
          key={item.id}
          item={item}
          onEdit={onEdit}
          onDelete={onDelete}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    padding: '1.5rem',
    boxSizing: 'border-box' as const,
    maxWidth: '700px',
    margin: '0 auto',
    width: '100%',
  },
  emptyState: {
    textAlign: 'center' as const,
    color: '#8899aa',
    fontSize: '1.2rem',
    paddingTop: '3rem',
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '1.25rem',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  elementName: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: '#ffffff',
  },
  timeAgo: {
    fontSize: '0.9rem',
    color: '#8899aa',
  },
  statusBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: '12px',
  },
  statusDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  textContent: {
    fontSize: '1.05rem',
    color: '#e0e0e0',
    lineHeight: 1.5,
    marginBottom: '0.75rem',
  },
  textTranscribing: {
    color: '#8899aa',
    fontStyle: 'italic' as const,
  },
  errorMessage: {
    fontSize: '0.9rem',
    color: '#f44336',
    marginBottom: '0.75rem',
    padding: '0.5rem 0.75rem',
    backgroundColor: '#f4433611',
    borderRadius: '6px',
  },
  textarea: {
    width: '100%',
    minHeight: '100px',
    padding: '1rem',
    fontSize: '1.05rem',
    backgroundColor: '#0f0f23',
    border: '2px solid #4a90d9',
    borderRadius: '8px',
    color: '#ffffff',
    outline: 'none',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    resize: 'vertical' as const,
    marginBottom: '0.75rem',
  },
  actionRow: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  actionButton: {
    padding: '0.6rem 1.25rem',
    fontSize: '1rem',
    fontWeight: 600,
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    minHeight: '48px',
    minWidth: '64px',
  },
  editButton: {
    backgroundColor: '#1976d2',
    color: '#ffffff',
  },
  saveButton: {
    backgroundColor: '#4caf50',
    color: '#ffffff',
  },
  cancelButton: {
    backgroundColor: '#555555',
    color: '#ffffff',
  },
  retryButton: {
    backgroundColor: '#e6a700',
    color: '#000000',
  },
  deleteButton: {
    backgroundColor: '#c62828',
    color: '#ffffff',
  },
};
