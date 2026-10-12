import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { formatNumber } from '../utils/format';
import { bewerteStatus, statusFarbe, sollImBild, MAX_VERTIKAL } from '../utils/ausrichtung';

/**
 * The inclination dial: a quarter circle, 0° straight down, 90° horizontal.
 *
 * The needle **is the mast**. It hangs from a pivot sitting on a hatched
 * ground line and leans the way the drill has to lean, so the dial reads as a
 * side view of the rig rather than as an instrument — which is what makes
 * "stärker neigen" obvious without reading the words. A 270° arc like the
 * Bohren gauges would have been consistent, and meant nothing: it would spend
 * three quarters of its scale on angles no mast can reach.
 *
 * Tick rim, outside labels and the Soll triangle on its tolerance arc are the
 * same as everywhere else. The reading sits in the bottom-right, the one
 * corner a quarter dial always leaves empty — every point there is further
 * from the pivot than the outermost ring, whatever the angle.
 */

interface Props {
  /** Live inclination, or null when nothing has arrived for this sensor. */
  ist: number | null;
  /**
   * The inclination to aim for, or **null when the Schichtauftrag has none**.
   *
   * Null rather than a stand-in 0, which would draw a dashed mast hanging
   * plumb — a target nobody specified, on the dial the operator sets the mast
   * by. See the rotation dial for the same reasoning.
   */
  soll: number | null;
  toleranz: number;
  /** End of the scale. The machine's real maximum is an open question. */
  max?: number;
  veraltet?: boolean;
}

/** The mast's colour when there is no Soll to judge it against. */
const OHNE_URTEIL = 'var(--text-primary)';

const DEG = Math.PI / 180;
const PX = 84;
const PY = 58;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 0° points down from the pivot, 90° to the right — the mast's own geometry. */
function pt(r: number, deg: number): [number, number] {
  const a = deg * DEG;
  return [round(PX + r * Math.sin(a)), round(PY + r * Math.cos(a))];
}

function arc(r: number, from: number, d: number): string {
  const [x1, y1] = pt(r, from);
  const [x2, y2] = pt(r, from + d);
  // Sweep 0 for a rising angle: down → right runs counter-clockwise on screen.
  return `M ${x1} ${y1} A ${r} ${r} 0 ${Math.abs(d) > 180 ? 1 : 0} ${d >= 0 ? 0 : 1} ${x2} ${y2}`;
}

function tri(deg: number, rTip: number, rBase: number, spread: number): string {
  const [tx, ty] = pt(rTip, deg);
  const [ax, ay] = pt(rBase, deg - spread);
  const [bx, by] = pt(rBase, deg + spread);
  return `${tx},${ty} ${ax},${ay} ${bx},${by}`;
}

/**
 * The marker for a Soll that lies off the end of the scale: a chevron *at*
 * that end, pointing past it, rather than a mark pinned onto the last degree
 * the dial can draw.
 *
 * The Soll used to be clamped into `0…max`, which is wrong in the one way this
 * screen cannot afford. A Vorgabe of -8° at a live 0° put the dashed Soll mast
 * exactly under the real one — the picture said aligned while the words said
 * `8,0° steiler stellen`, on a dial whose whole instruction is "lay one line
 * over the other". Clamping the *Ist* is defensible because the number below
 * it tells the truth; the Soll has no such escape hatch.
 */
function ausserhalbMarke(ende: number, richtung: number): string {
  const [tx, ty] = pt(210, ende + richtung * 5);
  const [ax, ay] = pt(201, ende);
  const [bx, by] = pt(219, ende);
  return `${tx},${ty} ${ax},${ay} ${bx},${by}`;
}

export function NeigungDial({ ist, soll, toleranz, max = MAX_VERTIKAL, veraltet }: Props) {
  const parts = useMemo(() => {
    const out: React.ReactNode[] = [];
    let k = 0;
    // The *Ist* only: a reading past the end of the scale still has to point
    // somewhere, and the number below it says what it really is. The Soll is
    // never clamped — see `ausserhalbMarke`.
    const klemm = (w: number): number => Math.max(0, Math.min(max, w));

    for (let deg = 0; deg <= max; deg += 2) {
      const major = deg % 10 === 0;
      const [x1, y1] = pt(major ? 160 : 172, deg);
      const [x2, y2] = pt(202, deg);
      out.push(
        <line key={k++}
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="var(--text-dim)" strokeWidth={major ? 3 : 1.4}
          opacity={major ? 0.9 : 0.5} strokeLinecap="round"
        />,
      );
    }

    for (let deg = 0; deg <= max; deg += 10) {
      const [x, y] = pt(266, deg);
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
     * The Soll as a second mast: a dashed ray from the pivot in the direction
     * the drill has to lean, ending in its marker on the rim. Aligning is then
     * laying one line over the other, which is what the operator is physically
     * doing.
     */
    if (sollImBild(soll, max)) {
      out.push(
        <line key={k++}
          x1={pt(22, soll)[0]} y1={pt(22, soll)[1]}
          x2={pt(168, soll)[0]} y2={pt(168, soll)[1]}
          stroke="var(--color-success)" strokeWidth={3} strokeDasharray="8 7" opacity={0.8}
        />,
        <path key={k++}
          d={arc(210, soll - toleranz, 2 * toleranz)}
          fill="none" stroke="var(--color-success)" strokeWidth={9} strokeLinecap="round"
        />,
        <polygon key={k++} points={tri(soll, 203, 222, 4.5)} fill="var(--color-success)" />,
      );
    } else if (soll !== null) {
      const ende = soll < 0 ? 0 : max;
      out.push(
        <polygon key={k++}
          points={ausserhalbMarke(ende, soll < 0 ? -1 : 1)} fill="var(--color-success)"
        />,
      );
    }

    if (ist !== null) {
      const istK = klemm(ist);
      const farbe = veraltet
        ? 'var(--text-dim)'
        : soll === null ? OHNE_URTEIL : statusFarbe(bewerteStatus(soll - ist, toleranz));
      const [tipX, tipY] = pt(168, istK);
      const [aX, aY] = pt(9, istK - 90);
      const [bX, bY] = pt(9, istK + 90);
      out.push(
        <polygon key={k++}
          points={`${tipX},${tipY} ${aX},${aY} ${bX},${bY}`}
          fill={farbe} opacity={veraltet ? 0.4 : 1}
        />,
        <circle key={k++} cx={PX} cy={PY} r={10} fill={farbe} opacity={veraltet ? 0.4 : 1} />,
        <polygon key={k++}
          points={tri(istK, 226, 248, 5)} fill={farbe} opacity={veraltet ? 0.4 : 1}
        />,
      );
    } else {
      out.push(<circle key={k++} cx={PX} cy={PY} r={10} fill="var(--text-dim)" opacity={0.4} />);
    }

    return out;
  }, [ist, soll, toleranz, max, veraltet]);

  const hatch = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (let x = 12; x < PX; x += 14) {
      out.push(
        <line key={x} x1={x} y1={PY} x2={x - 8} y2={PY + 10} stroke="var(--border)" strokeWidth={2} />,
      );
    }
    return out;
  }, []);

  return (
    <svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet" style={svgStyle}
      role="img"
      aria-label={[
        `Vertikalneigung: ${ist === null ? 'kein Wert' : `${formatNumber(ist, 1)} Grad`}`,
        soll === null ? 'keine Vorgabe' : `Soll ${formatNumber(soll, 1)} Grad`,
      ].join(', ')}
    >
      <line x1={4} y1={PY} x2={PX} y2={PY} stroke="var(--border)" strokeWidth={3} />
      {hatch}
      {parts}
      <text x={392} y={346} fill="var(--text-primary)" fontSize={62} fontWeight={800}
        textAnchor="end" style={tabNums}
      >
        {ist === null ? '–' : `${formatNumber(ist, 1)}°`}
      </text>
      <text x={392} y={376} fill="var(--text-muted)" fontSize={17} fontWeight={600} textAnchor="end">
        Ist
      </text>
    </svg>
  );
}

/** Fills its box, like the rotation dial — see the note there. */
const svgStyle: CSSProperties = { display: 'block', width: '100%', height: '100%' };
const tabNums: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
