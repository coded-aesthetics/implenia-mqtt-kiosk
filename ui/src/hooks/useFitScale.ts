import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Shrink a readout until it fits the room it has.
 *
 * Every number on the drilling screen is drawn into a space that was sized by
 * eye, against whatever font the development machine happened to resolve. The
 * kiosk has a different one — see `--font-body` in tokens.css — and the field
 * values are wider than the ones that were on screen while the layout was
 * built: `Durchfluss B` runs past 1000 l/min, the gauges past 200, the total
 * volume past 100 000 l. Each of those drew its digits straight over the
 * graphic it is measured against.
 *
 * Reserving room for the worst case instead would mean sizing every bar and
 * dial for a number that appears for a few seconds a shift, and a measurement
 * that nothing is allowed to cover can only be shrunk. So: normal values are
 * untouched, and the rare wide one gets smaller rather than colliding.
 *
 * Both hooks measure rather than estimate. A character-width table would be a
 * second place where the font matters, and it would be wrong on exactly the
 * machine nobody is looking at.
 */

/**
 * The gap a fitted reading keeps to each edge of its box, in px.
 *
 * Fitting flush is what the arithmetic says and not what it should do. Measured
 * on the briefing screen at 1024x768 in a deliberately wide face: a 2 500 l
 * `Sollvolumen` — an ordinary value, not a stress case — shrank to exactly its
 * 385px cell, so its `l` was painted hard against the boundary with the
 * Bohrlänge's cell 12px away. It reads as clipped whether or not it is, and a
 * worker glancing at a kiosk has no way to tell the difference.
 *
 * 8px costs a value at the limit about 4% of its size and nothing at all to a
 * value that already fits, which is almost all of them.
 */
const POLSTER = 8;

/** A string's shape, so re-measuring happens per *width class*, not per value. */
function shapeOf(text: string): string {
  return text.replace(/\d/g, '0');
}

/**
 * Scale for an SVG `<text>`, in the user units of its viewBox.
 *
 * `getComputedTextLength` reports the intrinsic length and ignores transforms
 * on the element itself, so measuring an already-scaled text still answers for
 * the unscaled one — no feedback loop.
 */
export function useSvgTextFit(
  text: string,
  budget: number,
): { ref: RefObject<SVGTextElement | null>; scale: number } {
  const ref = useRef<SVGTextElement | null>(null);
  const [scale, setScale] = useState(1);
  const shape = shapeOf(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || budget <= 0) return;
    let width = 0;
    try {
      width = el.getComputedTextLength();
    } catch {
      return; // jsdom and friends; an unscaled readout beats a crash
    }
    setScale(width > budget && width > 0 ? budget / width : 1);
  }, [shape, budget]);

  return { ref, scale };
}

/**
 * Scale for an HTML element against the width of its container.
 *
 * Used where the available width is itself the product of a flex layout and so
 * is not a constant anybody can write down — the total volume beside the
 * Klemmbacke, whose cell narrows as the pipe counter appears, and the
 * briefing's six Soll cells, which share the column between them.
 *
 * `outer` is optional. Attached, it names the box the reading is measured
 * against; left alone, the reading's own parent is the box. The briefing wants
 * the latter: its cell is rendered by `Zelle` and the value by whichever of
 * `Hero`/`Winkel`/`Punkt` sits inside it, so threading a ref between the two
 * would buy nothing over asking the DOM which element the value is actually
 * in.
 */
export function useBoxFit(
  text: string,
): { inner: RefObject<HTMLElement | null>; outer: RefObject<HTMLElement | null>; scale: number } {
  const inner = useRef<HTMLElement | null>(null);
  const outer = useRef<HTMLElement | null>(null);
  const [scale, setScale] = useState(1);
  const shape = shapeOf(text);

  useLayoutEffect(() => {
    const el = inner.current;
    const box = outer.current ?? el?.parentElement ?? null;
    if (!el || !box) return;

    const measure = () => {
      const available = box.clientWidth - 2 * POLSTER;
      // The element is drawn scaled, so its rect is not its intrinsic width.
      // scrollWidth is laid out before the transform and stays honest.
      const needed = el.scrollWidth;
      if (available <= 0 || !needed) return;
      setScale(needed > available ? available / needed : 1);
    };

    measure();

    // The cell's width changes without the value changing — the pipe counter
    // appears, a Rohrwechsel widens it. Nothing else would re-measure then.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [shape]);

  return { inner, outer, scale };
}
