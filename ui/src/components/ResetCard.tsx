import { useCallback, useEffect, useState } from 'react';
import { pendingCommentCount, clearCommentQueue } from '../hooks/useCommentQueue';
import { configStyles as styles } from './configStyles';

/**
 * Reset this kiosk back to a blank machine.
 *
 * Last card on the page because it is the destructive one, and guarded twice
 * over: the server refuses while readings are neither uploaded nor exported,
 * and this card refuses while voice comments are still queued. Those comments
 * live in localStorage and never reach the server, so the server-side guard
 * cannot see them.
 */
export function ResetCard() {
  const [resetState, setResetState] = useState<{
    allowed: boolean; unsafe: { sessions: number; readings: number; clipped: number };
  } | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // Queued voice comments never reach the server, so the server-side guard
  // cannot count them. Checked here, alongside it.
  const [pendingComments, setPendingComments] = useState(0);

  const loadResetState = useCallback(() => {
    setPendingComments(pendingCommentCount());
    fetch('/api/config/reset')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setResetState(d); })
      .catch(() => {});
  }, []);

  useEffect(() => { loadResetState(); }, [loadResetState]);

  // The queue lives in another component's state, so nothing tells this card
  // when the last comment goes out. Without this the block would stay up until
  // a reload — a dead end in a screen whose whole job is getting unstuck.
  useEffect(() => {
    const id = setInterval(() => setPendingComments(pendingCommentCount()), 3000);
    return () => clearInterval(id);
  }, []);

  async function doReset() {
    setResetError(null);
    // Re-check right before the destructive call: a comment may have been
    // dictated since the page loaded.
    const queued = pendingCommentCount();
    if (queued > 0) {
      setPendingComments(queued);
      setResetPending(false);
      return;
    }
    try {
      const res = await fetch('/api/config/reset', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResetError(body.error ?? 'Zurücksetzen fehlgeschlagen.');
        setResetPending(false);
        loadResetState();
        return;
      }
      // Voice comments live in localStorage, so the server reset cannot clear
      // them — they would otherwise survive into the new configuration. The
      // guard above has already established that none are unsent.
      clearCommentQueue();
      window.location.hash = '#/setup';
      window.location.reload();
    } catch {
      setResetError('Die Anwendung ist nicht erreichbar. Bitte erneut versuchen.');
      setResetPending(false);
    }
  }
  return (
    <div style={styles.cardWrapper}>
      <div style={styles.card}>
        <div style={styles.statusRow}>
          <span style={styles.label}>Software zurücksetzen</span>
        </div>

        <div style={styles.envHint}>
          Löscht Verfahren, Datenquelle, Geräte, Kanal- und Topic-Zuordnungen
          sowie alle aufgezeichneten Daten. API-Schlüssel und Server-Adresse
          bleiben erhalten. Danach startet die Einrichtung neu.
        </div>

        {resetState && !resetState.allowed && (
          <div style={styles.blockedNotice}>
            Zurücksetzen ist gesperrt: {resetState.unsafe.readings} Messwerte aus{' '}
            {resetState.unsafe.sessions} Aufzeichnung(en) sind weder hochgeladen
            noch exportiert. Bitte zuerst hochladen oder als Datei exportieren.
          </div>
        )}

        {/* Clipped readings do not block — they can never be uploaded or
            exported, so they would block forever — but the reset deletes
            them, and saying nothing here is how a mis-clipped shift is lost. */}
        {resetState && resetState.allowed && resetState.unsafe.clipped > 0 && (
          <div style={styles.blockedNotice}>
            Achtung: {resetState.unsafe.clipped} Messwerte wurden als Rohrwechsel
            ausgeblendet und werden mit zurückgesetzt. Falls der Schwellwert der
            Klemmbacke falsch eingestellt war, lassen sie sich vorher in der
            Aufzeichnungs-Leiste freigeben und hochladen.
          </div>
        )}

        {pendingComments > 0 && (
          <div style={styles.blockedNotice}>
            Zurücksetzen ist gesperrt: {pendingComments} Kommentar(e) sind noch
            nicht gesendet und würden gelöscht. Bitte die Kommentare oben in
            der Leiste senden oder löschen.
          </div>
        )}

        {resetError && <div style={styles.blockedNotice}>{resetError}</div>}

        {resetState?.allowed && pendingComments === 0 && (
          <button
            onClick={() => { if (resetPending) doReset(); else setResetPending(true); }}
            onBlur={() => setResetPending(false)}
            style={resetPending ? styles.dangerButtonConfirm : styles.dangerButton}
          >
            {resetPending ? 'Wirklich zurücksetzen?' : 'Zurücksetzen'}
          </button>
        )}
      </div>
    </div>
  );
}
