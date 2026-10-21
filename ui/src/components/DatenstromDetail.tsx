import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { navigate } from '../hooks/useHashRouter';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import { usePolledJson } from '../hooks/usePolledJson';
import type { SensorReading } from '../hooks/useWebSocket';
import { SensorChart, type ChartScale, type ChartSeries } from './SensorChart';
import { formatNumber } from '../utils/format';
import { formatPayload, freshnessOf, niceScale, silenceLabel } from '../utils/datenstrom';
import type { Channel } from './DatenstromPage';

/**
 * One channel: what it is publishing, what the kiosk makes of it, and the
 * calibration — with the whole screen to say it in.
 *
 * This is the half of the change that fixes the Kalibrierung screen. That
 * screen put a name, two live values, two fields and three buttons on one flex
 * row, which left the name cell about 100px of a 1024px display: sensor names
 * and units were cut off after three or four characters. Here one channel has
 * the display, so nothing competes for the width.
 */

const BOUND_LABEL: Record<Channel['boundBy'], string> = {
  override: 'zugeordnet',
  shipped: 'voreingestellt',
  name: 'passt automatisch',
  none: '',
};

/** The two spans the chart offers. Kept to two 64px buttons. */
const WINDOWS = [10, 60] as const;

/** Below this the chart draws nothing readable and still pays for a rebuild. */
const MIN_CHART_HEIGHT = 80;

/**
 * uPlot's legend renders *below* the canvas and outside the height the chart is
 * given, so the height passed has to leave room for it or it lands on top of
 * whatever comes next — here the Faktor and Versatz labels.
 */
const LEGEND_PX = 28;

interface HistoryPoint { ts: number; value: number }

interface Props {
  topic: string;
  readings: Map<string, SensorReading>;
}

/** German decimal comma in, JS number out. */
function parseNumber(input: string): number {
  return Number(input.replace(',', '.'));
}

/**
 * A stored factor as it goes into the field. A comma, like every other number
 * on this kiosk — `parseNumber` takes either back, and the on-screen keyboard's
 * numpad offers a comma and no period.
 */
function germanNumber(value: number): string {
  return String(value).replace('.', ',');
}

/** The chart's y range, or null when there is nothing to draw. */
function chartScale(points: HistoryPoint[]): { scale: ChartScale; decimals: number } | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const n = niceScale(min, max);
  return { scale: { key: 'y', min: n.min, max: n.max }, decimals: n.decimals };
}

export function DatenstromDetail({ topic, readings }: Props) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [known, setKnown] = useState(false);
  const [minutes, setMinutes] = useState<number>(WINDOWS[0]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [drafts, setDrafts] = useState<{ scale: string; offset: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [chartRef, chartHeight] = useMeasuredHeight();

  const apply = useCallback((d: { channels?: Channel[]; windowMs?: number }, withDrafts: boolean) => {
    if (d.windowMs) setWindowMs(d.windowMs);
    const found = d.channels?.find((c) => c.topic === topic) ?? null;
    setChannel(found);
    setKnown(true);
    if (withDrafts && found) {
      setDrafts({ scale: germanNumber(found.scale), offset: germanNumber(found.offset) });
    }
  }, [topic]);

  const load = useCallback((withDrafts: boolean) => {
    fetch('/api/config/datenstrom')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) apply(d, withDrafts); else setKnown(true); })
      .catch(() => setKnown(true));
  }, [apply]);

  useEffect(() => { load(true); }, [load]);

  // Never with drafts: a poll landing while a factor is being typed would throw
  // the typing away. Same discipline, and the same reason, as the screen this
  // replaces.
  usePolledJson<{ channels?: Channel[]; windowMs?: number }>(
    '/api/config/datenstrom', 10_000, (d) => apply(d, false), { immediate: false },
  );

  /**
   * The chart is seeded from the buffer and then left alone.
   *
   * One fetch per open rather than a poll: the history is already drawn by the
   * time the screen paints, and the live value above it comes off the socket.
   */
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    fetch(`/api/config/datenstrom/history?topic=${encodeURIComponent(topic)}&minutes=${minutes}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { points?: HistoryPoint[] } | null) => {
        if (!cancelled && d?.points) setHistory(d.points);
      })
      .catch(() => { /* an empty chart is the honest answer */ });
    return () => { cancelled = true; };
  }, [topic, minutes]);

  const reading = readings.get(topic);
  const liveAt = reading?.receivedAt ?? channel?.lastSeen ?? 0;
  const ageMs = liveAt ? Date.now() - liveAt : Infinity;
  const fresh = freshnessOf(ageMs);

  /**
   * The socket carries the value **after** calibration, which is the one the
   * recording uses. The raw value is recovered by inverting the same linear
   * correction — exact, and identical to the corrected one in the ordinary case
   * where no calibration is set.
   */
  const messwert = reading ? Number.parseFloat(reading.payload) : channel?.calibrated ?? null;
  const rohwert = messwert === null || !Number.isFinite(messwert) || !channel
    ? channel?.raw ?? null
    : (messwert - channel.offset) / (channel.scale || 1);

  const chart = useMemo(() => {
    const q = chartScale(history);
    const series: ChartSeries[] = [{
      label: 'Rohwert',
      unit: channel?.unit ?? '',
      // A concrete colour, not a CSS custom property: the series is stroked
      // onto a canvas, where `var(--color-accent)` resolves to nothing and the
      // line comes out invisible. Same value as the token.
      color: '#1565c0',
      data: history,
    }];
    return { series, scales: q ? [q.scale] : undefined, decimals: q?.decimals ?? 0 };
  }, [history, channel?.unit]);

  async function send(path: string, init: RequestInit): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, init);
      const b = (await res.json().catch(() => ({}))) as { error?: string; scale?: number; offset?: number };
      if (!res.ok) throw new Error(b.error ?? `Fehler ${res.status}`);
      if (b.scale !== undefined || b.offset !== undefined) {
        setDrafts({
          scale: b.scale !== undefined ? germanNumber(b.scale) : drafts?.scale ?? '1',
          offset: germanNumber(b.offset ?? 0),
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      load(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => channel && drafts && send('/api/config/calibration', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sensorName: channel.sensor,
      scale: parseNumber(drafts.scale),
      offset: parseNumber(drafts.offset),
    }),
  });

  const tare = () => channel && send(
    `/api/config/calibration/${encodeURIComponent(channel.sensor ?? '')}/tare`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: parseNumber(drafts?.scale ?? '1') }),
    },
  );

  const reset = () => channel && send(
    `/api/config/calibration/${encodeURIComponent(channel.sensor ?? '')}`,
    { method: 'DELETE' },
  ).then(() => setDrafts({ scale: '1', offset: '0' }));

  if (known && !channel) {
    return (
      <div style={styles.notice}>
        Für „{topic}" ist in der letzten Stunde nichts angekommen. Sobald wieder
        Daten eintreffen, erscheint der Kanal im Datenstrom.
        <button style={styles.linkButton} onClick={() => navigate('datenstrom')}>
          Zurück zum Datenstrom
        </button>
      </div>
    );
  }
  if (!channel) return <div style={styles.notice}>Kanal wird geladen…</div>;

  const changed = drafts !== null
    && (parseNumber(drafts.scale) !== channel.scale || parseNumber(drafts.offset) !== channel.offset);
  const active = channel.scale !== 1 || channel.offset !== 0;
  const windowSeconds = windowMs / 1000;
  const rate = channel.count > 0 ? channel.count / windowSeconds : 0;

  return (
    <div style={styles.page}>
      <div style={styles.identity}>
        <span style={styles.topic}>{channel.topic}</span>
        {fresh !== 'frisch' && <span style={styles.ageWarn}>{silenceLabel(ageMs)}</span>}
      </div>

      <div style={styles.binding}>
        {channel.isClamp ? (
          <span style={styles.clamp}>Klemmbacke-Signal</span>
        ) : channel.sensor ? (
          <>
            <span style={styles.sensorName}>{channel.sensor}</span>
            {channel.unit && <span style={styles.meta}>{channel.unit}</span>}
            <span style={styles.meta}>{channel.type}</span>
            {BOUND_LABEL[channel.boundBy] && (
              <span style={styles.badge}>{BOUND_LABEL[channel.boundBy]}</span>
            )}
          </>
        ) : (
          <span style={styles.unbound}>keinem Sensor zugeordnet</span>
        )}
        <span style={styles.rate}>
          {rate >= 0.1
            ? `≈ ${formatNumber(rate, 1)} Nachrichten/s`
            : `${channel.count} Nachrichten in ${Math.round(windowMs / 60_000)} Min.`}
        </span>
      </div>

      <div style={styles.values}>
        <div style={styles.valueCell}>
          <div style={styles.valueLabel}>Rohwert</div>
          <div style={styles.rawValue}>
            {rohwert === null || !Number.isFinite(rohwert)
              ? formatPayload(reading?.payload ?? channel.lastPayload)
              : formatNumber(rohwert)}
          </div>
        </div>
        <div style={styles.arrow}>→</div>
        <div style={styles.valueCell}>
          <div style={styles.valueLabel}>Messwert</div>
          <div style={styles.calValue}>
            {messwert === null || !Number.isFinite(messwert)
              ? formatPayload(reading?.payload ?? channel.lastPayload)
              : formatNumber(messwert)}
            {channel.unit && <span style={styles.valueUnit}> {channel.unit}</span>}
          </div>
        </div>
        <div style={styles.windowRow}>
          {WINDOWS.map((m) => (
            <button
              key={m}
              style={m === minutes ? styles.windowActive : styles.window}
              onClick={() => setMinutes(m)}
            >
              {m} Min.
            </button>
          ))}
        </div>
      </div>

      {/*
        The chart gives way, not the controls.

        TouchKeyboard is a flex child of the layout rather than an overlay, so
        opening it takes about a third of `main`'s height out of this column.
        With the chart as the only `flex: 1, minHeight: 0` child, that height
        comes off the chart and the fields being typed into stay on screen.
      */}
      <div ref={chartRef} style={styles.chartArea}>
        {history.length === 0 ? (
          <div style={styles.chartEmpty}>
            Für die letzten {minutes} Minuten liegen keine Werte vor.
          </div>
        ) : chartHeight - LEGEND_PX >= MIN_CHART_HEIGHT ? (
          <SensorChart
            series={chart.series}
            scales={chart.scales}
            windowMinutes={minutes}
            // Quantised: `height` is one of the chart's init dependencies, so a
            // pixel of layout jitter would rebuild the uPlot instance.
            height={Math.floor((chartHeight - LEGEND_PX) / 8) * 8}
            tickDecimals={chart.decimals}
          />
        ) : null}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {channel.isClamp ? (
        <div style={styles.block}>
          <span style={styles.blockText}>
            Die Klemmbacke wird bewusst nicht kalibriert — ihre Schwellen werden
            an den Werten eingestellt, die hier ankommen.
          </span>
          <button style={styles.linkButton} onClick={() => navigate('rohrverlaengerung')}>
            Rohrverlängerung öffnen
          </button>
        </div>
      ) : !channel.sensor ? (
        <div style={styles.block}>
          <span style={styles.blockText}>
            Dieses Topic ist keinem Sensor zugeordnet. Seine Werte werden
            aufgezeichnet, aber <strong>nicht hochgeladen</strong>.
          </span>
          <button style={styles.linkButton} onClick={() => navigate('sensors')}>
            Sensorzuordnung öffnen
          </button>
        </div>
      ) : channel.type !== 'Double' ? (
        <div style={styles.block}>
          <span style={styles.blockText}>
            „{channel.sensor}" ist ein {channel.type || 'nicht numerischer'}-Sensor
            und wird nicht kalibriert. Faktor und Versatz gibt es nur für
            Messwerte mit Kommastellen.
          </span>
        </div>
      ) : (
        <div style={styles.calibration}>
          <label style={styles.field}>
            <span style={styles.valueLabel}>Faktor</span>
            <input
              style={styles.input}
              inputMode="decimal"
              value={drafts?.scale ?? '1'}
              onChange={(e) => {
                setDrafts((d) => ({ scale: e.target.value, offset: d?.offset ?? '0' }));
                setError(null);
              }}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.valueLabel}>Versatz</span>
            <input
              style={styles.input}
              inputMode="decimal"
              value={drafts?.offset ?? '0'}
              onChange={(e) => {
                setDrafts((d) => ({ scale: d?.scale ?? '1', offset: e.target.value }));
                setError(null);
              }}
            />
          </label>
          <button
            style={fresh === 'frisch' ? styles.button : styles.buttonIdle}
            onClick={tare}
            disabled={busy || fresh !== 'frisch'}
            title="Versatz auf den aktuellen Rohwert setzen"
          >
            Nullen
          </button>
          <button
            style={changed ? styles.saveButton : styles.saveButtonIdle}
            onClick={save}
            disabled={busy || !changed}
          >
            {saved ? '✓' : 'Speichern'}
          </button>
          <button
            style={active ? styles.resetButton : styles.resetButtonIdle}
            onClick={reset}
            disabled={busy || !active}
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </div>
  );
}

const buttonBase: CSSProperties = {
  minHeight: 'var(--tap-min)', minWidth: 'var(--tap-min)', padding: '0 var(--space-md)',
  fontSize: 'var(--font-base)', fontWeight: 700, fontFamily: 'inherit',
  whiteSpace: 'nowrap', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};

const styles: Record<string, CSSProperties> = {
  page: {
    display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
    padding: 'var(--space-lg)', flex: 1, minHeight: 0, boxSizing: 'border-box',
  },
  identity: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 'var(--space-md)', flexShrink: 0,
  },
  /** Wraps. This is the screen that exists because a topic was truncated. */
  topic: {
    fontSize: 'var(--font-md)', fontWeight: 700, fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)', overflowWrap: 'anywhere', minWidth: 0,
  },
  ageWarn: {
    fontSize: 'var(--font-base)', fontWeight: 700,
    color: 'var(--color-warning-text)', whiteSpace: 'nowrap',
  },
  binding: {
    display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)',
    flexWrap: 'wrap', flexShrink: 0,
  },
  sensorName: {
    fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)',
  },
  meta: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  badge: {
    fontSize: 'var(--font-sm)', color: 'var(--text-secondary)',
    backgroundColor: 'var(--surface-3)', borderRadius: 'var(--radius-sm)',
    padding: '2px var(--space-sm)',
  },
  rate: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)', marginLeft: 'auto' },
  unbound: {
    fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--color-warning-text)',
  },
  clamp: { fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--color-accent)' },

  values: {
    display: 'flex', alignItems: 'flex-end', gap: 'var(--space-lg)', flexShrink: 0,
  },
  valueCell: { minWidth: '140px' },
  valueLabel: { fontSize: 'var(--font-sm)', color: 'var(--text-muted)' },
  rawValue: {
    fontSize: 'var(--font-lg)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  },
  calValue: {
    fontSize: 'var(--font-lg)', fontFamily: 'var(--font-mono)', fontWeight: 700,
    color: 'var(--text-primary)',
  },
  valueUnit: { fontSize: 'var(--font-base)', color: 'var(--text-muted)' },
  arrow: { fontSize: 'var(--font-lg)', color: 'var(--text-muted)' },
  windowRow: { display: 'flex', gap: 'var(--space-sm)', marginLeft: 'auto' },
  window: {
    ...buttonBase, fontWeight: 600, color: 'var(--text-secondary)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--border)',
  },
  windowActive: {
    ...buttonBase, color: '#fff', backgroundColor: 'var(--color-accent)',
    border: '2px solid var(--color-accent)',
  },

  chartArea: { flex: 1, minHeight: 0 },
  chartEmpty: {
    display: 'flex', alignItems: 'center', height: '100%',
    fontSize: 'var(--font-base)', color: 'var(--text-muted)',
  },

  block: {
    display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
    flexWrap: 'wrap', flexShrink: 0, padding: 'var(--space-md)',
    backgroundColor: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
  },
  blockText: {
    fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-secondary)', flex: 1, minWidth: '280px',
  },
  linkButton: {
    ...buttonBase, color: 'var(--color-accent)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--color-accent)',
  },

  calibration: {
    display: 'flex', alignItems: 'flex-end', gap: 'var(--space-md)', flexShrink: 0,
  },
  field: { display: 'flex', flexDirection: 'column', gap: '2px', width: '150px' },
  input: {
    minHeight: 'var(--tap-min)', padding: '0 var(--space-sm)',
    fontSize: 'var(--font-md)', fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)', backgroundColor: 'var(--surface-0)',
    border: '2px solid var(--border)', borderRadius: 'var(--radius-md)',
    width: '100%', boxSizing: 'border-box',
  },
  button: {
    ...buttonBase, color: 'var(--color-accent)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--color-accent)',
  },
  buttonIdle: {
    ...buttonBase, fontWeight: 600, color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-0)', border: '2px solid var(--border)',
  },
  saveButton: {
    ...buttonBase, color: '#fff', backgroundColor: 'var(--color-accent)', border: 'none',
  },
  saveButtonIdle: {
    ...buttonBase, fontWeight: 600, color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-0)', border: 'none',
  },
  resetButton: {
    ...buttonBase, fontWeight: 600, color: 'var(--color-danger)',
    backgroundColor: 'var(--surface-3)', border: 'none',
  },
  resetButtonIdle: {
    ...buttonBase, fontWeight: 600, color: 'var(--text-dim)',
    backgroundColor: 'var(--surface-2)', border: 'none',
  },

  error: {
    padding: 'var(--space-md)', fontSize: 'var(--font-base)', lineHeight: 1.4,
    color: 'var(--text-primary)', backgroundColor: 'var(--color-danger-muted)',
    borderRadius: 'var(--radius-sm)', flexShrink: 0,
  },
  notice: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    gap: 'var(--space-lg)', padding: 'var(--space-xl)',
    fontSize: 'var(--font-base)', lineHeight: 1.5, color: 'var(--text-secondary)',
  },
};
