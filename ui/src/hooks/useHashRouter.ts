import { useSyncExternalStore } from 'react';

export interface Route {
  page: 'home' | 'config' | 'element' | 'comments' | 'setup' | 'sensors';
  params: Record<string, string>;
  query: Record<string, string>;
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

  if (path === 'config') {
    return { page: 'config', params: {}, query };
  }

  if (path === 'comments') {
    return { page: 'comments', params: {}, query };
  }

  // Sensor assignment gets its own screen: it is a focused, two-step task that
  // needs the whole display, not a card inside the settings page.
  if (path === 'sensors') {
    return { page: 'sensors', params: {}, query };
  }

  // The setup wizard is a route, not a conditional overlay. Its step lives in
  // the URL so that a remount cannot silently send the technician back to the
  // first screen, and so each step can be opened directly.
  const setupMatch = path.match(/^setup(?:\/(.+))?$/);
  if (setupMatch) {
    return { page: 'setup', params: { step: setupMatch[1] ?? 'verfahren' }, query };
  }

  const elementMatch = path.match(/^element\/(.+)$/);
  if (elementMatch) {
    return { page: 'element', params: { name: decodeURIComponent(elementMatch[1]) }, query };
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
