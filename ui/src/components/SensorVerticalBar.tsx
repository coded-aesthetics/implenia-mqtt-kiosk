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
  labelStep?: number;
  height?: number;
  width?: number;
}

const VB_W = 80;
const VB_H = 300;
const BAR_X = 30;
const BAR_W = 24;
const BAR_TOP = 10;
const BAR_BOTTOM = VB_H - 70;
const BAR_HEIGHT = BAR_BOTTOM - BAR_TOP;
const SOLL_BAND_X = BAR_X + BAR_W + 2;
const SOLL_BAND_W = 4;

function valToY(v: number, min: number, max: number): number {
  return BAR_BOTTOM - clampFrac(v, min, max) * BAR_HEIGHT;
}

export function SensorVerticalBar({ value, min, max, label, unit, soll, labelStep: labelStepProp, height = 300, width = 80 }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);

  const elements = useMemo(() => {
    const sc = statusColor(value, soll);
    const fillH = clampFrac(value, min, max) * BAR_HEIGHT;
    const parts: React.ReactNode[] = [];
    let k = 0;

    // Background bar
    parts.push(
      <rect key={k++}
        x={BAR_X} y={BAR_TOP} width={BAR_W} height={BAR_HEIGHT}
        rx={2} fill="var(--text-dim)" opacity={0.25}
      />,
    );

    // Fill bar (from bottom)
    if (fillH > 0) {
      parts.push(
        <rect key={k++}
          x={BAR_X} y={BAR_BOTTOM - fillH} width={BAR_W} height={fillH}
          rx={2} fill={sc} opacity={0.8}
        />,
      );
    }

    // Soll range bands
    if (soll != null && soll > 0) {
      const o25l = Math.max(min, soll * 0.75), o25h = Math.min(max, soll * 1.25);
      const o10l = Math.max(min, soll * 0.9), o10h = Math.min(max, soll * 1.1);

      const y25t = valToY(o25h, min, max), y25b = valToY(o25l, min, max);
      const y10t = valToY(o10h, min, max), y10b = valToY(o10l, min, max);

      parts.push(
        <rect key={k++}
          x={SOLL_BAND_X} y={y25t} width={SOLL_BAND_W} height={y25b - y25t}
          rx={1.5} fill="var(--color-warning)" opacity={0.5}
        />,
        <rect key={k++}
          x={SOLL_BAND_X} y={y10t} width={SOLL_BAND_W} height={y10b - y10t}
          rx={1.5} fill="var(--color-success)" opacity={0.7}
        />,
      );

      // Soll marker triangle (pointing left into the bar)
      const sollY = valToY(soll, min, max);
      parts.push(
        <polygon key={k++}
          points={`${SOLL_BAND_X + SOLL_BAND_W + 1},${sollY} ${SOLL_BAND_X + SOLL_BAND_W + 7},${sollY - 3} ${SOLL_BAND_X + SOLL_BAND_W + 7},${sollY + 3}`}
          fill="var(--color-success)"
        />,
      );
    }

    // Scale labels on the left
    for (let v = min; v <= max + 0.001; v += labelStep) {
      const y = valToY(v, min, max);
      parts.push(
        <line key={k++}
          x1={BAR_X - 3} y1={y} x2={BAR_X} y2={y}
          stroke="var(--text-dim)" strokeWidth={1} opacity={0.6}
        />,
        <text key={k++}
          x={BAR_X - 5} y={y}
          fill="var(--text-muted)" fontSize={9} fontWeight={500}
          textAnchor="end" dominantBaseline="central"
        >
          {formatNumber(v, 0)}
        </text>,
      );
    }

    // Value readout below
    parts.push(
      <text key={k++}
        x={VB_W / 2} y={BAR_BOTTOM + 22}
        fill="#ffffff" fontSize={18} fontWeight={800}
        textAnchor="middle" dominantBaseline="auto"
        style={tabNums}
      >
        {formatNumber(value)}
      </text>,
      <text key={k++}
        x={VB_W / 2} y={BAR_BOTTOM + 36}
        fill="var(--text-muted)" fontSize={10} textAnchor="middle"
      >
        {unit}
      </text>,
      <text key={k++}
        x={VB_W / 2} y={BAR_BOTTOM + 50}
        fill="var(--text-muted)" fontSize={9} fontWeight={600} textAnchor="middle"
      >
        {label}
      </text>,
    );

    return parts;
  }, [value, min, max, soll, label, unit, labelStep]);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width} height={height} style={svgStyle}>
      {elements}
    </svg>
  );
}

const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const svgStyle: CSSProperties = { flexShrink: 0, display: 'block' };
