import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { kuerzesterWeg, norm360, bewerteStatus, statusFarbe } from '../utils/ausrichtung';

/**
 * The rotation dial: a full circle, 0° at the top, clockwise.
 *
 * Same visual language as SensorGauge — tick rim, labels outside it, the Soll
 * as a green triangle sitting on its own tolerance arc — with one difference
 * that matters: the ticks stay neutral and a **pointer** marks the Ist. A
 * filled arc from the minimum is meaningless on a compass, which has no
 * minimum; and the operator is not reading a level here, they are turning a
 * machine until two marks line up.
 *
 * Between the two marks runs the **Abweichungskeil**: an arc from Ist to Soll
 * the short way round, with an arrowhead at the Soll end. It is what turns the
 * dial from an instrument into an instruction — which way, and how far — and
 * it is why the pointer is a single triangle outside the rim rather than the
 * pair on both sides of it: the inside of the rim is where the keil lives.
 *
 * `ist === null` means no reading has ever arrived; `veraltet` means the last
 * one is too old to trust. Neither draws a keil: a direction derived from a
 * frozen angle is a guess, and acting on it costs a turn of the machine.
 */

interface Props {
  /** Live rotation, or null when nothing has arrived for this sensor. */
  ist: number | null;
  soll: number;
  toleranz: number;
  /** The last reading is older than VERALTET_MS — show it, but not as live. */
  veraltet?: boolean;
}

const DEG = Math.PI / 180;
const C = 200;

function pt(r: number, deg: number): [number, number] {
  const a = (deg - 90) * DEG;
  return [round(C + r * Math.cos(a)), round(C + r * Math.sin(a))];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `d` is signed: positive sweeps clockwise. */
function arc(r: number, from: number, d: number): string {
  const [x1, y1] = pt(r, from);
  const [x2, y2] = pt(r, from + d);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${Math.abs(d) > 180 ? 1 : 0} ${d >= 0 ? 1 : 0} ${x2} ${y2}`;
}

function tri(deg: number, rTip: number, rBase: number, spread: number): string {
  const [tx, ty] = pt(rTip, deg);
  const [ax, ay] = pt(rBase, deg - spread);
  const [bx, by] = pt(rBase, deg + spread);
  return `${tx},${ty} ${ax},${ay} ${bx},${by}`;
}

export function RotationDial({ ist, soll, toleranz, veraltet }: Props) {
  const parts = useMemo(() => {
    const out: React.ReactNode[] = [];
    let k = 0;

    for (let i = 0; i < 72; i++) {
      const deg = i * 5;
      const major = deg % 30 === 0;
      const [x1, y1] = pt(major ? 100 : 110, deg);
      const [x2, y2] = pt(134, deg);
      out.push(
        <line key={k++}
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="var(--text-dim)" strokeWidth={major ? 3 : 1.4}
          opacity={major ? 0.9 : 0.5} strokeLinecap="round"
        />,
      );
    }

    for (let deg = 0; deg < 360; deg += 30) {
      const [x, y] = pt(188, deg);
      out.push(
        <text key={k++}
          x={x} y={y} fill="var(--text-muted)" fontSize={15} fontWeight={700}
          textAnchor="middle" dominantBaseline="central"
        >
          {deg}
        </text>,
      );
    }

    /*
     * The Soll sits on the rim, directly outside the ticks, and the Ist
     * pointer one ring further out — so the two marks are neighbours and
     * "lined up" is a thing you see rather than two numbers to compare. The
     * Soll band *was* outside the labels, which made it read as something
     * floating next to the dial instead of a position on it.
     *
     * Its tolerance is the width of the arc: aligned is an extent on screen,
     * not a figure to work out.
     */
    out.push(
      <path key={k++}
        d={arc(142, soll - toleranz, 2 * toleranz)}
        fill="none" stroke="var(--color-success)" strokeWidth={9} strokeLinecap="round"
      />,
      <polygon key={k++} points={tri(soll, 136, 151, 4.5)} fill="var(--color-success)" />,
    );

    if (ist !== null) {
      const abw = kuerzesterWeg(ist, soll);
      const status = bewerteStatus(abw, toleranz);
      const farbe = veraltet ? 'var(--text-dim)' : statusFarbe(status);

      if (!veraltet && status !== 'ok') {
        const vz = abw >= 0 ? 1 : -1;
        const [tx, ty] = pt(96, soll);
        const [ax, ay] = pt(84, soll - vz * 6);
        const [bx, by] = pt(108, soll - vz * 6);
        out.push(
          <path key={k++}
            d={arc(96, ist, abw)}
            fill="none" stroke={farbe} strokeWidth={11} strokeLinecap="round" opacity={0.9}
          />,
          <polygon key={k++} points={`${tx},${ty} ${ax},${ay} ${bx},${by}`} fill={farbe} />,
        );
      }

      out.push(
        <polygon key={k++}
          points={tri(ist, 155, 173, 5)} fill={farbe}
          opacity={veraltet ? 0.4 : 1}
        />,
      );
    }

    return out;
  }, [ist, soll, toleranz, veraltet]);

  return (
    <svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet" style={svgStyle}
      role="img"
      aria-label={ist === null
        ? `Horizontalneigung: kein Wert, Soll ${formatNumber(soll, 1)} Grad`
        : `Horizontalneigung: ${formatNumber(norm360(ist), 1)} Grad, Soll ${formatNumber(soll, 1)} Grad`}
    >
      <circle cx={C} cy={C} r={138} fill="var(--surface-1)" />
      {parts}
      <text x={C} y={196} fill="var(--text-primary)" fontSize={62} fontWeight={800}
        textAnchor="middle" style={tabNums}
      >
        {ist === null ? '–' : `${formatNumber(norm360(ist), 1)}°`}
      </text>
      <text x={C} y={226} fill="var(--text-muted)" fontSize={17} fontWeight={600} textAnchor="middle">
        Ist
      </text>
    </svg>
  );
}

/**
 * Fills whatever box it is given, keeping its aspect ratio.
 *
 * No measured pixel size: the content area is 612px with the recording bar and
 * more without it, and a fixed size either left a strip of dead space under
 * the dial or overflowed a screen that must never scroll.
 */
const svgStyle: CSSProperties = { display: 'block', width: '100%', height: '100%' };
const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
