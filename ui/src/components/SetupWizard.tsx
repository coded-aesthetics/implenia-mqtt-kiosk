import { useEffect, useState } from 'react';
import { navigate } from '../hooks/useHashRouter';

/**
 * First-start setup, shown instead of the whole app until this machine has a
 * Verfahren. Service-personnel UI, not worker UI: it is deliberately a
 * multi-step flow, which the worker-facing rules in CLAUDE.md rule out. The
 * glove-sized tap targets, contrast and German still apply.
 *
 * Each step commits its own setting as it completes, so an interrupted setup
 * resumes where it left off instead of starting over.
 */

interface Verfahren {
  key: string;
  label: string;
}

interface Props {
  /** Refetch the active Verfahren in App once it has been set. */
  onVerfahrenSet: () => void;
  hasApiKey: boolean;
}

type Step = 'verfahren' | 'done';

const STEP_TITLES: Record<Step, string> = {
  verfahren: 'Verfahren wählen',
  done: 'Einrichtung abgeschlossen',
};
const STEP_ORDER: Step[] = ['verfahren', 'done'];

export function SetupWizard({ onVerfahrenSet, hasApiKey }: Props) {
  const [step, setStep] = useState<Step>('verfahren');
  const [verfahren, setVerfahren] = useState<Verfahren[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/verfahren')
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setVerfahren(await r.json());
        setListError(null);
      })
      .catch(() =>
        setListError(
          'Die Verfahrensliste konnte nicht geladen werden. Bitte die Seite neu laden.',
        ),
      );
  }, []);

  async function confirmVerfahren() {
    if (!selected || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/verfahren/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verfahren: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(
          body.error ??
            'Das Verfahren konnte nicht gespeichert werden. Bitte erneut versuchen.',
        );
        return;
      }
      onVerfahrenSet();
      setStep('done');
    } catch {
      setSaveError(
        'Die Anwendung ist nicht erreichbar. Bitte die Verbindung prüfen und erneut versuchen.',
      );
    } finally {
      setSaving(false);
    }
  }

  const selectedLabel = verfahren.find((v) => v.key === selected)?.label ?? '';

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>Einrichtung</div>
        <div style={styles.headerStep}>
          Schritt {STEP_ORDER.indexOf(step) + 1} von {STEP_ORDER.length} ·{' '}
          {STEP_TITLES[step]}
        </div>
      </header>

      <main style={styles.main}>
        {step === 'verfahren' && (
          <>
            <h1 style={styles.question}>
              Welches Verfahren wird mit dieser Maschine ausgeführt?
            </h1>

            {listError && <div style={styles.error}>{listError}</div>}

            <div style={styles.grid}>
              {verfahren.map((v) => {
                const isSelected = v.key === selected;
                return (
                  <button
                    key={v.key}
                    onClick={() => { setSelected(v.key); setSaveError(null); }}
                    style={isSelected ? styles.tileSelected : styles.tile}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>

            <div style={styles.warning}>
              Das Verfahren kann später nicht geändert werden. Um ein anderes
              Verfahren zu wählen, muss die Software zurückgesetzt werden —
              dabei gehen alle aufgezeichneten Daten verloren.
            </div>

            {saveError && <div style={styles.error}>{saveError}</div>}

            <button
              onClick={confirmVerfahren}
              disabled={!selected || saving}
              style={selected && !saving ? styles.confirmButton : styles.confirmButtonDisabled}
            >
              {saving
                ? 'Wird gespeichert...'
                : selected
                  ? `${selectedLabel} festlegen`
                  : 'Bitte ein Verfahren wählen'}
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <h1 style={styles.question}>Verfahren festgelegt</h1>
            <div style={styles.doneBox}>
              <div style={styles.doneRow}>
                <span style={styles.doneCheck}>✓</span>
                <span>Verfahren: <strong>{selectedLabel}</strong></span>
              </div>
              <div style={styles.doneRow}>
                <span style={hasApiKey ? styles.doneCheck : styles.doneOpen}>
                  {hasApiKey ? '✓' : '!'}
                </span>
                <span>
                  {hasApiKey
                    ? 'API-Zugang eingerichtet'
                    : 'API-Zugang fehlt noch — ohne ihn können keine Daten hochgeladen werden'}
                </span>
              </div>
            </div>

            <div style={styles.hint}>
              Alle weiteren Einstellungen — API-Zugang, Datenquelle und
              Sensorzuordnung — lassen sich jederzeit in den Einstellungen
              ändern.
            </div>

            <div style={styles.doneActions}>
              <button
                onClick={() => navigate('config')}
                style={styles.confirmButton}
              >
                Einstellungen öffnen
              </button>
              <button
                onClick={() => navigate('')}
                style={styles.secondaryButton}
              >
                Zur Anwendung
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-body)',
    overflow: 'hidden',
  },
  header: {
    padding: 'var(--space-md) var(--space-xl)',
    backgroundColor: 'var(--surface-0)',
    borderBottom: '2px solid var(--border)',
  },
  headerTitle: {
    fontSize: 'var(--font-lg)',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  headerStep: {
    fontSize: 'var(--font-base)',
    color: 'var(--text-muted)',
    marginTop: 'var(--space-xs)',
  },
  main: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 'var(--space-lg)',
    padding: 'var(--space-xl)',
    maxWidth: '900px',
    width: '100%',
    margin: '0 auto',
  },
  question: {
    fontSize: 'var(--font-lg)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    textAlign: 'center',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 'var(--space-md)',
  },
  tile: {
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
    border: '3px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer',
  },
  tileSelected: {
    minHeight: 'var(--tap-min)',
    padding: 'var(--space-lg)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-4)',
    border: '3px solid var(--color-accent)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer',
  },
  warning: {
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    borderLeft: '6px solid var(--color-warning)',
    borderRadius: 'var(--radius-sm)',
  },
  error: {
    padding: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)',
  },
  confirmButton: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--color-accent)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  confirmButtonDisabled: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-3)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'default',
  },
  secondaryButton: {
    minHeight: 'var(--tap-min)',
    padding: '0 var(--space-xl)',
    fontSize: 'var(--font-md)',
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-3)',
    border: '2px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
  },
  doneBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-md)',
    padding: 'var(--space-lg)',
    backgroundColor: 'var(--surface-2)',
    borderRadius: 'var(--radius-lg)',
  },
  doneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    fontSize: 'var(--font-base)',
    color: 'var(--text-primary)',
  },
  doneCheck: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: 'var(--color-success)',
    color: '#fff',
    fontWeight: 700,
  },
  doneOpen: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: 'var(--color-warning)',
    color: '#fff',
    fontWeight: 700,
  },
  hint: {
    fontSize: 'var(--font-base)',
    lineHeight: 1.4,
    color: 'var(--text-muted)',
  },
  doneActions: {
    display: 'flex',
    gap: 'var(--space-md)',
  },
};
