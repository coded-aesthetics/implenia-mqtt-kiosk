import { useVorgaben, useVorgabenUnits, useHerstellenUnits } from '../hooks/useImplenia';
import type { SensorReading } from '../hooks/useWebSocket';
import { BohrprofilLog } from '@coded-aesthetics/din4023/profile';
import type { Schicht } from '@coded-aesthetics/din4023/profile';

interface Props {
  elementName: string;
  readings: Map<string, SensorReading>;
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

  // Build layers sorted by index
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

export function ElementDetail({ elementName, readings }: Props) {
  const vorgaben = useVorgaben(elementName);
  const units = useVorgabenUnits(elementName);
  const herstellenUnits = useHerstellenUnits(elementName);

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

  // Show all live MQTT readings — topics are global (sensors/{sensorName}),
  // not per-element, since the machine has one set of herstellen sensors.
  const liveEntries = Array.from(readings.values());

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

  return (
    <div style={styles.container}>
      {/* Main content: geology profile left, tiles right */}
      <div style={styles.mainLayout}>
        {/* Geology profile on the left */}
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

        {/* Right side: Vorgabe + Live tiles */}
        <div style={styles.tilesColumn}>
          {/* Vorgabe section */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Vorgabe</h3>

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

            {vorgabeEntries.length > 0 && (
              <div style={styles.grid}>
                {vorgabeEntries.map((entry) => {
                  const unit = units.get(entry.name);
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

            {!vorgaben.loading && !vorgaben.error && vorgabeEntries.length === 0 && coordinates.length === 0 && !geologyProfile && (
              <div style={styles.statusText}>Keine Vorgaben vorhanden</div>
            )}
          </div>

          {/* Live sensor data section */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Messwerte</h3>

            {liveEntries.length > 0 ? (
              <div style={styles.grid}>
                {liveEntries.map((reading) => {
                  const sensorName = reading.topic.split('/').pop() || reading.topic;
                  const displayValue = parseRawPayload(reading.payload);
                  const unit = herstellenUnits.get(sensorName) ?? '';
                  return (
                    <div key={reading.topic} style={styles.liveTile}>
                      <div style={styles.tileLabel}>{sensorName}</div>
                      <div style={styles.liveValue}>
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
            ) : (
              <div style={styles.statusText}>Warte auf Sensordaten...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Parse a raw MQTT payload (plain number or text, not JSON). */
function parseRawPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity' || trimmed === '""') {
    return '–';
  }
  return trimmed;
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
    overflow: 'hidden',
  },
  section: {
    marginBottom: '2rem',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: 600,
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '1rem',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.75rem',
  },
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
  liveTile: {
    backgroundColor: '#16213e',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
    minHeight: '80px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
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
  liveValue: {
    fontSize: '2rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
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
