import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { clampFrac, statusColor, autoLabelStep } from '../utils/sensor-viz';
import { useSvgTextFit } from '../hooks/useFitScale';

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

/**
 * The reading sits in a reserved column at the right edge, and the bar stops
 * short of it.
 *
 * It used to be anchored 34 units from that edge with the unit beyond it,
 * which put `cm/min` outside the viewBox — SVG clips, so it read `cm/mi` — and
 * left 56 units for the number itself. 56 is a two-digit reading. `Durchfluss
 * B` runs past 1000 l/min on the only rig that has been captured, so the
 * number was drawn straight across the end of its own bar.
 *
 * 140 units holds `12.345,67 l/min` in the kiosk's font with room to spare,
 * and it costs the bar 15 % of its length — which changes nothing a worker
 * reads, since the bar is a proportion and the number beside it is the value.
 * The reserve is **constant**: sizing it per value would move the tick marks
 * whenever a reading crossed 100, and an axis that rescales while you watch it
 * is worse than a short bar.
 */
const VALUE_RESERVE = 140;
const VALUE_GAP = 8;
const BAR_END = VB_W - VALUE_RESERVE - VALUE_GAP;
const BAR_W = BAR_END - BAR_X;

const RANGE_Y = 0;
const RANGE_H = 3;
const BAR_Y = RANGE_Y + RANGE_H + 3;
const BAR_H = 16;

export function SensorBar({ value, min, max, label, unit, soll, labelStep: labelStepProp }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);
  const valueText = formatNumber(value);
  // Scaled about the right edge, so a shrunk reading stays flush with the ones
  // above and below it rather than drifting toward the bar.
  const { ref: valueRef, scale: valueScale } = useSvgTextFit(
    `${valueText} ${unit}`, VALUE_RESERVE,
  );

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

    // One right-aligned group, anchored at the viewBox edge: the unit can no
    // longer be pushed out of the picture by a wide number, and nothing has to
    // know how wide `l/min` is.
    parts.push(
      <text key={k++}
        ref={valueRef}
        x={VB_W} y={BAR_Y + BAR_H / 2}
        textAnchor="end" dominantBaseline="central"
        transform={valueScale < 1
          ? `translate(${VB_W} 0) scale(${valueScale}) translate(${-VB_W} 0)`
          : undefined}
      >
        <tspan
          fill="var(--text-primary)" fontSize={16} fontWeight={700}
          style={tabNums}
        >{valueText}</tspan>
        <tspan fill="var(--text-muted)" fontSize={11} dx={4}>{unit}</tspan>
      </text>
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
  }, [value, valueText, valueScale, valueRef, min, max, soll, label, unit, labelStep]);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={svgStyle}>
      {elements}
    </svg>
  );
}

const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const svgStyle: CSSProperties = { width: '100%', display: 'block' };
