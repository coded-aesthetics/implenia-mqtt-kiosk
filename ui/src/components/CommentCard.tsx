import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { de } from 'date-fns/locale';
import type { QueuedComment } from '../hooks/useCommentQueue';

/**
 * One queued voice comment: its text, what the upload is doing, and the three
 * things a worker can do about it.
 *
 * Shared by the Kommentare tab (ElementDetail) and the queue page
 * (CommentQueuePage). The two used to carry their own copy of this card and
 * had drifted apart — different button colours, different status-badge sizes,
 * one with `pre-wrap` and one without. Only the container around the card is
 * still per-screen; everything inside it lives here.
 */

/**
 * Literal hex rather than var(--color-*) on purpose: the badge tints its own
 * background by appending an alpha suffix to this colour, and a var()
 * reference cannot be concatenated. Values mirror tokens.css — keep in sync.
 */
export const COMMENT_STATUS: Record<
  QueuedComment['status'],
  { label: string; color: string }
> = {
  transcribing: { label: 'Transkribiert...', color: '#e65100' }, // --color-warning
  ready: { label: 'Bereit', color: '#1976d2' },                  // --color-accent
  sending: { label: 'Sendet...', color: '#1976d2' },             // --color-accent
  sent: { label: 'Gesendet', color: '#4caf50' },                 // --color-success
  error: { label: 'Fehler', color: '#f44336' },                  // --color-danger
};

/**
 * How long ago a comment was recorded.
 *
 * date-fns below a minute says "vor weniger als einer Minute", which is four
 * words for a glance that only needs to answer "just now, or a while back?" —
 * so that one case stays hand-written and the rest is date-fns.
 */
export function commentTimeAgo(timestamp: number): string {
  if (Date.now() - timestamp < 60_000) return 'gerade eben';
  return formatDistanceToNow(timestamp, { addSuffix: true, locale: de });
}

interface Props {
  item: QueuedComment;
  /** The queue page lists comments from every element, so it names each one. */
  showElement?: boolean;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}

export function CommentCard({
  item, showElement = false, onEdit, onDelete, onRetry,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const status = COMMENT_STATUS[item.status];

  function startEdit() {
    setEditValue(item.text);
    setEditing(true);
  }

  function saveEdit() {
    onEdit(item.id, editValue);
    setEditing(false);
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={styles.cardMeta}>
          {showElement && <span style={styles.elementName}>{item.elementName}</span>}
          <span style={styles.timeAgo}>{commentTimeAgo(item.createdAt)}</span>
        </div>
        <div style={{
          ...styles.statusBadge,
          backgroundColor: status.color + '22',
          color: status.color,
        }}>
          <span style={{ ...styles.statusDot, backgroundColor: status.color }} />
          {status.label}
        </div>
      </div>

      {editing ? (
        <div>
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            style={styles.textarea}
            autoFocus
          />
          <div style={styles.actionRow}>
            <button onClick={saveEdit} style={{ ...styles.actionButton, ...styles.saveButton }}>
              Speichern
            </button>
            <button
              onClick={() => setEditing(false)}
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

          <div style={styles.actionRow}>
            {item.status !== 'transcribing' && item.status !== 'sending' && (
              <button onClick={startEdit} style={{ ...styles.actionButton, ...styles.editButton }}>
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

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: 'var(--surface-3)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-md) var(--space-lg)',
    borderLeft: '4px solid var(--border-accent)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-md)',
    marginBottom: 'var(--space-sm)',
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
  },
  elementName: {
    fontSize: 'var(--font-base)',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  timeAgo: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
  },
  statusBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    fontSize: 'var(--font-sm)',
    fontWeight: 600,
    padding: 'var(--space-xs) var(--space-md)',
    borderRadius: 'var(--radius-lg)',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  textContent: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-primary)',
    lineHeight: 1.5,
    marginBottom: 'var(--space-sm)',
    // Dictated comments carry their own line breaks.
    whiteSpace: 'pre-wrap',
  },
  textTranscribing: {
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  errorMessage: {
    fontSize: 'var(--font-sm)',
    color: 'var(--color-danger)',
    marginBottom: 'var(--space-sm)',
    padding: 'var(--space-sm) var(--space-md)',
    backgroundColor: '#f4433611',
    borderRadius: 'var(--radius-sm)',
  },
  textarea: {
    width: '100%',
    minHeight: '100px',
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    backgroundColor: 'var(--surface-0)',
    border: '2px solid var(--border-accent)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    resize: 'vertical',
    marginBottom: 'var(--space-sm)',
  },
  actionRow: {
    display: 'flex',
    gap: 'var(--space-sm)',
    flexWrap: 'wrap',
  },
  actionButton: {
    padding: 'var(--space-sm) var(--space-lg)',
    fontSize: 'var(--font-base)',
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    minHeight: 'var(--tap-min)',
    minWidth: 'var(--tap-min)',
  },
  editButton: {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--text-primary)',
  },
  saveButton: {
    backgroundColor: 'var(--color-success)',
    color: 'var(--text-primary)',
  },
  cancelButton: {
    backgroundColor: 'var(--surface-4)',
    color: 'var(--text-primary)',
  },
  retryButton: {
    backgroundColor: 'var(--color-warning)',
    color: 'var(--text-primary)',
  },
  deleteButton: {
    backgroundColor: 'var(--color-danger)',
    color: 'var(--text-primary)',
  },
};
