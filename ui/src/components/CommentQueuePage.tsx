import type { QueuedComment } from '../hooks/useCommentQueue';
import { CommentCard } from './CommentCard';

interface Props {
  queue: QueuedComment[];
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}

/**
 * Every queued comment across all elements. The card itself lives in
 * CommentCard — this screen only decides the list container and that each
 * card names the element it belongs to.
 */
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
          showElement
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
    gap: 'var(--space-md)',
    padding: 'var(--space-lg)',
    boxSizing: 'border-box',
    maxWidth: '700px',
    margin: '0 auto',
    width: '100%',
  },
  emptyState: {
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-md)',
    paddingTop: '3rem',
  },
};
