import { config } from './config.js';
import { getMeta } from './db.js';
import { apiHealth } from './api-health.js';

export interface ApiError extends Error {
  statusCode: number;
  /**
   * The response body, verbatim.
   *
   * The CSV batch endpoint answers a refusal with the *same* JSON result as a
   * success, and whether that refusal is worth retrying is only visible in it —
   * a name it could not match is permanent, a value it failed to insert is its
   * own database having a bad minute. The status alone cannot tell them apart.
   */
  body?: string;
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
 *
 * `timeoutMs` is opt-in, and belongs only on a request a worker is waiting
 * behind. A TCP connection to a host that is reachable but not answering — the
 * normal shape of a bad mobile link on site — hangs for as long as the kernel
 * lets it, so an unbounded request on such a path is an indefinite spinner.
 * Uploads deliberately do not set it: they run in the background, their
 * batches are large, and giving up early would only mean retrying later.
 */
export async function fetchImplenia<T = unknown>(
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    /**
     * A body to send verbatim, with `contentType`, instead of JSON. The CSV
     * batch endpoint reads the raw request body as a file, so it cannot be
     * handed a JSON envelope.
     */
    rawBody?: string;
    contentType?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const cfg = getApiConfig();
  if (!cfg) {
    const err = new Error('Implenia API not configured');
    apiHealth.noteOutcome(err);
    throw err;
  }

  const url = cfg.apiUrl.replace(/\/+$/, '') + path;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: 'application/json',
  };

  const init: RequestInit = {
    method: options?.method ?? 'GET',
    headers,
  };

  if (options?.rawBody !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'text/plain; charset=utf-8';
    init.body = options.rawBody;
  } else if (options?.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  if (options?.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(options.timeoutMs);
  }

  /*
   * Every outcome is reported to `apiHealth`, including the failures each
   * caller handles itself. That is what the header's indicator is built on:
   * the question "is the platform answering" is already being asked a hundred
   * times a shift, and an answer nobody collected is what let the kiosk show
   * „Verbunden" while every upload was failing.
   */
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    apiHealth.noteOutcome(err);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Implenia API ${res.status}: ${text}`);
    (err as ApiError).statusCode = res.status;
    (err as ApiError).body = text;
    apiHealth.noteOutcome(err);
    throw err;
  }

  apiHealth.noteOutcome();
  return res.json() as Promise<T>;
}
