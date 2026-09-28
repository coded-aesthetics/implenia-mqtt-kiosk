import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';

interface Props {
  value: number;
  min: number;
  max: number;
  label: string;
  unit: string;
  soll?: number | null;
  /** Number of ticks across the full arc (default 60). */
  ticks?: number;
  /** Step between labeled tick marks (default: auto from range). */
  labelStep?: number;
  /** SVG width/height in px — the gauge scales to fit (default 240). */
  size?: number;
}

const DEG = Math.PI / 180;
const START = 225;
const END = -45;
const SPAN = START - END;

const OK = '#43a047';
const WARN = '#ef6c00';
const ERR = '#e53935';
const ACCENT = '#2196f3';
const TICK_DIM = '#2a3a52';
const LABEL_COLOR = '#8899aa';
const MUTED = '#4a5a6a';

function px(cx: number, r: number, a: number) { return cx + r * Math.cos(a * DEG); }
function py(cy: number, r: number, a: number) { return cy - r * Math.sin(a * DEG); }

function valToAngle(v: number, min: number, max: number) {
  const frac = Math.max(0, Math.min(1, (v - min) / (max - min)));
  return START - frac * SPAN;
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const x1 = px(cx, r, from), y1 = py(cy, r, from);
  const x2 = px(cx, r, to), y2 = py(cy, r, to);
  const large = Math.abs(from - to) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function statusColor(val: number, soll: number | null | undefined) {
  if (!soll || soll <= 0) return ACCENT;
  const dev = Math.abs(val - soll) / soll;
  if (dev < 0.10) return OK;
  if (dev < 0.25) return WARN;
  return ERR;
}


function autoLabelStep(range: number): number {
  const raw = range / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

export function SensorGauge({ value, min, max, label, unit, soll, ticks = 60, labelStep: labelStepProp, size = 240 }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);

  const elements = useMemo(() => {
    const cx = 100, cy = 100;
    const rInner = 58, rOuter = 74, rLabels = 86, rRim = rOuter + 3;
    const valAngle = valToAngle(value, min, max);
    const sc = statusColor(value, soll);
    const parts: React.ReactNode[] = [];
    let k = 0;

    // Tick marks
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const tickVal = min + frac * (max - min);
      const a = valToAngle(tickVal, min, max);
      const isMajor = Math.abs(tickVal % labelStep) < 0.001 || Math.abs(tickVal % labelStep - labelStep) < 0.001;
      const ri = isMajor ? rInner - 4 : rInner;
      const filled = a <= START && a >= valAngle;
      const tickColor = filled ? sc : TICK_DIM;
      const tickAlpha = filled ? (isMajor ? 0.95 : 0.7) : 1;
      const tickW = isMajor ? 2.5 : (filled ? 1.5 : 1.2);
      parts.push(
        <line key={k++}
          x1={px(cx, ri, a)} y1={py(cy, ri, a)}
          x2={px(cx, rOuter, a)} y2={py(cy, rOuter, a)}
          stroke={tickColor} strokeWidth={tickW} opacity={tickAlpha} strokeLinecap="round"
        />
      );
    }

    // Soll zone rim + triangle
    if (soll != null && soll > 0) {
      const o25l = Math.max(min, soll * 0.75), o25h = Math.min(max, soll * 1.25);
      const o10l = Math.max(min, soll * 0.9), o10h = Math.min(max, soll * 1.1);

      parts.push(
        <path key={k++}
          d={arc(cx, cy, rRim, valToAngle(o25l, min, max), valToAngle(o25h, min, max))}
          fill="none" stroke={WARN} strokeWidth={3} strokeLinecap="round"
        />,
        <path key={k++}
          d={arc(cx, cy, rRim, valToAngle(o10l, min, max), valToAngle(o10h, min, max))}
          fill="none" stroke={OK} strokeWidth={3} strokeLinecap="round"
        />,
      );

      // Triangle at exact Soll — base on rim, tip inward
      const sollA = valToAngle(soll, min, max);
      const baseR = rRim + 1.5, tipR = rRim - 7, spread = 2.2;
      const tip = `${px(cx, tipR, sollA)},${py(cy, tipR, sollA)}`;
      const b1 = `${px(cx, baseR, sollA + spread)},${py(cy, baseR, sollA + spread)}`;
      const b2 = `${px(cx, baseR, sollA - spread)},${py(cy, baseR, sollA - spread)}`;
      parts.push(<polygon key={k++} points={`${tip} ${b1} ${b2}`} fill={OK} />);
    }

    // Radial labels
    const labels: number[] = [];
    for (let v = min; v <= max + 0.001; v += labelStep) labels.push(Math.round(v * 100) / 100);

    for (const lv of labels) {
      const a = valToAngle(lv, min, max);
      const lx = px(cx, rLabels, a), ly = py(cy, rLabels, a);
      let rot = -a + 90;
      if (rot < -90) rot += 180;
      parts.push(
        <text key={k++}
          x={lx} y={ly} fill={LABEL_COLOR}
          fontSize={9} fontWeight={600} textAnchor="middle" dominantBaseline="central"
          transform={`rotate(${rot} ${lx} ${ly})`}
        >
          {formatNumber(lv, 0)}
        </text>
      );
    }

    // Center value
    parts.push(
      <text key={k++}
        x={cx} y={cy - 6} fill={sc}
        fontSize={28} fontWeight={800} textAnchor="middle" dominantBaseline="auto"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatNumber(value)}
      </text>,
      <text key={k++} x={cx} y={cy + 12} fill={LABEL_COLOR} fontSize={10} textAnchor="middle">
        {unit}
      </text>,
      <text key={k++} x={cx} y={cy + 26} fill={MUTED} fontSize={8} textAnchor="middle">
        {label}
      </text>,
    );

    return parts;
  }, [value, min, max, soll, label, unit, ticks, labelStep]);

  return (
    <svg viewBox="0 0 200 200" width={size} height={size} style={style}>
      {elements}
    </svg>
  );
}

const style: CSSProperties = { flexShrink: 0, display: 'block' };
