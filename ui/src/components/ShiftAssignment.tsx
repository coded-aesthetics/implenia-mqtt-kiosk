import { useRef, useState, useEffect, useCallback } from 'react';
import { navigate } from '../hooks/useHashRouter';
import type { ShiftAssignmentState } from '../hooks/useImplenia';
import { fortschrittText } from '../utils/fortschritt';

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

/** An element this kiosk holds recordings for, as `started-elements` reports it. */
interface StartedElement {
  elementName: string;
  /** The deepest drilling depth recorded here, or 0 when there is none. */
  tiefe: number;
  letzteAufzeichnung: number;
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

/**
 * Says that the list on screen is the platform's last word, not today's.
 *
 * Beside the import button rather than instead of the grid: the list is the
 * screen a worker starts from and an unreachable backend must not take it away
 * (see shift-cache.ts). But a day-old list of unfinished elements that looked
 * live would be worse than the error screen it replaces, so the date it was
 * taken is on screen, in the same place the „Importiert aus Datei" badge sits.
 *
 * The date is written out as a day and a time, never as „vor 15 Stunden": the
 * question the operator has is whether this is from *this shift*, and a
 * relative age makes them do arithmetic to find out.
 */
function CacheBadge({ cachedAt }: { cachedAt: number | null }) {
  const stand = cachedAt === null
    ? null
    : new Date(cachedAt).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });

  return (
    <div style={styles.cacheBadge}>
      <span style={styles.cacheBadgeIcon}>⚠</span>
      <div>
        <div style={styles.cacheBadgeText}>Implenia-Server nicht erreichbar</div>
        {stand && <div style={styles.cacheBadgeSub}>Liste vom {stand}</div>}
      </div>
    </div>
  );
}

/**
 * Which elements this kiosk has already recorded, and how deep they got.
 *
 * Separate from `useCompletedElements`, which answers the other question —
 * "is this element finished" — and moves a tile into the resume row. An
 * element that was paused is *unfinished*, so it stays in the main grid, and
 * before this it looked exactly like one nobody had touched: same tile, same
 * nothing. That is how somebody re-drills a hole another shift is halfway
 * through.
 *
 * Refetched whenever the recording stops or starts, because the depth is
 * written when the session ends — so the tile carries it the moment the worker
 * comes back to the list.
 */
function useStartedElements(recordingElement?: string | null) {
  const [elements, setElements] = useState<StartedElement[]>([]);

  useEffect(() => {
    let aktuell = true;
    fetch('/api/recording/started-elements')
      .then((r) => (r.ok ? r.json() : { elements: [] }))
      .then((data) => { if (aktuell) setElements(data.elements ?? []); })
      .catch(() => { if (aktuell) setElements([]); });
    return () => { aktuell = false; };
  }, [recordingElement]);

  return elements;
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
  const isCached = shift.source === 'cache';
  const [search, setSearch] = useState('');
  const completedElements = useCompletedElements();
  const startedElements = useStartedElements(recordingElement);

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
          {/*
            The way out of the error, and the reason it is the first thing
            offered: the fetch is owned above the router, so leaving the screen
            and coming back used to change nothing. Without this the only exits
            were the settings screen and a file import — neither of which helps
            when the problem was a passing one.
          */}
          <button
            type="button"
            onClick={() => shift.refetch()}
            style={styles.retryButton}
          >
            Erneut versuchen
          </button>
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
  const fortschritt = new Map(startedElements.map((e) => [e.elementName, e]));

  /*
   * While a recording runs, the only element that can be opened is the one
   * being recorded.
   *
   * Not a restriction for its own sake: the element screens draw the *rig's*
   * live readings, so another element's screen shows that element's Soll
   * values beside this element's Ist values — and the header's phase stepper
   * there writes to the running session, so an operator correcting the phase
   * on what looks like an untouched pillar moves the phase of the one in the
   * ground. `Status` is what implenia-web's Herstellprotokoll segments every
   * KPI by, so that is a signed document reporting the wrong phase.
   *
   * The tiles are left visible and inert rather than removed: the list is how
   * a worker checks what else is on the shift, and a grid that emptied itself
   * during a recording would be worse than one that cannot be tapped. App's
   * own redirect covers the ways in that do not go through a tile — a reload,
   * a typed hash, a second tab.
   */
  const gesperrt = (name: string): boolean => !!recordingElement && name !== recordingElement;
  /*
   * Searching is off while a recording runs, and the search row carries the
   * explanation instead.
   *
   * Every result would be a tile that cannot be opened, so the box leads
   * nowhere — and the row it occupies is the only space on this screen that
   * can hold the sentence. At 1024x768 with the recording bar up, six tiles
   * and the resume row need 419px and the content column had 415 of them:
   * clipped by 4 before any of this, and a line of text would have cost 30
   * more. The sentence in a 40px row instead of the 64px input leaves exactly
   * enough. Measured on the rendered page, not derived — the grid is centred
   * and `overflow: hidden`, so it loses pixels off the top and bottom with no
   * scrollbar and nothing saying so.
   *
   * `isSearching` is computed from it rather than the state being cleared, so
   * a filter typed before the recording started cannot keep filtering a list
   * whose search box is no longer on screen.
   */
  const suchbar = !recordingElement;
  const lower = search.toLowerCase();
  const isSearching = suchbar && search.length > 0;

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
          {suchbar ? (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Element suchen..."
              style={styles.searchInput}
            />
          ) : (
            /*
              Why the other tiles do not react to a tap. Without it a dimmed
              tile that does nothing is indistinguishable from a frozen screen,
              which is the one thing this kiosk must never look like.
            */
            <div style={styles.gesperrtHinweis}>
              Während der Aufzeichnung kann nur „{recordingElement}" geöffnet werden
            </div>
          )}
        </div>

        <div style={styles.content}>
          {nothingFound && <div style={styles.noResults}>Keine Elemente gefunden</div>}

          {unfinishedTiles.length > 0 && (
            <div style={styles.grid}>
              {unfinishedTiles.map((device) => {
                const begonnen = fortschritt.get(device.name);
                return (
                  <button
                    key={device.id}
                    onClick={() => navigate(`element/${encodeURIComponent(device.name)}`)}
                    disabled={gesperrt(device.name)}
                    style={{
                      ...styles.tile,
                      ...(begonnen ? styles.angefangenTile : {}),
                      ...(device.name === recordingElement ? styles.recordingTile : {}),
                      ...(gesperrt(device.name) ? styles.tileGesperrt : {}),
                    }}
                  >
                    <div style={styles.tileName}>{device.name}</div>
                    {device.name === recordingElement ? (
                      <div style={styles.recordingBadge}>
                        <span style={styles.recordingDot} />
                        Aufzeichnung läuft
                      </div>
                    ) : begonnen && (
                      /*
                        Depth, not phase: it is the one number that says whether
                        anybody has drilled here. See `fortschrittText`.
                      */
                      <div style={styles.angefangenText}>{fortschrittText(begonnen.tiefe)}</div>
                    )}
                  </button>
                );
              })}
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
                    disabled={gesperrt(el.elementName)}
                    style={{
                      ...styles.tile,
                      ...styles.startedTile,
                      ...(el.elementName === recordingElement ? styles.recordingTile : {}),
                      ...(gesperrt(el.elementName) ? styles.tileGesperrt : {}),
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

          {/*
            Not while a recording runs: it tells the worker to type a name, and
            the search box it means is gone for the duration (see `suchbar`).
          */}
          {suchbar && hiddenCount > 0 && (
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
            : (
              <>
                {isCached && <CacheBadge cachedAt={shift.cachedAt} />}
                <ImportButton onImport={onImport} />
              </>
            )}
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
    // The staleness badge sits beside the import button, not above it: the
    // screen is 13px short of fitting with the recording bar up (see `page`),
    // so a second row here would push the button off the bottom.
    gap: '1rem',
    flexShrink: 0,
    minHeight: '72px',
    marginTop: '1rem',
  },
  cacheBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.5rem 1rem',
    backgroundColor: 'var(--color-warning-tint)',
    borderRadius: '8px',
  },
  cacheBadgeIcon: {
    fontSize: '1.5rem',
    color: 'var(--color-warning)',
    lineHeight: 1,
  },
  cacheBadgeText: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-warning-text)',
  },
  cacheBadgeSub: {
    fontSize: '1rem',
    color: 'var(--color-warning-text)',
  },
  // In the search row's place while a recording runs — and shorter than the
  // 64px input it replaces, because the grid needs those pixels: with six
  // tiles, the resume row and the recording bar up, the content column
  // overflows its 415px by 4 and clips them off a centred grid with no
  // scrollbar. 40px leaves it ~20px of room. It is a line of text, not a tap
  // target, so the glove minimum does not apply to it.
  gesperrtHinweis: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '40px',
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textAlign: 'center' as const,
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
  // The primary way out of a connection error, so it is the solid one and it
  // meets the glove minimum rather than the 56px the secondary links use.
  retryButton: {
    fontSize: '1.2rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: '#fff',
    backgroundColor: 'var(--color-accent)',
    border: 'none',
    borderRadius: '8px',
    padding: '0 2.5rem',
    minHeight: 'var(--tap-min)',
    cursor: 'pointer',
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
  // An element in today's list that this kiosk already holds recordings for —
  // paused, or stopped and not yet uploaded. Same dashed border as the resume
  // row below, which is the screen's existing word for "has data", on the main
  // grid's own background so it reads as unfinished work rather than as
  // something demoted.
  angefangenTile: {
    border: '2px dashed var(--color-warning)',
  },
  angefangenText: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--color-warning-text)',
  },
  // Not openable while a recording runs. Subdued rather than hidden, and
  // `disabled` rather than a tap that explains itself: there is one thing to
  // tap on this screen during a recording and it is the tile with the live dot.
  tileGesperrt: {
    opacity: 0.4,
    cursor: 'default',
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
