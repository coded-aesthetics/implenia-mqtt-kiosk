import { useMemo, useRef, useEffect, useState } from 'react';
import { useVorgabenUnits, useHerstellenUnits, useHerstellenSensors, useVorgabenSensors } from '../hooks/useImplenia';
import type { VorgabenData } from '../hooks/useImplenia';
import type { SensorReading } from '../hooks/useWebSocket';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import type { QueuedComment } from '../hooks/useCommentQueue';
import { CommentCard } from './CommentCard';
import { TileGrid, type TileItem } from './SensorTiles';
import {
  buildSchichten, buildSensorLookup, byPriority, collectVorgabeEntries,
  extractCoordinates, getPriority, isSpecialSensor, parseRawPayload,
} from '../utils/vorgaben';

export type ViewTab = 'messwerte' | 'vorgabe' | 'kommentare';

interface Props {
  elementName: string;
  readings: Map<string, SensorReading>;
  vorgaben: VorgabenData | null;
  activeTab: ViewTab;
  setActiveTab: (tab: ViewTab) => void;
  commentQueue: QueuedComment[];
  onCommentEdit: (id: string, text: string) => void;
  onCommentDelete: (id: string) => void;
  onCommentRetry: (id: string) => void;
}

/** A reading's sensor name is the last segment of its topic. */
function sensorNameOf(reading: SensorReading): string {
  return reading.topic.split('/').pop() || reading.topic;
}

export function ElementDetail({ elementName, readings, vorgaben, activeTab, setActiveTab, commentQueue, onCommentEdit, onCommentDelete, onCommentRetry }: Props) {
  const geoRef = useRef<HTMLDivElement>(null);
  const [geoHeight, setGeoHeight] = useState(0);

  useEffect(() => {
    if (!geoRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setGeoHeight(Math.floor(entry.contentRect.height));
    });
    ro.observe(geoRef.current);
    return () => ro.disconnect();
  }, []);

  const vorgabenUnits = useVorgabenUnits(elementName);
  const herstellenUnits = useHerstellenUnits(elementName);
  const herstellenSensors = useHerstellenSensors(elementName);
  const vorgabenSensors = useVorgabenSensors(elementName);

  const herstellenLookup = useMemo(() => buildSensorLookup(herstellenSensors), [herstellenSensors]);
  const vorgabenLookup = useMemo(() => buildSensorLookup(vorgabenSensors), [vorgabenSensors]);

  const allEntries = useMemo(() => collectVorgabeEntries(vorgaben), [vorgaben]);

  // Geology and coordinates are drawn on their own; what is left becomes tiles.
  const geologyProfile = useMemo(() => buildSchichten(allEntries), [allEntries]);
  const coordinates = useMemo(() => extractCoordinates(allEntries), [allEntries]);
  const vorgabeEntries = useMemo(
    () => allEntries.filter((e) => !isSpecialSensor(e.name)),
    [allEntries],
  );

  const vorgabeTiles = useMemo(() => {
    const buckets = byPriority(vorgabeEntries, (e) => getPriority(vorgabenLookup.get(e.name)));
    const toTiles = (entries: typeof vorgabeEntries): TileItem[] => entries.map((e) => ({
      key: e.name,
      label: e.name,
      value: e.value,
      unit: vorgabenUnits.get(e.name),
    }));
    return {
      hero: toTiles(buckets.hero),
      primary: toTiles(buckets.primary),
      secondary: toTiles(buckets.secondary),
    };
  }, [vorgabeEntries, vorgabenLookup, vorgabenUnits]);

  const liveEntries = useMemo(() => Array.from(readings.values()), [readings]);

  const liveTiles = useMemo(() => {
    const buckets = byPriority(liveEntries, (r) => getPriority(herstellenLookup.get(sensorNameOf(r))));
    const toTiles = (rs: SensorReading[]): TileItem[] => rs.map((r) => ({
      key: r.topic,
      label: sensorNameOf(r),
      value: parseRawPayload(r.payload),
      unit: herstellenUnits.get(sensorNameOf(r)) || undefined,
    }));
    return {
      hero: toTiles(buckets.hero),
      primary: toTiles(buckets.primary),
      secondary: toTiles(buckets.secondary),
    };
  }, [liveEntries, herstellenLookup, herstellenUnits]);

  // Extract current depth from live sensor for the geology indicator
  const currentDepth = (() => {
    const depthReading = liveEntries.find((r) => {
      const sensorName = r.topic.split('/').pop() || '';
      const def = herstellenLookup.get(sensorName);
      if (def?.meta?.role === 'depth') return true;
      const lower = sensorName.toLowerCase();
      return lower === 'bohrtiefe' || lower === 'tiefe';
    });
    if (!depthReading) return null;
    const n = parseFloat(depthReading.payload);
    return Number.isFinite(n) ? n : null;
  })();

  // Hero vorgaben for the pinned reminder bar in messwerte view
  const heroVorgaben = vorgabeTiles.hero;

  // Filter comment queue to current element
  const elementComments = useMemo(
    () => commentQueue.filter((c) => c.elementName === elementName),
    [commentQueue, elementName],
  );

  return (
    <div style={styles.container}>
      <div style={styles.mainLayout}>
        {/* Geology profile on the left — shared between both views */}
        {geologyProfile && (
          <div style={styles.geologyColumn}>
            <div ref={geoRef} style={styles.geologyContainer}>
              <BohrprofilLog
                schichten={geologyProfile.schichten}
                endTiefe={geologyProfile.endTiefe}
                breite={150}
                hoehe={geoHeight > 0 ? geoHeight - 8 : 400}
                modus="vollbild"
                tiefenIndikator={currentDepth}
                styleOverrides={geologyStyles}
              />
            </div>
          </div>
        )}

        {/* Right side: tab content */}
        <div style={styles.tilesColumn}>
          {/* Tab switcher */}
          <div style={styles.tabBar}>
            <button
              style={activeTab === 'messwerte' ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab('messwerte')}
            >
              Messwerte
            </button>
            <button
              style={activeTab === 'vorgabe' ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab('vorgabe')}
            >
              Vorgabe
            </button>
            <button
              style={activeTab === 'kommentare' ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab('kommentare')}
            >
              Kommentare
              {elementComments.length > 0 && (
                <span style={styles.tabBadge}>{elementComments.length}</span>
              )}
            </button>
          </div>

          {/* ========== MESSWERTE VIEW ========== */}
          {activeTab === 'messwerte' && (
            <div style={styles.viewContent}>
              {/* Pinned vorgaben reminder bar */}
              {heroVorgaben.length > 0 && (
                <div style={styles.vorgabenBar}>
                  {heroVorgaben.map((item) => (
                    <div key={item.key} style={styles.vorgabenBarItem}>
                      <span style={styles.vorgabenBarLabel}>{item.label}</span>
                      <span style={styles.vorgabenBarValue}>
                        {item.value}
                        {item.unit && <span style={styles.vorgabenBarUnit}> {item.unit}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {liveEntries.length > 0 ? (
                <>
                  <TileGrid items={liveTiles.hero} priority="hero" variant="live" />
                  <TileGrid items={liveTiles.primary} priority="primary" variant="live" />
                  <TileGrid items={liveTiles.secondary} priority="secondary" variant="live" />
                </>
              ) : (
                <div style={styles.statusText}>Warte auf Sensordaten...</div>
              )}
            </div>
          )}

          {/* ========== VORGABE VIEW ========== */}
          {activeTab === 'vorgabe' && (
            <div style={styles.viewContent}>
              {coordinates.length > 0 && (
                <div style={styles.coordBar}>
                  {coordinates.map((c) => (
                    <div key={c.label} style={styles.coordGroup}>
                      <span style={styles.coordLabel}>{c.label}</span>
                      <span style={styles.coordValues}>
                        X {c.x}&ensp;Y {c.y}&ensp;Z {c.z}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <TileGrid items={vorgabeTiles.hero} priority="hero" variant="vorgabe" />
              <TileGrid items={vorgabeTiles.primary} priority="primary" variant="vorgabe" />
              <TileGrid items={vorgabeTiles.secondary} priority="secondary" variant="vorgabe" />

              {vorgabeEntries.length === 0 && coordinates.length === 0 && !geologyProfile && (
                <div style={styles.statusText}>Keine Vorgaben vorhanden</div>
              )}
            </div>
          )}

          {/* ========== KOMMENTARE VIEW ========== */}
          {activeTab === 'kommentare' && (
            <div style={styles.viewContent}>
              {elementComments.length === 0 ? (
                <div style={styles.statusText}>
                  Keine Kommentare für dieses Element
                  <div style={styles.hintText}>Sage „Kommentar" um einen Kommentar zu diktieren</div>
                </div>
              ) : (
                <div style={commentListStyle}>
                  {elementComments.map((item) => (
                    <CommentCard
                      key={item.id}
                      item={item}
                      onEdit={onCommentEdit}
                      onDelete={onCommentDelete}
                      onRetry={onCommentRetry}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const geologyStyles = {
  depthTick: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 600,
  } as React.CSSProperties,
  depthLine: {
    borderTopColor: '#ffffff',
  } as React.CSSProperties,
  label: {
    fontSize: 14,
    fontWeight: 700,
  } as React.CSSProperties,
  depthIndicatorLine: {
    borderTopColor: '#ff4444',
    borderTopWidth: 2,
  } as React.CSSProperties,
  depthIndicatorLabel: {
    color: '#ff4444',
    fontSize: 14,
    fontWeight: 700,
  } as React.CSSProperties,
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '0.5rem 1.5rem 0',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  mainLayout: {
    display: 'flex',
    gap: '1.5rem',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  geologyColumn: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    alignSelf: 'stretch',
    minHeight: 0,
    overflow: 'hidden',
  },
  geologyContainer: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    paddingTop: 8,
  },
  tilesColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  // Tab bar
  tabBar: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '1rem',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#8899aa',
    backgroundColor: '#0d1b2a',
    border: '1px solid #1a2744',
    borderRadius: '8px 8px 0 0',
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  tabActive: {
    flex: 1,
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#ffffff',
    backgroundColor: '#1a2744',
    border: '1px solid #1a2744',
    borderBottom: '2px solid #1976d2',
    borderRadius: '8px 8px 0 0',
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },

  // View content (scrollable)
  viewContent: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto' as const,
    paddingRight: '0.25rem',
  },

  // Pinned vorgaben reminder bar (shown in messwerte view)
  vorgabenBar: {
    display: 'flex',
    gap: '1rem',
    flexWrap: 'wrap' as const,
    padding: '0.6rem 1rem',
    backgroundColor: '#1a2744',
    borderLeft: '4px solid #1976d2',
    borderRadius: '8px',
    marginBottom: '1rem',
  },
  vorgabenBarItem: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.4rem',
  },
  vorgabenBarLabel: {
    fontSize: '0.75rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontWeight: 600,
  },
  vorgabenBarValue: {
    fontSize: '0.95rem',
    color: '#ffffff',
    fontWeight: 700,
  },
  vorgabenBarUnit: {
    fontSize: '0.75rem',
    color: '#8899aa',
    fontWeight: 400,
  },

  // Hero tiles: full-width, large values

  // Primary tiles: standard grid

  // Secondary tiles: smaller, dimmer

  // Vorgabe tiles (primary level)

  // Shared styles
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: 600,
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    margin: '0.25rem 0 0.5rem',
  },
  coordBar: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  coordGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5rem',
    backgroundColor: '#1a2744',
    borderRadius: '8px',
    padding: '0.5rem 1rem',
    borderLeft: '4px solid #1976d2',
  },
  coordLabel: {
    fontSize: '0.85rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontWeight: 600,
  },
  coordValues: {
    fontSize: '1rem',
    color: '#ffffff',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    whiteSpace: 'nowrap' as const,
  },
  statusText: {
    fontSize: '1rem',
    color: '#556677',
    padding: '1rem 0',
  },
  errorText: {
    fontSize: '1rem',
    color: '#f44336',
    padding: '1rem 0',
  },
  hintText: {
    fontSize: '0.9rem',
    color: '#445566',
    marginTop: '0.5rem',
    fontStyle: 'italic' as const,
  },
  tabBadge: {
    marginLeft: '0.5rem',
    backgroundColor: '#1976d2',
    color: '#ffffff',
    borderRadius: '12px',
    padding: '0.1rem 0.5rem',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
};

const commentListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-md)',
  padding: 'var(--space-md) 0',
};
