import { useEffect, useRef } from 'react';

interface PollOptions {
  /**
   * Fetch once immediately as well as on the interval. Default true.
   *
   * Screens that already load the endpoint themselves on mount pass false, so
   * the first poll does not race that load.
   */
  immediate?: boolean;
  /** Called when the request fails or the response is not ok. */
  onError?: () => void;
}

/**
 * Poll a JSON endpoint on an interval for as long as the component is mounted.
 *
 * Config screens show values that have to move while the machine moves — a
 * clamp opening, a topic arriving, a sensor drifting — and every one of them
 * had written the same effect by hand: a `cancelled` flag, an immediate call,
 * a setInterval, and a teardown that cleared both.
 *
 * Passing `null` as the url disables polling. That covers the "only while this
 * step is open" case without making the call conditional, which the rules of
 * hooks do not allow.
 *
 * A response arriving after teardown is dropped. Without that, leaving a
 * screen mid-request writes state into an unmounted component — and on a site
 * with a bad uplink those late responses are not rare. One of the five
 * hand-written copies was missing this guard.
 *
 * Failures are silent unless `onError` says otherwise: a kiosk that loses the
 * server has to keep showing the last values it had, not blank the screen.
 */
export function usePolledJson<T>(
  url: string | null,
  intervalMs: number,
  onData: (data: T) => void,
  options: PollOptions = {},
): void {
  const { immediate = true, onError } = options;

  // Kept in refs so an inline callback does not restart the interval on every
  // render — callers should not have to memoise to poll at a steady rate.
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onDataRef.current = onData;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const poll = () => {
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: T | null) => {
          if (cancelled) return;
          if (d === null) onErrorRef.current?.();
          else onDataRef.current(d);
        })
        .catch(() => {
          if (!cancelled) onErrorRef.current?.();
        });
    };

    if (immediate) poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, intervalMs, immediate]);
}
