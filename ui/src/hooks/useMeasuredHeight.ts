import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The live pixel height of an element, for components that must size a child in
 * JavaScript — the DIN 4023 profile takes its height as a prop rather than from
 * CSS.
 *
 * A **callback ref**, deliberately, rather than the usual `useRef` plus
 * `useEffect(…, [])` that observes `ref.current`. That pattern is quietly wrong
 * for any element that renders conditionally, and it was wrong in three places
 * here:
 *
 * - The effect runs **once**, on the component's mount. If the element is not in
 *   the DOM yet — the drilling screen's profile waits for the Vorgaben to
 *   arrive, the sign-off screen's chart waits for its fetch — the effect finds
 *   `ref.current` null, returns, and never runs again. Nothing is ever
 *   measured.
 * - When the element unmounts and comes back — picking a ground type swaps the
 *   profile column for the picker and back — the observer is still watching the
 *   **detached** node. It never fires again, and the height sticks at whatever
 *   it last was, or at the component's fallback.
 *
 * Both failures look identical on screen: the chart renders at its hardcoded
 * fallback height instead of filling its column, with no error anywhere.
 *
 * A callback ref is called with the node on every attach and with `null` on
 * every detach, so the observer follows the element rather than the component.
 *
 * The height is deliberately **not** reset on detach: re-observing fires with
 * the real size immediately, and keeping the last value avoids a visible flash
 * of the fallback in between.
 */
export function useMeasuredHeight(): [(node: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const ro = new ResizeObserver(([entry]) => {
      setHeight(Math.floor(entry.contentRect.height));
    });
    ro.observe(node);
    observer.current = ro;
  }, []);

  // The callback ref is called with null on unmount, which already disconnects.
  // This covers the case where React drops the component without that call.
  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, height];
}
