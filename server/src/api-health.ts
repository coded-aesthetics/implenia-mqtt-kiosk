import { EventEmitter } from 'node:events';

/**
 * Whether the Implenia platform is usable, as opposed to whether the kiosk has
 * internet.
 *
 * These are two different questions and the header used to answer only the
 * first one: `CONNECTIVITY_PROBE_HOST` is a DNS lookup against 8.8.8.8, so a
 * kiosk whose API backend was down, misconfigured or refusing its key still
 * read **„Verbunden"** in green while nothing could upload and the element list
 * sat on „Verbindungsproblem". On a site that is the one state nobody can
 * diagnose from the screen — the indicator was actively lying about the thing
 * it exists to report.
 *
 * - `unknown` — not observed yet. Says nothing; the indicator falls back to
 *   the internet state rather than claiming either answer.
 * - `ok` — the platform answered. Any HTTP status that is not an auth refusal
 *   or a server error counts, including a 404: „no shift assignment for today"
 *   is a *working* backend saying so.
 * - `unreachable` — no answer at all (DNS, connection refused, timeout) or a
 *   5xx. Both mean "not now, try later", and both buffer.
 * - `rejected` — 401/403. The platform is up and will not talk to this kiosk,
 *   which needs a key, not patience.
 * - `unconfigured` — no API URL or key on this machine. Also says nothing
 *   about the platform, so it degrades like `unknown`.
 */
export type ApiHealth = 'unknown' | 'ok' | 'unreachable' | 'rejected' | 'unconfigured';

/**
 * Classify one `fetchImplenia` outcome. `undefined` is a success.
 *
 * Pure, and the only place the mapping lives — the probe and the dozen real
 * API calls that report through `noteApiOutcome` must agree, or the indicator
 * would flicker between two answers depending on which fired last.
 */
export function healthFromOutcome(err: unknown): ApiHealth {
  if (err === undefined || err === null) return 'ok';

  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'rejected';
    if (status >= 500) return 'unreachable';
    // 404, 409, 422, … — the backend is alive and has an opinion.
    return 'ok';
  }

  // Thrown before any request goes out, by fetchImplenia itself.
  if (err instanceof Error && err.message === 'Implenia API not configured') {
    return 'unconfigured';
  }

  // fetch failed, ENOTFOUND, ECONNREFUSED, AbortError — no answer.
  return 'unreachable';
}

class ApiHealthTracker extends EventEmitter {
  private state: ApiHealth = 'unknown';
  private observedAt = 0;

  getState(): ApiHealth {
    return this.state;
  }

  /** How long ago the platform last told us anything, in ms. */
  ageMs(): number {
    return this.observedAt === 0 ? Infinity : Date.now() - this.observedAt;
  }

  /**
   * Record what the platform just did.
   *
   * Called from `fetchImplenia` on every request, which is what makes the
   * active probe nearly free: during a shift the uploads, the element screens
   * and the shift-assignment refetches answer the question continuously, and
   * the probe only fires on a kiosk nobody is using.
   */
  noteOutcome(err?: unknown): void {
    this.set(healthFromOutcome(err));
  }

  set(next: ApiHealth): void {
    this.observedAt = Date.now();
    if (next === this.state) return;
    this.state = next;
    this.emit('change', next);
  }

  /** Test seam: forget what was observed. */
  reset(): void {
    this.state = 'unknown';
    this.observedAt = 0;
  }
}

export const apiHealth = new ApiHealthTracker();
