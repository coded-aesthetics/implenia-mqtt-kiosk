import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { clampFrac, statusColor, autoLabelStep } from '../utils/sensor-viz';

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

const VB_W = 640;
const VB_H = 40;
const LABEL_END = 105;
const BAR_X = LABEL_END + 4;
const VAL_X = VB_W - 34;
const UNIT_X = VAL_X + 4;
const BAR_END = VAL_X - 56;
const BAR_W = BAR_END - BAR_X;

const RANGE_Y = 0;
const RANGE_H = 3;
const BAR_Y = RANGE_Y + RANGE_H + 3;
const BAR_H = 16;

export function SensorBar({ value, min, max, label, unit, soll, labelStep: labelStepProp }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);

  const elements = useMemo(() => {
    const sc = statusColor(value, soll);
    const fillW = clampFrac(value, min, max) * BAR_W;
    const parts: React.ReactNode[] = [];
    let k = 0;

    parts.push(
      <text key={k++}
        x={0} y={BAR_Y + BAR_H / 2}
        fill="var(--text-muted)" fontSize={13} fontWeight={600}
        dominantBaseline="central"
      >{label}</text>
    );

    parts.push(
      <text key={k++}
        x={VAL_X} y={BAR_Y + BAR_H / 2}
        fill="var(--text-primary)" fontSize={16} fontWeight={700}
        textAnchor="end" dominantBaseline="central"
        style={tabNums}
      >{formatNumber(value)}</text>
    );

    parts.push(
      <text key={k++}
        x={UNIT_X} y={BAR_Y + BAR_H / 2}
        fill="var(--text-muted)" fontSize={11}
        dominantBaseline="central"
      >{unit}</text>
    );

    if (soll != null && soll > 0) {
      const lo25 = Math.max(min, soll * 0.75), hi25 = Math.min(max, soll * 1.25);
      const lo10 = Math.max(min, soll * 0.9), hi10 = Math.min(max, soll * 1.1);
      const rx1 = BAR_X + clampFrac(lo25, min, max) * BAR_W;
      const rx2 = BAR_X + clampFrac(hi25, min, max) * BAR_W;
      const gx1 = BAR_X + clampFrac(lo10, min, max) * BAR_W;
      const gx2 = BAR_X + clampFrac(hi10, min, max) * BAR_W;

      parts.push(
        <rect key={k++}
          x={rx1} y={RANGE_Y} width={rx2 - rx1} height={RANGE_H}
          rx={1.5} fill="var(--color-warning)" opacity={0.5}
        />,
        <rect key={k++}
          x={gx1} y={RANGE_Y} width={gx2 - gx1} height={RANGE_H}
          rx={1.5} fill="var(--color-success)" opacity={0.7}
        />,
      );

      const sx = BAR_X + clampFrac(soll, min, max) * BAR_W;
      parts.push(
        <polygon key={k++}
          points={`${sx},${RANGE_Y + RANGE_H + 1} ${sx - 3},${RANGE_Y - 1} ${sx + 3},${RANGE_Y - 1}`}
          fill="var(--color-success)"
        />
      );
    }

    parts.push(
      <rect key={k++}
        x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H}
        rx={2} fill="var(--text-dim)" opacity={0.35}
      />
    );

    parts.push(
      <rect key={k++}
        x={BAR_X} y={BAR_Y} width={fillW} height={BAR_H}
        rx={2} fill={sc} opacity={0.8}
      />
    );

    for (let v = min; v <= max + 0.001; v += labelStep) {
      const tx = BAR_X + clampFrac(v, min, max) * BAR_W;
      parts.push(
        <text key={k++}
          x={tx} y={BAR_Y + BAR_H + 12}
          fill="var(--text-muted)" fontSize={9} textAnchor="middle"
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
