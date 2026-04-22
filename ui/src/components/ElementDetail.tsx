import { useMemo } from 'react';
import { useVorgaben, useVorgabenUnits, useHerstellenUnits, useHerstellenSensors, useVorgabenSensors } from '../hooks/useImplenia';
import type { SensorDef } from '../hooks/useImplenia';
import type { SensorReading } from '../hooks/useWebSocket';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import type { Schicht } from '@coded-aesthetics/din4023/profile';

export type ViewTab = 'messwerte' | 'vorgabe';

interface Props {
  elementName: string;
  readings: Map<string, SensorReading>;
  activeTab: ViewTab;
  setActiveTab: (tab: ViewTab) => void;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '–';
  if (typeof v === 'string') return v || '–';
  return JSON.stringify(v);
}

const GEOLOGIE_RE = /^Geologie\s+(\d+)$/i;
const TIEFE_GEOLOGIE_RE = /^Tiefe\s+Geologie\s+(\d+)$/i;
const COORDINATE_RE = /^(Startpunkt|Fusspunkt)\s+(X|Y|Z)$/i;
const HIDDEN_SENSORS = new Set(['Nummer']);

function isSpecialSensor(name: string): boolean {
  return GEOLOGIE_RE.test(name) || TIEFE_GEOLOGIE_RE.test(name)
    || COORDINATE_RE.test(name) || HIDDEN_SENSORS.has(name);
}

interface CoordinateGroup {
  label: string;
  x: string;
  y: string;
  z: string;
}

function extractCoordinates(entries: { name: string; value: string }[]): CoordinateGroup[] {
  const groups = new Map<string, { x: string; y: string; z: string }>();
  for (const { name, value } of entries) {
    const m = name.match(COORDINATE_RE);
    if (!m) continue;
    const groupName = m[1];
    const axis = m[2].toUpperCase() as 'X' | 'Y' | 'Z';
    if (!groups.has(groupName)) groups.set(groupName, { x: '–', y: '–', z: '–' });
    groups.get(groupName)![axis.toLowerCase() as 'x' | 'y' | 'z'] = value;
  }
  return [...groups.entries()].map(([label, coords]) => ({ label, ...coords }));
}

function buildSchichten(
  entries: { name: string; value: string }[],
): { schichten: Schicht[]; endTiefe: number } | null {
  const geoCodes = new Map<number, number>();
  const geoDepths = new Map<number, number>();

  for (const { name, value } of entries) {
    const codeMatch = name.match(GEOLOGIE_RE);
    if (codeMatch) {
      const idx = parseInt(codeMatch[1], 10);
      const nr = parseInt(value, 10);
      if (!isNaN(nr) && nr > 0) geoCodes.set(idx, nr);
      continue;
    }
    const depthMatch = name.match(TIEFE_GEOLOGIE_RE);
    if (depthMatch) {
      const idx = parseInt(depthMatch[1], 10);
      const depth = parseFloat(value);
      if (!isNaN(depth)) geoDepths.set(idx, depth);
    }
  }

  if (geoCodes.size === 0) return null;

  const indices = [...geoCodes.keys()].sort((a, b) => a - b);
  const schichten: Schicht[] = [];
  let prevDepth = 0;

  for (const idx of indices) {
    const nr = geoCodes.get(idx)!;
    schichten.push({ tiefe: prevDepth, nr });
    const endDepth = geoDepths.get(idx);
    if (endDepth !== undefined) prevDepth = endDepth;
  }

  const endTiefe = prevDepth > 0 ? prevDepth : 10;
  return { schichten, endTiefe };
}

/** Parse a raw MQTT payload (plain number or text, not JSON). */
function parseRawPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity' || trimmed === '""') {
    return '–';
  }
  return trimmed;
}

/** Get priority from a sensor def, defaulting to 'primary'. */
function getPriority(sensor: SensorDef | undefined): 'hero' | 'primary' | 'secondary' {
  if (!sensor?.meta?.priority) return 'primary';
  const p = sensor.meta.priority;
  if (p === 'hero' || p === 'primary' || p === 'secondary') return p;
  return 'primary';
}

/** Build a lookup from sensor name to SensorDef. */
function buildSensorLookup(sensors: SensorDef[]): Map<string, SensorDef> {
  const map = new Map<string, SensorDef>();
  for (const s of sensors) map.set(s.name, s);
  return map;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ElementDetail({ elementName, readings, activeTab, setActiveTab }: Props) {

  const vorgaben = useVorgaben(elementName);
  const vorgabenUnits = useVorgabenUnits(elementName);
  const herstellenUnits = useHerstellenUnits(elementName);
  const herstellenSensors = useHerstellenSensors(elementName);
  const vorgabenSensors = useVorgabenSensors(elementName);

  const herstellenLookup = useMemo(() => buildSensorLookup(herstellenSensors), [herstellenSensors]);
  const vorgabenLookup = useMemo(() => buildSensorLookup(vorgabenSensors), [vorgabenSensors]);

  // Collect vorgabe entries from all sensor types
  const allEntries: { name: string; value: string }[] = [];
  if (vorgaben.data) {
    const d = vorgaben.data;
    for (const [name, val] of Object.entries(d.float_sensors ?? {})) {
      allEntries.push({ name, value: formatValue(val) });
    }
    for (const [name, val] of Object.entries(d.int_sensors ?? {})) {
      allEntries.push({ name, value: formatValue(val) });
    }
    for (const [name, val] of Object.entries(d.string_sensors ?? {})) {
      allEntries.push({ name, value: formatValue(val) });
    }
    for (const [name, val] of Object.entries(d.geo_sensors ?? {})) {
      allEntries.push({ name, value: formatValue(val) });
    }
    for (const [name, val] of Object.entries(d.int_float_sensors ?? {})) {
      allEntries.push({ name, value: formatValue(val) });
    }
  }

  // Separate geology, coordinates, and regular vorgabe entries
  const geologyProfile = buildSchichten(allEntries);
  const coordinates = extractCoordinates(allEntries);
  const vorgabeEntries = allEntries.filter((e) => !isSpecialSensor(e.name));

  // Split vorgabe entries by priority
  const vorgabesByPriority = useMemo(() => {
    const hero: typeof vorgabeEntries = [];
    const primary: typeof vorgabeEntries = [];
    const secondary: typeof vorgabeEntries = [];
    for (const entry of vorgabeEntries) {
      const p = getPriority(vorgabenLookup.get(entry.name));
      if (p === 'hero') hero.push(entry);
      else if (p === 'secondary') secondary.push(entry);
      else primary.push(entry);
    }
    return { hero, primary, secondary };
  }, [vorgabeEntries, vorgabenLookup]);

  // Live MQTT readings
  const liveEntries = Array.from(readings.values());

  // Split live entries by priority
  const liveByPriority = useMemo(() => {
    const hero: typeof liveEntries = [];
    const primary: typeof liveEntries = [];
    const secondary: typeof liveEntries = [];
    for (const reading of liveEntries) {
      const sensorName = reading.topic.split('/').pop() || reading.topic;
      const p = getPriority(herstellenLookup.get(sensorName));
      if (p === 'hero') hero.push(reading);
      else if (p === 'secondary') secondary.push(reading);
      else primary.push(reading);
    }
    return { hero, primary, secondary };
  }, [liveEntries, herstellenLookup]);

  // Extract current depth from live sensor for the geology indicator
  const currentDepth = (() => {
    const depthReading = liveEntries.find((r) => {
      const name = r.topic.split('/').pop()?.toLowerCase();
      return name === 'bohrtiefe' || name === 'tiefe';
    });
    if (!depthReading) return null;
    const n = parseFloat(depthReading.payload);
    return Number.isFinite(n) ? n : null;
  })();

  // Hero vorgaben for the pinned reminder bar in messwerte view
  const heroVorgaben = vorgabesByPriority.hero;

  return (
    <div style={styles.container}>
      <div style={styles.mainLayout}>
        {/* Geology profile on the left — shared between both views */}
        {geologyProfile && (
          <div style={styles.geologyColumn}>
            <h3 style={styles.sectionTitle}>Geologie</h3>
            <div style={styles.geologyContainer}>
              <BohrprofilLog
                schichten={geologyProfile.schichten}
                endTiefe={geologyProfile.endTiefe}
                modus="vollbild"
                tiefenIndikator={currentDepth}
                style={{ marginTop: 8 }}
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
          </div>

          {/* ========== MESSWERTE VIEW ========== */}
          {activeTab === 'messwerte' && (
            <div style={styles.viewContent}>
              {/* Pinned vorgaben reminder bar */}
              {heroVorgaben.length > 0 && (
                <div style={styles.vorgabenBar}>
                  {heroVorgaben.map((entry) => {
                    const unit = vorgabenUnits.get(entry.name);
                    return (
                      <div key={entry.name} style={styles.vorgabenBarItem}>
                        <span style={styles.vorgabenBarLabel}>{entry.name}</span>
                        <span style={styles.vorgabenBarValue}>
                          {entry.value}
                          {unit && <span style={styles.vorgabenBarUnit}> {unit}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {liveEntries.length > 0 ? (
                <>
                  {/* Hero live tiles */}
                  {liveByPriority.hero.length > 0 && (
                    <div style={styles.heroGrid}>
                      {liveByPriority.hero.map((reading) => {
                        const sensorName = reading.topic.split('/').pop() || reading.topic;
                        const displayValue = parseRawPayload(reading.payload);
                        const unit = herstellenUnits.get(sensorName) ?? '';
                        return (
                          <div key={reading.topic} style={styles.heroTile}>
                            <div style={styles.heroLabel}>{sensorName}</div>
                            <div style={styles.heroValue}>
                              {displayValue}
                              {unit && <span style={styles.heroUnit}>{unit}</span>}
                            </div>
                            <div style={styles.timestamp}>
                              {new Date(reading.receivedAt).toLocaleTimeString()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Primary live tiles */}
                  {liveByPriority.primary.length > 0 && (
                    <div style={styles.primaryGrid}>
                      {liveByPriority.primary.map((reading) => {
                        const sensorName = reading.topic.split('/').pop() || reading.topic;
                        const displayValue = parseRawPayload(reading.payload);
                        const unit = herstellenUnits.get(sensorName) ?? '';
                        return (
                          <div key={reading.topic} style={styles.primaryTile}>
                            <div style={styles.tileLabel}>{sensorName}</div>
                            <div style={styles.primaryValue}>
                              {displayValue}
                              {unit && <span style={styles.unit}>{unit}</span>}
                            </div>
                            <div style={styles.timestamp}>
                              {new Date(reading.receivedAt).toLocaleTimeString()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Secondary live tiles */}
                  {liveByPriority.secondary.length > 0 && (
                    <div style={styles.secondaryGrid}>
                      {liveByPriority.secondary.map((reading) => {
                        const sensorName = reading.topic.split('/').pop() || reading.topic;
                        const displayValue = parseRawPayload(reading.payload);
                        const unit = herstellenUnits.get(sensorName) ?? '';
                        return (
                          <div key={reading.topic} style={styles.secondaryTile}>
                            <div style={styles.secondaryLabel}>{sensorName}</div>
                            <div style={styles.secondaryValue}>
                              {displayValue}
                              {unit && <span style={styles.secondaryUnit}>{unit}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div style={styles.statusText}>Warte auf Sensordaten...</div>
              )}
            </div>
          )}

          {/* ========== VORGABE VIEW ========== */}
          {activeTab === 'vorgabe' && (
            <div style={styles.viewContent}>
              {vorgaben.loading && (
                <div style={styles.statusText}>Vorgaben werden geladen...</div>
              )}

              {vorgaben.error && (
                <div style={styles.errorText}>Fehler: {vorgaben.error}</div>
              )}

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

              {/* Hero vorgabe tiles */}
              {vorgabesByPriority.hero.length > 0 && (
                <div style={styles.heroGrid}>
                  {vorgabesByPriority.hero.map((entry) => {
                    const unit = vorgabenUnits.get(entry.name);
                    return (
                      <div key={entry.name} style={styles.heroVorgabeTile}>
                        <div style={styles.heroLabel}>{entry.name}</div>
                        <div style={styles.heroVorgabeValue}>
                          {entry.value}
                          {unit && <span style={styles.heroUnit}>{unit}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Primary vorgabe tiles */}
              {vorgabesByPriority.primary.length > 0 && (
                <div style={styles.primaryGrid}>
                  {vorgabesByPriority.primary.map((entry) => {
                    const unit = vorgabenUnits.get(entry.name);
                    return (
                      <div key={entry.name} style={styles.vorgabeTile}>
                        <div style={styles.tileLabel}>{entry.name}</div>
                        <div style={styles.tileValue}>
                          {entry.value}
                          {unit && <span style={styles.tileUnit}>{unit}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Secondary vorgabe tiles */}
              {vorgabesByPriority.secondary.length > 0 && (
                <div style={styles.secondaryGrid}>
                  {vorgabesByPriority.secondary.map((entry) => {
                    const unit = vorgabenUnits.get(entry.name);
                    return (
                      <div key={entry.name} style={styles.secondaryVorgabeTile}>
                        <div style={styles.secondaryLabel}>{entry.name}</div>
                        <div style={styles.secondaryVorgabeValue}>
                          {entry.value}
                          {unit && <span style={styles.secondaryUnit}>{unit}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {!vorgaben.loading && !vorgaben.error && vorgabeEntries.length === 0 && coordinates.length === 0 && !geologyProfile && (
                <div style={styles.statusText}>Keine Vorgaben vorhanden</div>
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
    padding: '1rem 1.5rem',
    height: '100%',
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
  },
  geologyColumn: {
    display: 'flex',
    flexDirection: 'column',
    width: '280px',
    flexShrink: 0,
    minHeight: 0,
  },
  geologyContainer: {
    flex: 1,
    minHeight: 0,
  },
  tilesColumn: {
    flex: 1,
    minWidth: 0,
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
  heroGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  heroTile: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '1.25rem 1.5rem',
    minHeight: '100px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    border: '1px solid #1976d2',
  },
  heroVorgabeTile: {
    backgroundColor: '#1a2744',
    borderRadius: '12px',
    padding: '1.25rem 1.5rem',
    minHeight: '100px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    borderLeft: '4px solid #1976d2',
  },
  heroLabel: {
    fontSize: '0.9rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '0.3rem',
    fontWeight: 600,
  },
  heroValue: {
    fontSize: '3.5rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.1,
  },
  heroVorgabeValue: {
    fontSize: '3rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.1,
  },
  heroUnit: {
    fontSize: '1.5rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.3rem',
  },

  // Primary tiles: standard grid
  primaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  primaryTile: {
    backgroundColor: '#16213e',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
    minHeight: '80px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryValue: {
    fontSize: '2rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
  },

  // Secondary tiles: smaller, dimmer
  secondaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '0.5rem',
    marginBottom: '1rem',
  },
  secondaryTile: {
    backgroundColor: '#111d33',
    borderRadius: '8px',
    padding: '0.6rem 0.8rem',
    minHeight: '50px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.85,
  },
  secondaryVorgabeTile: {
    backgroundColor: '#151f36',
    borderRadius: '8px',
    padding: '0.6rem 0.8rem',
    minHeight: '50px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    borderLeft: '3px solid #2a3f5f',
    opacity: 0.85,
  },
  secondaryLabel: {
    fontSize: '0.7rem',
    color: '#667788',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '0.15rem',
  },
  secondaryValue: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#ccddee',
    lineHeight: 1.2,
  },
  secondaryVorgabeValue: {
    fontSize: '1.3rem',
    fontWeight: 700,
    color: '#ccddee',
  },
  secondaryUnit: {
    fontSize: '0.75rem',
    fontWeight: 400,
    color: '#667788',
    marginLeft: '0.2rem',
  },

  // Vorgabe tiles (primary level)
  vorgabeTile: {
    backgroundColor: '#1a2744',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
    borderLeft: '4px solid #1976d2',
    minHeight: '64px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },

  // Shared styles
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: 600,
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '1rem',
  },
  tileLabel: {
    fontSize: '0.85rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '0.3rem',
  },
  tileValue: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: '#ffffff',
  },
  tileUnit: {
    fontSize: '1rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.25rem',
  },
  unit: {
    fontSize: '1rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.25rem',
  },
  timestamp: {
    fontSize: '0.7rem',
    color: '#556677',
    marginTop: '0.3rem',
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
};
