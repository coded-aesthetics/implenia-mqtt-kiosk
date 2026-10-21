import { useEffect, useState } from 'react';

/**
 * The wall-clock time, `HH:mm` in `de-DE`, re-rendered once a minute.
 *
 * **No seconds**, deliberately. A seconds display is a repaint every second on
 * the kiosk's Celeron for information nobody on a construction site needs, and
 * it makes the header's width wobble as the digits change. The caller renders
 * it with `tabular-nums` so even the minute change cannot move anything beside
 * it.
 *
 * It is the *browser's* clock, which on a kiosk is the same machine clock the
 * server stamps readings with. That is a feature: a kiosk whose NTP never ran
 * uploads wrong timestamps with no symptom anybody on site can see, and a
 * visibly wrong header clock is that symptom.
 */
export function useUhrzeit(): string {
  const [zeit, setZeit] = useState(() => formatiereUhrzeit(new Date()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const jetzt = new Date();
      setZeit(formatiereUhrzeit(jetzt));
      timer = setTimeout(tick, msBisZurNaechstenMinute(jetzt));
    };

    tick();
    return () => clearTimeout(timer);
  }, []);

  return zeit;
}

/** The displayed time: `HH:mm`, 24 hours, German locale. */
export function formatiereUhrzeit(d: Date): string {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * How long until the displayed minute changes.
 *
 * The tick re-aligns to the minute boundary after every update rather than
 * running on a fixed 60 s interval. A plain interval starts wherever the
 * component happened to mount and drifts further with every timer the browser
 * delays — a kiosk runs for weeks without a reload — so the displayed minute
 * would flip at an arbitrary offset and could sit most of a minute behind the
 * real one.
 *
 * Floored at 250 ms: a timer that fires a hair *early* would otherwise compute
 * a delay of ~0 and spin through renders until the clock caught up.
 */
export function msBisZurNaechstenMinute(d: Date): number {
  const verstrichen = d.getSeconds() * 1000 + d.getMilliseconds();
  return Math.max(60_000 - verstrichen, 250);
}
