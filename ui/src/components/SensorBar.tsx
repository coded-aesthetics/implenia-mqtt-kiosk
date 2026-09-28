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
  /** Step between labeled tick marks (default: auto from range). */
  labelStep?: number;
}

const OK = '#43a047';
const WARN = '#ef6c00';
const ERR = '#e53935';
const ACCENT = '#2196f3';
const TICK_DIM = '#2a3a52';
const LABEL_COL = '#cccccc';
const TICK_LABEL = '#8899aa';
const UNIT_COL = '#7a8a9a';

const VB_W = 640;
const VB_H = 34;
const LABEL_END = 105;
const BAR_X = LABEL_END + 4;
const VAL_X = VB_W - 52;
const UNIT_X = VAL_X + 6;
const BAR_END = VAL_X - 14;
const BAR_W = BAR_END - BAR_X;

const RANGE_Y = 0;
const RANGE_H = 3;
const BAR_Y = RANGE_Y + RANGE_H + 3;
const BAR_H = 14;

function frac(v: number, min: number, max: number) {
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
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

export function SensorBar({ value, min, max, label, unit, soll, labelStep: labelStepProp }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);

  const elements = useMemo(() => {
    const sc = statusColor(value, soll);
    const fillW = frac(value, min, max) * BAR_W;
    const parts: React.ReactNode[] = [];
    let k = 0;

    // Label
    parts.push(
      <text key={k++}
        x={0} y={BAR_Y + BAR_H / 2}
        fill={LABEL_COL} fontSize={11} fontWeight={600}
        dominantBaseline="central"
      >{label}</text>
    );

    // Value — right-aligned at fixed x
    parts.push(
      <text key={k++}
        x={VAL_X} y={BAR_Y + BAR_H / 2}
        fill={sc} fontSize={13} fontWeight={700}
        textAnchor="end" dominantBaseline="central"
        style={tabNums}
      >{formatNumber(value)}</text>
    );

    // Unit — separate column
    parts.push(
      <text key={k++}
        x={UNIT_X} y={BAR_Y + BAR_H / 2}
        fill={UNIT_COL} fontSize={9}
        dominantBaseline="central"
      >{unit}</text>
    );

    // Soll range band + triangle
    if (soll != null && soll > 0) {
      const lo25 = Math.max(min, soll * 0.75), hi25 = Math.min(max, soll * 1.25);
      const lo10 = Math.max(min, soll * 0.9), hi10 = Math.min(max, soll * 1.1);
      const rx1 = BAR_X + frac(lo25, min, max) * BAR_W;
      const rx2 = BAR_X + frac(hi25, min, max) * BAR_W;
      const gx1 = BAR_X + frac(lo10, min, max) * BAR_W;
      const gx2 = BAR_X + frac(hi10, min, max) * BAR_W;

      parts.push(
        <rect key={k++}
          x={rx1} y={RANGE_Y} width={rx2 - rx1} height={RANGE_H}
          rx={1.5} fill={WARN} opacity={0.5}
        />,
        <rect key={k++}
          x={gx1} y={RANGE_Y} width={gx2 - gx1} height={RANGE_H}
          rx={1.5} fill={OK} opacity={0.7}
        />,
      );

      const sx = BAR_X + frac(soll, min, max) * BAR_W;
      parts.push(
        <polygon key={k++}
          points={`${sx},${RANGE_Y + RANGE_H + 1} ${sx - 3},${RANGE_Y - 1} ${sx + 3},${RANGE_Y - 1}`}
          fill={OK}
        />
      );
    }

    // Track
    parts.push(
      <rect key={k++}
        x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H}
        rx={2} fill={TICK_DIM} opacity={0.45}
      />
    );

    // Fill
    parts.push(
      <rect key={k++}
        x={BAR_X} y={BAR_Y} width={fillW} height={BAR_H}
        rx={2} fill={sc} opacity={0.8}
      />
    );

    // Tick labels
    for (let v = min; v <= max + 0.001; v += labelStep) {
      const tx = BAR_X + frac(v, min, max) * BAR_W;
      parts.push(
        <text key={k++}
          x={tx} y={BAR_Y + BAR_H + 10}
          fill={TICK_LABEL} fontSize={6.5} textAnchor="middle"
        >{formatNumber(v, 0)}</text>
      );
    }

    return parts;
  }, [value, min, max, soll, label, unit, labelStep]);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={svgStyle}>
      {elements}
    </svg>
  );
}

const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const svgStyle: CSSProperties = { width: '100%', display: 'block' };
