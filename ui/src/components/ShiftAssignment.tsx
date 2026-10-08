import { useRef, useState, useEffect, useCallback } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { ShiftAssignmentState } from '../hooks/useImplenia';

interface Props {
  shift: ShiftAssignmentState;
  hasApiKey: boolean;
  onImport: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onClearImport: () => Promise<void>;
  /** The element a recording is running for, or null. */
  recordingElement?: string | null;
}

interface CompletedElement {
  elementName: string;
  lastUpload: number;
}

function ImportButton({ onImport }: { onImport: Props['onImport'] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    const result = await onImport(file);
    if (!result.ok) setError(result.error ?? 'Import fehlgeschlagen');
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={importing}
        style={styles.importButton}
      >
        {importing ? 'Wird importiert...' : 'Schichtauftrag importieren'}
      </button>
      {error && <div style={styles.importError}>{error}</div>}
    </div>
  );
}

function ImportBadge({ onClear }: { onClear: () => Promise<void> }) {
  const [pending, setPending] = useState(false);

  return (
    <div style={styles.importBadge} onClick={() => setPending(false)}>
      <span style={styles.importBadgeText}>Importiert aus Datei</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (pending) { onClear(); setPending(false); } else { setPending(true); }
        }}
        style={pending ? styles.clearButtonConfirm : styles.clearButton}
      >
        {pending ? 'Wirklich zurücksetzen?' : 'Zurücksetzen'}
      </button>
    </div>
  );
}

function useCompletedElements() {
  const [elements, setElements] = useState<CompletedElement[]>([]);

  const fetchElements = useCallback(() => {
    fetch('/api/recording/completed-elements')
      .then((r) => (r.ok ? r.json() : { elements: [] }))
      .then((data) => setElements(data.elements ?? []))
      .catch(() => setElements([]));
  }, []);

  useEffect(() => { fetchElements(); }, [fetchElements]);

  return elements;
}

/**
 * Re-open an element the operator already uploaded once.
 *
 * Navigation does not wait for the network: a failed clear is recoverable (the
 * next upload sets the date again), so blocking the tap on a round trip would
 * be worse than a stale completion flag. The refetch is chained *after* the
 * clear rather than fired alongside it — the shift assignment only lists
 * unfinished elements, so a refetch that overtook the clear would re-read the
 * list that still excludes this element and change nothing.
 */
function resumeAndOpen(elementName: string, refetch: () => void): void {
  fetch(`/api/elements/${encodeURIComponent(elementName)}/complete`, { method: 'DELETE' })
    .then((r) => { if (r.ok) refetch(); })
    .catch(() => {});
  navigate(`element/${encodeURIComponent(elementName)}`);
}

export function ShiftAssignment({
  shift, hasApiKey, onImport, onClearImport, recordingElement,
}: Props) {
  const isImported = shift.source === 'import';
  const [search, setSearch] = useState('');
  const completedElements = useCompletedElements();

  if (!hasApiKey && !isImported && !shift.loading) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={styles.noticeIcon}>!</div>
          <div style={styles.noticeText}>Kein API-Schlüssel konfiguriert</div>
          <a
            href="#/config"
            onClick={(e) => { e.preventDefault(); navigate('config'); }}
            style={styles.configLink}
          >
            Einstellungen
          </a>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (shift.loading) {
    return (
      <div style={styles.center}>
        <div style={styles.loadingText}>Schichtauftrag wird geladen...</div>
      </div>
    );
  }

  if (shift.error && !isImported) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={{ ...styles.noticeIcon, backgroundColor: 'var(--color-warning)' }}>⚠</div>
          <div style={styles.noticeText}>Verbindungsproblem</div>
          <div style={styles.noticeSubtext}>{shift.error}</div>
          <a
            href="#/config?section=api-url"
            onClick={(e) => { e.preventDefault(); navigate('config?section=api-url'); }}
            style={styles.configLink}
          >
            Einstellungen
          </a>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (shift.notFound && !isImported) {
    const today = new Date().toLocaleDateString('de-DE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={{ ...styles.noticeIcon, backgroundColor: 'var(--color-warning)' }}>⚠</div>
          <div style={styles.noticeText}>
            Kein Schichtauftrag für heute
          </div>
          <div style={styles.noticeSubtext}>
            Bitte erstellen Sie einen Schichtauftrag für {today} im Implenia-Portal.
          </div>
          <div style={styles.divider}>oder</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  if (!shift.data || shift.data.measuring_devices.length === 0) {
    return (
      <div style={styles.center}>
        <div style={styles.notice}>
          <div style={styles.emptyText}>Keine Elemente in der Schichtzuordnung</div>
          <ImportButton onImport={onImport} />
        </div>
      </div>
    );
  }

  const { data } = shift;
  const unfinishedNames = new Set(data.measuring_devices.map((d) => d.name));
  const lower = search.toLowerCase();
  const isSearching = search.length > 0;

  // Already-uploaded elements the operator may want to pick up again. Anything
  // still in the shift assignment belongs in the unfinished grid instead.
  const allStarted = completedElements.filter((e) => !unfinishedNames.has(e.elementName));

  // Two rows of today's work plus one row of elements to resume is what fits at
  // 1024x768. The caps apply to the search results too: the grid is clipped
  // (`overflow: hidden`) and vertically centred, so a search matching a dozen
  // elements would silently cut rows off the top *and* the bottom with no
  // scrollbar and no way to reach them. Truncated, the screen says so and the
  // next typed character narrows it.
  const MAX_UNFINISHED = 6;
  const MAX_STARTED = 3;

  /**
   * The element being recorded comes first.
   *
   * Not cosmetic: six tiles fit and the grid is clipped with no scrollbar, so
   * on a site with a long shift the pillar the rig is in the middle of can be
   * off the screen entirely — which is how a restart could leave a worker
   * looking at a list with no sign of where their own recording went.
   *
   * Only when nothing is typed. Forcing it into search results would show a
   * tile that does not match what was typed, and the recording bar names the
   * element anyway.
   */
  const unfinishedMatches = isSearching
    ? data.measuring_devices.filter((d) => d.name.toLowerCase().includes(lower))
    : [...data.measuring_devices].sort((a, b) =>
      Number(b.name === recordingElement) - Number(a.name === recordingElement));
  /*
   * And the same for the resumed ones, because a running recording can be
   * here instead: "Wiederaufnehmen" clears the completion and refetches, and
   * when that refetch fails — offline, which is the whole scenario this exists
   * for — the element stays listed as begonnen while being recorded. Three
   * tiles fit, so without the hoist it can be cut from the screen entirely.
   */
  const startedMatches = isSearching
    ? allStarted.filter((e) => e.elementName.toLowerCase().includes(lower))
    : [...allStarted].sort((a, b) =>
      Number(b.elementName === recordingElement) - Number(a.elementName === recordingElement));

  const unfinishedTiles = unfinishedMatches.slice(0, MAX_UNFINISHED);
  const startedTiles = startedMatches.slice(0, MAX_STARTED);
  const hiddenCount =
    unfinishedMatches.length - unfinishedTiles.length
    + (startedMatches.length - startedTiles.length);

  const nothingFound = isSearching && unfinishedTiles.length + startedTiles.length === 0;

  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <div style={styles.topBar}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Element suchen..."
            style={styles.searchInput}
          />
        </div>

        <div style={styles.content}>
          {nothingFound && <div style={styles.noResults}>Keine Elemente gefunden</div>}

          {unfinishedTiles.length > 0 && (
            <div style={styles.grid}>
              {unfinishedTiles.map((device) => (
                <button
                  key={device.id}
                  onClick={() => navigate(`element/${encodeURIComponent(device.name)}`)}
                  style={device.name === recordingElement
                    ? { ...styles.tile, ...styles.recordingTile }
                    : styles.tile}
                >
                  <div style={styles.tileName}>{device.name}</div>
                  {device.name === recordingElement && (
                    <div style={styles.recordingBadge}>
                      <span style={styles.recordingDot} />
                      Aufzeichnung läuft
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          {startedTiles.length > 0 && (
            <>
              <div style={styles.sectionLabel}>Begonnene Elemente</div>
              <div style={styles.grid}>
                {startedTiles.map((el) => (
                  <button
                    key={el.elementName}
                    onClick={() => resumeAndOpen(el.elementName, shift.refetch)}
                    style={{
                      ...styles.tile,
                      ...styles.startedTile,
                      ...(el.elementName === recordingElement ? styles.recordingTile : {}),
                    }}
                  >
                    <div style={styles.startedTileName}>{el.elementName}</div>
                    {el.elementName === recordingElement ? (
                      <div style={styles.recordingBadge}>
                        <span style={styles.recordingDot} />
                        Aufzeichnung läuft
                      </div>
                    ) : (
                      <div style={styles.startedTileDate}>
                        {new Date(el.lastUpload).toLocaleDateString('de-DE', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                        })}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {hiddenCount > 0 && (
            <div style={styles.moreHint}>
              {hiddenCount === 1
                ? '1 weiteres Element — Namen eingeben, um es zu finden'
                : `${hiddenCount} weitere Elemente — Namen eingeben, um sie zu finden`}
            </div>
          )}
        </div>

        <div style={styles.bottomBar}>
          {isImported
            ? <ImportBadge onClear={onClearImport} />
            : <ImportButton onImport={onImport} />}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // The vertical spacing here is measured, not chosen: at 1024x768 the full
  // screen (search, six element tiles, the resume row and the import button) is
  // 13px short of fitting while the recording bar is up, so each gap is as
  // small as it can be and still read as a separation.
  page: {
    display: 'flex',
    justifyContent: 'center',
    height: '100%',
    padding: '1.25rem',
    boxSizing: 'border-box' as const,
  },
  // Search and import keep their place while the grids change underneath, so
  // typing into the search never moves the controls out from under a glove.
  inner: {
    width: '100%',
    maxWidth: '900px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  topBar: {
    display: 'flex',
    justifyContent: 'center',
    flexShrink: 0,
    marginBottom: '1rem',
  },
  content: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '0.5rem',
    overflow: 'hidden',
  },
  bottomBar: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    minHeight: '72px',
    marginTop: '1rem',
  },
  searchInput: {
    width: '100%',
    maxWidth: '480px',
    border: '2px solid var(--border)',
    borderRadius: '8px',
    fontSize: '1.1rem',
    padding: '0.75rem 1rem',
    minHeight: '64px',
    boxSizing: 'border-box' as const,
    textAlign: 'center' as const,
    backgroundColor: 'var(--surface-0)',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
    outline: 'none',
  },
  center: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
    height: '100%',
  },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
  },
  noticeIcon: {
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    color: '#fff',
    fontSize: '2rem',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeText: {
    fontSize: '1.3rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  noticeSubtext: {
    fontSize: '1rem',
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
    maxWidth: '400px',
    lineHeight: 1.5,
  },
  configLink: {
    fontSize: '1.1rem',
    color: 'var(--color-accent)',
    textDecoration: 'none',
    padding: '0.75rem 2rem',
    borderRadius: '8px',
    backgroundColor: 'var(--surface-2)',
    fontWeight: 600,
    minHeight: '56px',
    display: 'flex',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: '1.2rem',
    color: 'var(--text-dim)',
  },
  emptyText: {
    fontSize: '1.2rem',
    color: 'var(--text-dim)',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1.25rem',
    width: '100%',
  },
  tile: {
    backgroundColor: 'var(--surface-4)',
    borderRadius: '12px',
    padding: '1.5rem',
    minHeight: '120px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '0.4rem',
    cursor: 'pointer',
    border: '2px solid transparent',
    color: 'var(--text-primary)',
    textAlign: 'center' as const,
    minWidth: '64px',
    fontSize: 'inherit',
    fontFamily: 'inherit',
    overflow: 'hidden',
  },
  tileName: {
    fontSize: '1.8rem',
    fontWeight: 700,
    wordBreak: 'break-word' as const,
  },
  // The element the rig is working on right now. Solid danger-red border and a
  // live dot, so it reads as "this one is running" rather than "this one is
  // selected" — the only tile on the screen that is not merely a choice.
  recordingTile: {
    border: '2px solid var(--color-danger)',
  },
  recordingBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-danger)',
  },
  recordingDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-danger)',
    flexShrink: 0,
  },
  // Dashed border reads as "half finished" — the element has data but is being
  // picked up again.
  startedTile: {
    backgroundColor: 'var(--surface-2)',
    border: '2px dashed var(--border)',
  },
  startedTileName: {
    fontSize: '1.6rem',
    fontWeight: 700,
    wordBreak: 'break-word' as const,
  },
  startedTileDate: {
    fontSize: '1rem',
    color: 'var(--text-muted)',
  },
  sectionLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
  },
  moreHint: {
    fontSize: '1rem',
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  noResults: {
    fontSize: '1.2rem',
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
  },
  divider: {
    fontSize: '1rem',
    color: 'var(--text-dim)',
    margin: '0.25rem 0',
  },
  importButton: {
    fontSize: '1.1rem',
    color: '#fff',
    backgroundColor: 'var(--color-success-strong)',
    border: 'none',
    borderRadius: '8px',
    padding: '0.75rem 2rem',
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: '56px',
    minWidth: '64px',
    fontFamily: 'inherit',
  },
  importError: {
    fontSize: 'var(--font-sm)',
    color: 'var(--color-danger)',
    maxWidth: '360px',
    textAlign: 'center' as const,
    lineHeight: 1.4,
  },
  importBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '0.5rem 1rem',
    backgroundColor: 'var(--color-success-muted)',
    borderRadius: '8px',
  },
  importBadgeText: {
    fontSize: '1rem',
    color: 'var(--color-success)',
    fontWeight: 600,
  },
  clearButton: {
    fontSize: 'var(--font-sm)',
    color: 'var(--color-danger)',
    backgroundColor: 'var(--surface-3)',
    border: 'none',
    borderRadius: '6px',
    padding: '0.4rem 1rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: '40px',
    minWidth: '64px',
    fontWeight: 600,
  },
  clearButtonConfirm: {
    fontSize: 'var(--font-sm)',
    color: '#fff',
    backgroundColor: 'var(--color-danger)',
    border: '1px solid var(--color-danger)',
    borderRadius: '6px',
    padding: '0.4rem 1rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: '40px',
    minWidth: '64px',
    fontWeight: 600,
  },
};
