import { config } from './config.js';
import { getMeta } from './db.js';

export interface ApiError extends Error {
  statusCode: number;
}

export interface ApiConfig {
  apiUrl: string;
  apiKey: string;
}

/**
 * Resolves API configuration: meta table (runtime config) takes precedence over env vars.
 */
export function getApiConfig(): ApiConfig | null {
  const apiKey = getMeta('implenia_api_key') ?? config.IMPLENIA_API_KEY;
  const apiUrl = getMeta('implenia_api_url') ?? config.IMPLENIA_API_URL;

  if (!apiKey || !apiUrl) return null;
  return { apiUrl, apiKey };
}

/**
 * Fetch wrapper that adds Implenia Bearer auth.
 * Returns the parsed JSON response or throws on error.
 */
export async function fetchImplenia<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const cfg = getApiConfig();
  if (!cfg) throw new Error('Implenia API not configured');

  const url = cfg.apiUrl.replace(/\/+$/, '') + path;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: 'application/json',
  };

  const init: RequestInit = {
    method: options?.method ?? 'GET',
    headers,
  };

  if (options?.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Implenia API ${res.status}: ${text}`);
    (err as ApiError).statusCode = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}
