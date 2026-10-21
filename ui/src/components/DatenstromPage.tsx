import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { navigate } from '../hooks/useHashRouter';
import { usePolledJson } from '../hooks/usePolledJson';
import type { SensorReading } from '../hooks/useWebSocket';
import {
  formatPayload, freshnessOf, groupByPrefix, groupLabel, silenceLabel,
} from '../utils/datenstrom';

/**
 * Datenstrom — every topic the data source is sending, grouped by prefix.
 *
 * The screen a technician setting up a box opens first. Everything else that
 * shows this data is filtered by something: the Sensorzuordnung shows one
 * sensor's candidates, and the Kalibrierung screen it replaces showed the
 * Verfahren's sensor list — on DSV that is 50 rows of which 13 are MQTT
 * channels. Here the list is what arrived, so a topic that resolves to nothing
 * is as visible as one that resolves correctly. That is the point: an
 * unresolved topic still displays live and is never uploaded.
 *
 * **Live values come off the WebSocket, the inventory off a slow poll.** The
 * overview query scans an hour of `mqtt_buffer` — see `POLL_INTERVAL_MS` in
 * `routes/config-datenstrom.ts` for what that costs — so polling it fast would
 * spend the event loop on an inventory that barely changes, while the values
 * are already arriving on a socket this page is connected to anyway.
 */

export interface Channel {
  topic: string;
  prefix: string;
  leaf: string;
  lastPayload: string;
  lastSeen: number;
  ageMs: number;
  count: number;
  sensor: string | null;
  boundBy: 'override' | 'shipped' | 'name' | 'none';
  unit: string;
  type: string;
  source: string;
  scale: number;
  offset: number;
  raw: number | null;
  calibrated: number | null;
  isClamp: boolean;
}

interface Missing {
  sensor: string;
  unit: string;
  type: string;
}

interface Body {
  verfahren: string | null;
  windowMs: number;
  channels: Channel[];
  missing: Missing[];
}

/** Matches the server's `POLL_INTERVAL_MS`. */
const POLL_MS = 10_000;

type Status = 'loading' | 'ready' | 'no-verfahren' | 'error';

interface Props {
  readings: Map<string, SensorReading>;
}

/**
 * What the tile shows: the live reading when one has arrived on the socket,
 * otherwise the last one the buffer knows about.
 *
 * The socket carries the value **as the kiosk uses it** — calibration already
 * applied — which is the number worth comparing against the display on the rig.
 * The detail view is where raw and corrected sit side by side.
 */
function live(channel: Channel, readings: Map<string, SensorReading>) {
  const reading = readings.get(channel.topic);
  if (reading && reading.receivedAt >= channel.lastSeen) {
    return { payload: reading.payload, at: reading.receivedAt };
  }
  const fallback = channel.calibrated ?? channel.raw;
  return {
    payload: fallback === null ? channel.lastPayload : String(fallback),
    at: channel.lastSeen,
  };
}

export function DatenstromPage({ readings }: Props) {
  const [body, setBody] = useState<Body | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // Re-render on a timer so the ages keep counting between polls. Without it a
  // channel that fell silent reads "vor 3 s" for ten seconds.
  const [, setTick] = useState(0);

  const apply = useCallback((d: Body) => {
    setBody(d);
    setStatus(d.verfahren ? 'ready' : 'no-verfahren');
  }, []);

  useEffect(() => {
    fetch('/api/config/datenstrom')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(apply)
      .catch(() => setStatus('error'));
  }, [apply]);

  usePolledJson<Body>('/api/config/datenstrom', POLL_MS, apply, {
    immediate: false,
    onError: () => setStatus((s) => (s === 'loading' ? 'error' : s)),
  });

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (status === 'loading') {
    return <div style={styles.notice}>Topics werden geladen…</div>;
  }
  if (status === 'no-verfahren') {
    return (
      <div style={styles.notice}>
        Es ist noch kein Verfahren eingerichtet. Bitte zuerst die Einrichtung
        abschließen — danach zeigt dieser Bildschirm, welche Topics ankommen.
      </div>
    );
  }
  if (status === 'error' || !body) {
    return (
      <div style={styles.notice}>
        Die Topic-Liste konnte nicht geladen werden. Der Bildschirm versucht es
        alle 10 Sekunden erneut.
      </div>
    );
  }

  const groups = groupByPrefix(body.channels);
  const bound = body.channels.filter((c) => c.sensor !== null).length;
  // Counted from the same live value the tiles use, not from the server's
  // `ageMs`. That figure is as old as the last poll, so a channel falling
  // silent between polls had the header calling it stumm while its own tile
  // still read current — two numbers on one screen disagreeing about the same
  // channel, which is exactly what a technician would come to this screen to
  // settle.
  const silent = body.channels
    .filter((c) => freshnessOf(Date.now() - live(c, readings).at) === 'stumm').length;
  const minutes = Math.round(body.windowMs / 60_000);

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <span style={styles.help}>
          Jede Kachel ist ein Topic. Antippen für Verlauf und Kalibrierung.
          Letzte {minutes} Minuten.
        </span>
        <span style={styles.counts}>
          {body.channels.length} Topics · {bound} zugeordnet
          {silent > 0 && <span style={styles.countsWarn}> · {silent} stumm</span>}
        </span>
      </div>

      {body.channels.length === 0 ? (
        <div style={styles.notice}>
          Noch keine Topics empfangen. Ist die MQTT-Box verbunden und die
          Maschine eingeschaltet?
        </div>
      ) : (
        <div style={styles.sources}>
          {groups.map((group) => (
            <div key={group.prefix} style={styles.source}>
              <div style={styles.sourceLabel}>{groupLabel(group.prefix)}</div>
              <div style={styles.tiles}>
                {group.channels.map((c) => (
                  <ChannelTile key={c.topic} channel={c} readings={readings} />
                ))}
              </div>
            </div>
          ))}

        </div>
      )}

      {body.missing.length > 0 && (
        <button style={styles.missingRow} onClick={() => navigate('sensors')}>
          <span style={styles.missingLabel}>
            {body.missing.length} Sensor{body.missing.length === 1 ? '' : 'en'} ohne Topic
          </span>
          <span style={styles.missingNames}>
            {body.missing.map((m) => m.sensor).join(' · ')}
          </span>
        </button>
      )}
    </div>
  );
}

function ChannelTile({ channel, readings }: { channel: Channel; readings: Map<string, SensorReading> }) {
  const value = live(channel, readings);
  const ageMs = Date.now() - value.at;
  const fresh = freshnessOf(ageMs);
  const calibrated = channel.scale !== 1 || channel.offset !== 0;

  // Left border: silence first, then calibration. Both are exceptional and
  // silence is the one a technician has to act on; the factor is on the detail
  // view either way.
  const accent = fresh === 'stumm'
    ? styles.tileSilent
    : calibrated ? styles.tileCalibrated : null;

  return (
    <button
      style={{ ...styles.tile, ...accent }}
      onClick={() => navigate(`datenstrom/${encodeURIComponent(channel.topic)}`)}
    >
      {/*
        Three stacked lines, nothing sharing one with the name.
        The first draft put the name and the age on one line and the value and
        the sensor on the next, which measured at 104–160px per tile instead of
        72: `Ziehgeschwindigkeit` is ~171px of a ~196px tile on its own, so
        every long name wrapped and every column grew to its tallest tile.
      */}
      <span style={styles.leaf}>{channel.leaf}</span>
      <span style={fresh === 'stumm' ? styles.valueSilent : styles.value}>
        {formatPayload(value.payload)}
        {channel.unit && <span style={styles.unit}> {channel.unit}</span>}
      </span>
      {channel.isClamp ? (
        <span style={styles.clamp}>Klemmbacke</span>
      ) : channel.sensor ? (
        <span style={styles.sensor}>{channel.sensor}</span>
      ) : (
        <span style={styles.unbound}>kein Sensor</span>
      )}
      {/*
        A fourth line, and only when the age is news.

        Not beside the sensor name: measured at 1024x768, `Suspensionsdruck`
        and `stumm vor 4 Min.` do not share a 194px line and wrapped that line
        to three, costing 38px on every tile of a column — and a grid row is as
        tall as its tallest tile, so one silent channel inflated four columns.
        On its own line the two cases are 94px and 115px and neither wraps.

        "gerade eben" on fourteen tiles would also say nothing: a current
        channel is shown by the absence of a warning, as everywhere else here.
      */}
      {fresh !== 'frisch' && (
        <span style={styles.ageWarn}>{silenceLabel(ageMs)}</span>
      )}
    </button>
  );
}

const tileBase: CSSProperties = {
  display: 'flex', flexDirection: 'column', justifyContent: 'center',
  // 6px, not --space-sm: at 8px the captured rig's tallest column measured
  // 523px against 521px of band — two pixels, and therefore a scrollbar on the
  // one inventory this screen must show whole. Tiles stay 87px, well over the
  // 64px tap minimum.
  gap: '2px', minHeight: '84px', padding: '6px var(--space-md)',
  backgroundColor: 'var(--surface-2)', border: '2px solid var(--border)',
  borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'inherit',
  textAlign: 'left', width: '100%', boxSizing: 'border-box',
};

const styles: Record<string, CSSProperties> = {
  page: {
    display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
    padding: 'var(--space-lg)', flex: 1, minHeight: 0, boxSizing: 'border-box',
  },
  headerRow: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 'var(--space-md)', flexShrink: 0,
  },
  help: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)', lineHeight: 1.4 },
  counts: {
    fontSize: 'var(--font-sm)', color: 'var(--text-secondary)',
    fontWeight: 600, whiteSpace: 'nowrap',
  },
  countsWarn: { color: 'var(--color-warning-text)' },

  /**
   * A column per prefix.
   *
   * The captured rig has four, which is one row of four 232px columns and fits
   * the band exactly — measured at 1024x768, 521px of content in 521px. A box
   * with more sources wraps onto a second row and this area scrolls, which is
   * the service-screen scroll CLAUDE.md allows; nothing is lost.
   *
   * CSS multi-column was tried here to pack the short sources together and is
   * wrong: inside a *bounded height* multicol adds columns **horizontally**, so
   * the fifth and sixth groups landed at x=1016 and x=1264 — off a 1024px
   * screen, with no vertical scroll to reach them.
   */
  sources: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 'var(--space-md)', alignContent: 'start',
    flex: 1, minHeight: 0, overflowY: 'auto',
  },
  source: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minWidth: 0 },
  sourceLabel: {
    fontSize: 'var(--font-sm)', fontWeight: 700, color: 'var(--text-secondary)',
    textTransform: 'none',
  },
  tiles: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' },

  tile: tileBase,
  tileSilent: { borderLeft: '4px solid var(--color-warning)' },
  tileCalibrated: { borderLeft: '4px solid var(--color-accent)' },
  /**
   * One row, one tap target, below the stream rather than beside it: these are
   * sensors the Verfahren expects and nothing is feeding, which is not a source
   * and would cost the captured rig's four groups their single row. The names
   * are not separately actionable — the fix for every one of them is the
   * Sensorzuordnung.
   */
  missingRow: {
    display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
    minHeight: 'var(--tap-min)', padding: '0 var(--space-md)', flexShrink: 0,
    backgroundColor: 'var(--surface-1)', border: '2px dashed var(--border)',
    borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'inherit',
    textAlign: 'left', width: '100%', boxSizing: 'border-box',
  },
  missingLabel: {
    fontSize: 'var(--font-base)', fontWeight: 700,
    color: 'var(--color-warning-text)', whiteSpace: 'nowrap',
  },
  missingNames: {
    fontSize: 'var(--font-sm)', color: 'var(--text-muted)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },

  tileRow: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 'var(--space-sm)', minWidth: 0,
  },
  /**
   * Wraps rather than truncating. This is the screen that exists because the
   * calibration row clipped `Ziehgeschwindigkeit` to four characters, so a tile
   * growing a line is always the better trade.
   */
  leaf: {
    fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)',
    overflowWrap: 'anywhere', lineHeight: 1.2,
  },
  age: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  ageWarn: {
    fontSize: 'var(--font-sm)', color: 'var(--color-warning-text)',
    fontWeight: 600, whiteSpace: 'nowrap',
  },
  /**
   * `--font-md`, not the 2rem+ a worker-facing hero value gets: this is a dense
   * service screen, and it is the size the calibration screen used for the same
   * number. Fourteen of these at 2rem would not fit the viewport.
   */
  value: {
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)', lineHeight: 1.2,
    // The one line on this screen that may be cut: a `logs` topic publishes a
    // JSON document, and letting it wrap grew that tile to 160px. The detail
    // view shows the payload in full.
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  valueSilent: {
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--color-warning-text)', lineHeight: 1.2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  unit: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  sensor: {
    fontSize: 'var(--font-sm)', color: 'var(--text-secondary)',
    overflowWrap: 'anywhere', minWidth: 0, lineHeight: 1.2,
  },
  unbound: {
    fontSize: 'var(--font-sm)', color: 'var(--color-warning-text)',
    fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap',
  },
  clamp: {
    fontSize: 'var(--font-sm)', color: 'var(--color-accent)',
    fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap',
  },
  missingHint: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },

  notice: {
    padding: 'var(--space-xl)', fontSize: 'var(--font-base)', lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
};
