import { useSyncExternalStore } from 'react';

export interface Route {
  page: 'home' | 'config' | 'element';
  params: Record<string, string>;
  query: Record<string, string>;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
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

  const elementMatch = path.match(/^element\/(.+)$/);
  if (elementMatch) {
    return { page: 'element', params: { name: decodeURIComponent(elementMatch[1]) }, query };
  }

  return { page: 'home', params: {}, query };
}

let currentRoute = parseHash();

function subscribe(callback: () => void): () => void {
  const handler = () => {
    currentRoute = parseHash();
    callback();
  };
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

function getSnapshot(): Route {
  return currentRoute;
}

export function useHashRouter(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(path: string): void {
  window.location.hash = '#/' + path.replace(/^\//, '');
}
