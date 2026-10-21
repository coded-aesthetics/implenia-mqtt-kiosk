import { useSyncExternalStore } from 'react';

export interface Route {
  page: 'home' | 'config' | 'element' | 'bohren' | 'comments' | 'setup' | 'sensors' | 'datenstrom' | 'rohrverlaengerung' | 'geologie' | 'ausrichten';
  params: Record<string, string>;
  query: Record<string, string>;
}

/**
 * Percent-decode a path parameter without being able to take the app down.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape — and a literal
 * `%` is one, which an MQTT topic or an element name may well contain. This
 * function runs inside `getSnapshot()`, so a throw here does not fail a route:
 * it blanks the whole screen, on a machine with no keyboard to reload from.
 * An undecoded parameter is wrong in a way somebody can read and work around.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Pure so it can be tested: the wizard's step now lives in the URL, which
 * makes this parser load-bearing for whether someone can finish setup.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?', 2);
  const query: Record<string, string> = {};
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=', 2);
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
  }

  const configMatch = path.match(/^config(?:\/(.+))?$/);
  if (configMatch) {
    return { page: 'config', params: configMatch[1] ? { section: configMatch[1] } : {}, query };
  }

  if (path === 'comments') {
    return { page: 'comments', params: {}, query };
  }

  // Sensor assignment gets its own screen: it is a focused, two-step task that
  // needs the whole display, not a card inside the settings page.
  if (path === 'sensors') {
    return { page: 'sensors', params: {}, query };
  }

  /**
   * The data stream: every topic the box is sending, and one channel's detail.
   *
   * The topic is in the path rather than in component state so that a reload —
   * or the page reload a PM2 restart causes — leaves the technician on the
   * channel they were looking at, the same reasoning as the `geologie` route.
   * Topics contain `/`, so the parameter is percent-encoded by the caller and
   * matched here with `(.+)`.
   */
  const datenstromMatch = path.match(/^datenstrom(?:\/(.+))?$/);
  if (datenstromMatch) {
    return {
      page: 'datenstrom',
      params: datenstromMatch[1] ? { topic: safeDecode(datenstromMatch[1]) } : {},
      query,
    };
  }

  // Where the Kalibrierung screen used to be. Kept as an alias because the
  // kiosk reloads itself on an update: a technician parked here across one
  // would otherwise land on the element list with no way back and no F5 key.
  if (path === 'kalibrierung') {
    return { page: 'datenstrom', params: {}, query };
  }

  if (path === 'rohrverlaengerung') {
    return { page: 'rohrverlaengerung', params: {}, query };
  }

  // The geology sign-off before a stop. A route rather than an overlay so a
  // remount — or a PM2 restart that reloads the page — leaves the operator
  // where they were instead of silently dropping the confirmation.
  const geologieMatch = path.match(/^geologie(?:\/(.+))?$/);
  if (geologieMatch) {
    return {
      page: 'geologie',
      params: geologieMatch[1] ? { name: safeDecode(geologieMatch[1]) } : {},
      query,
    };
  }

  // The setup wizard is a route, not a conditional overlay. Its step lives in
  // the URL so that a remount cannot silently send the technician back to the
  // first screen, and so each step can be opened directly.
  const setupMatch = path.match(/^setup(?:\/(.+))?$/);
  if (setupMatch) {
    return { page: 'setup', params: { step: setupMatch[1] ?? 'verfahren' }, query };
  }

  /**
   * Aiming the rig, the step before drilling.
   *
   * The element is in the path and not optional: this screen is opened before
   * a recording exists, so there is no session to fall back on for the name —
   * and without the name there is no Vorgabe to align to. A bare `ausrichten`
   * is therefore not a route at all rather than a screen with two empty dials.
   */
  const ausrichtenMatch = path.match(/^ausrichten\/(.+)$/);
  if (ausrichtenMatch) {
    return { page: 'ausrichten', params: { name: safeDecode(ausrichtenMatch[1]) }, query };
  }

  /**
   * The element's own screen, under two names.
   *
   * They render the same thing, and the difference is one of intent:
   * `element/<name>` means "open this element" and is what the element list,
   * the voice navigation and a resumed pillar use — App may send it on to
   * `ausrichten/<name>` when the element has to be aimed first.
   * `bohren/<name>` means the drilling screen, directly, and is never
   * redirected: it is where the alignment screen's own slot leads, where the
   * geology sign-off returns to, and what a spoken "herstellen" opens.
   *
   * Carrying that in the URL rather than in a "has been aligned" flag is what
   * makes it survive a reload and a PM2 restart — same reasoning as
   * `?beenden=1` on the geology route.
   */
  const bohrenMatch = path.match(/^bohren\/(.+)$/);
  if (bohrenMatch) {
    return { page: 'bohren', params: { name: safeDecode(bohrenMatch[1]) }, query };
  }

  const elementMatch = path.match(/^element\/(.+)$/);
  if (elementMatch) {
    return { page: 'element', params: { name: safeDecode(elementMatch[1]) }, query };
  }

  return { page: 'home', params: {}, query };
}

function parseHash(): Route {
  return parseRoute(window.location.hash);
}

// Resolved lazily rather than at import: touching `window` at module load
// makes the module unimportable outside a browser, including from tests.
let currentRoute: Route | null = null;

function subscribe(callback: () => void): () => void {
  const handler = () => {
    currentRoute = parseHash();
    callback();
  };
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

function getSnapshot(): Route {
  if (currentRoute === null) currentRoute = parseHash();
  return currentRoute;
}

export function useHashRouter(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(path: string): void {
  window.location.hash = '#/' + path.replace(/^\//, '');
}
