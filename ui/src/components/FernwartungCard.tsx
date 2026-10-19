import { useEffect, useState } from 'react';
import { configStyles as styles } from './configStyles';
import { formatAnydeskId } from '../utils/format';

/**
 * The machine's AnyDesk id, so a service tech can reach this kiosk.
 *
 * It is shown because the alternative is a site visit: the id is recorded once
 * during provisioning, and if that record is lost there is no other way to
 * recover it remotely. It is also what a worker reads out over the phone.
 *
 * Nothing here is configurable — unattended access is set up by
 * scripts/provision-kiosk.sh. This is a read-out, and it degrades to saying so.
 */

interface RemoteAccess {
  id: string | null;
  status: 'online' | 'offline' | null;
}

const POLL_MS = 30_000;

export function FernwartungCard() {
  const [state, setState] = useState<RemoteAccess | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = () =>
      fetch('/api/remote-access', { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: RemoteAccess) => {
          setState(data);
          setFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });

    load();
    timer = setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div style={styles.card}>
      <div style={styles.statusRow}>
        <span style={styles.label}>Fernwartung</span>
        {state?.status && (
          <span
            style={{
              ...styles.statusBadge,
              backgroundColor:
                state.status === 'online' ? 'var(--color-success-muted)' : 'var(--color-warning-tint)',
              color: state.status === 'online' ? 'var(--color-success-strong)' : 'var(--color-warning-text)',
            }}
          >
            {state.status === 'online' ? 'Verbunden' : 'Nicht verbunden'}
          </span>
        )}
      </div>

      {state?.id ? (
        <>
          <div style={fernwartungStyles.idLabel}>AnyDesk-ID</div>
          <div style={fernwartungStyles.id}>{formatAnydeskId(state.id)}</div>
          <div style={styles.envHint}>
            Diese Nummer dem Service am Telefon vorlesen. Der Service kann den Bildschirm
            dann ohne Zutun am Gerät übernehmen.
          </div>
        </>
      ) : (
        <div style={styles.envHint}>
          {failed
            ? 'Die Fernwartung konnte nicht abgefragt werden. Das Gerät läuft normal weiter — beim nächsten Öffnen dieser Seite wird es erneut versucht.'
            : state
              ? 'Auf diesem Gerät ist keine Fernwartung eingerichtet. Der Service richtet sie bei der Installation ein (provision-kiosk.sh); die AnyDesk-ID erscheint danach hier.'
              : 'Wird abgefragt …'}
        </div>
      )}
    </div>
  );
}

const fernwartungStyles = {
  idLabel: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-muted)',
    fontWeight: 600,
    marginBottom: 'var(--space-xs)',
  },
  // Read out digit by digit over the phone, so: monospace, large, high contrast.
  id: {
    fontSize: 'var(--font-lg)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '0.04em',
    marginBottom: 'var(--space-md)',
  },
} as const;
