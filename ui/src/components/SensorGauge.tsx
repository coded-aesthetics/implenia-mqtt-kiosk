import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { clampFrac, statusColor, autoLabelStep } from '../utils/sensor-viz';
import { useSvgTextFit } from '../hooks/useFitScale';

/**
 * How wide the reading may be, in viewBox units.
 *
 * The dial is 200 units across and the value sits at its centre, where the
 * nearest obstruction is the inner end of the tick marks at radius 54. The
 * text band reaches about 29 units above the centre line, which leaves
 * `sqrt(54² - 29²) ≈ 45` to either side — so 90 is the width at which digits
 * stop before the ticks rather than through them. A five-character reading
 * (`90,01`) is well inside it; `299,87` is not, and that is the one that was
 * being drawn over the scale.
 */
const VALUE_BUDGET = 90;

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
  /** Render as a 180° semicircle arc instead of the default 270°. Label is omitted — render it externally. */
  half?: boolean;
  /** Hide the label text inside the dial (render it externally instead). */
  hideLabel?: boolean;
}

const DEG = Math.PI / 180;
const START = 225;
const END = -45;

function px(cx: number, r: number, a: number) { return cx + r * Math.cos(a * DEG); }
function py(cy: number, r: number, a: number) { return cy - r * Math.sin(a * DEG); }

/** Scale about the text's own anchor, so a shrunk reading stays centred. */
function shrink(x: number, y: number, scale: number): string | undefined {
  if (scale >= 1) return undefined;
  return `translate(${x} ${y}) scale(${scale}) translate(${-x} ${-y})`;
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const x1 = px(cx, r, from), y1 = py(cy, r, from);
  const x2 = px(cx, r, to), y2 = py(cy, r, to);
  const large = Math.abs(from - to) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

export function SensorGauge({ value, min, max, label, unit, soll, ticks = 60, labelStep: labelStepProp, size = 240, half, hideLabel }: Props) {
  const labelStep = labelStepProp ?? autoLabelStep(max - min);
  const valueText = formatNumber(value);
  const { ref: valueRef, scale: valueScale } = useSvgTextFit(valueText, VALUE_BUDGET);

  const elements = useMemo(() => {
    const cx = 100, cy = 100;
    const rInner = 58, rOuter = 74, rLabels = 86, rRim = rOuter + 3;

    const aStart = half ? 180 : START;
    const aEnd = half ? 0 : END;
    const aSpan = aStart - aEnd;
    const toAngle = (v: number) => aStart - clampFrac(v, min, max) * aSpan;

    const valAngle = toAngle(value);
    const sc = statusColor(value, soll);
    const parts: React.ReactNode[] = [];
    let k = 0;

    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const tickVal = min + frac * (max - min);
      const a = toAngle(tickVal);
      const isMajor = Math.abs(tickVal % labelStep) < 0.001 || Math.abs(tickVal % labelStep - labelStep) < 0.001;
      const ri = isMajor ? rInner - 4 : rInner;
      const filled = a <= aStart && a >= valAngle;
      const tickColor = filled ? sc : 'var(--text-dim)';
      const tickAlpha = filled ? (isMajor ? 0.95 : 0.7) : 0.5;
      const tickW = isMajor ? 2.5 : (filled ? 1.5 : 1.2);
      parts.push(
        <line key={k++}
          x1={px(cx, ri, a)} y1={py(cy, ri, a)}
          x2={px(cx, rOuter, a)} y2={py(cy, rOuter, a)}
          stroke={tickColor} strokeWidth={tickW} opacity={tickAlpha} strokeLinecap="round"
        />
      );
    }

    if (soll != null && soll > 0) {
      const o25l = Math.max(min, soll * 0.75), o25h = Math.min(max, soll * 1.25);
      const o10l = Math.max(min, soll * 0.9), o10h = Math.min(max, soll * 1.1);

      parts.push(
        <path key={k++}
          d={arc(cx, cy, rRim, toAngle(o25l), toAngle(o25h))}
          fill="none" stroke="var(--color-warning)" strokeWidth={3} strokeLinecap="round"
        />,
        <path key={k++}
          d={arc(cx, cy, rRim, toAngle(o10l), toAngle(o10h))}
          fill="none" stroke="var(--color-success)" strokeWidth={3} strokeLinecap="round"
        />,
      );

      const sollA = toAngle(soll);
      const baseR = rRim + 1.5, tipR = rRim - 7, spread = 2.2;
      const tip = `${px(cx, tipR, sollA)},${py(cy, tipR, sollA)}`;
      const b1 = `${px(cx, baseR, sollA + spread)},${py(cy, baseR, sollA + spread)}`;
      const b2 = `${px(cx, baseR, sollA - spread)},${py(cy, baseR, sollA - spread)}`;
      parts.push(<polygon key={k++} points={`${tip} ${b1} ${b2}`} fill="var(--color-success)" />);
    }

    const labels: number[] = [];
    for (let v = min; v <= max + 0.001; v += labelStep) labels.push(Math.round(v * 100) / 100);

    for (const lv of labels) {
      const a = toAngle(lv);
      const lx = px(cx, rLabels, a), ly = py(cy, rLabels, a);
      let rot = -a + 90;
      if (rot < -90) rot += 180;
      parts.push(
        <text key={k++}
          x={lx} y={ly} fill="var(--text-muted)"
          fontSize={11} fontWeight={600} textAnchor="middle" dominantBaseline="central"
          transform={`rotate(${rot} ${lx} ${ly})`}
        >
          {formatNumber(lv, 0)}
        </text>
      );
    }

    if (half) {
      // Reading and unit sit 10 units lower than they used to, which puts them
      // across the dial's open bottom instead of leaving that strip empty and
      // crowding the arc above. The viewBox follows them down (see `vbH`), so
      // the dial is shorter than it was — vertical room the gauge row needs
      // more than the gap under the number.
      parts.push(
        <text key={k++}
          ref={valueRef}
          x={cx} y={cy - 8} fill="var(--text-primary)"
          fontSize={32} fontWeight={800} textAnchor="middle" dominantBaseline="auto"
          style={tabNums}
          transform={shrink(cx, cy - 8, valueScale)}
        >
          {valueText}
        </text>,
        <text key={k++} x={cx} y={cy + 8} fill="var(--text-muted)" fontSize={12} textAnchor="middle">
          {unit}
        </text>,
      );
    } else {
      parts.push(
        <text key={k++}
          ref={valueRef}
          x={cx} y={cy + 4} fill="var(--text-primary)"
          fontSize={32} fontWeight={800} textAnchor="middle" dominantBaseline="auto"
          style={tabNums}
          transform={shrink(cx, cy + 4, valueScale)}
        >
          {valueText}
        </text>,
        <text key={k++} x={cx} y={cy + 24} fill="var(--text-muted)" fontSize={12} textAnchor="middle">
          {unit}
        </text>,
      );
      if (!hideLabel) {
        parts.push(
          <text key={k++} x={cx} y={cy + 38} fill="var(--text-muted)" fontSize={10} textAnchor="middle">
            {label}
          </text>,
        );
      }
    }

    return parts;
  }, [value, valueText, valueScale, valueRef, min, max, soll, label, unit, ticks, labelStep, half, hideLabel]);

  /*
   * The half dial's box has to follow its readout down.
   *
   * 115 was not slack: the gauge label underneath is pulled up into it by
   * `gaugeLabelText`'s negative margin, so the strip below the unit was
   * already spoken for. Dropping the readout 10 units and keeping 115 put the
   * unit through `DRUCK HAMMER`. 120 restores the clearance the label was
   * drawn with.
   *
   * Which is worth saying plainly: moving the reading down does not win
   * vertical space here, it costs about 6px a dial. What the arrangement buys
   * is a readout centred in the dial's opening rather than pressed against the
   * arc above it. The vertical space on this screen is in the full dial, whose
   * box runs to 200 while its scale ends at 162.
   */
  const vbH = half ? 120 : 200;
  const svgH = half ? Math.round(size * vbH / 200) : size;

  return (
    <svg viewBox={`0 0 200 ${vbH}`} width={size} height={svgH} style={gaugeStyle}>
      {elements}
    </svg>
  );
}

const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const gaugeStyle: CSSProperties = { flexShrink: 0, display: 'block' };
