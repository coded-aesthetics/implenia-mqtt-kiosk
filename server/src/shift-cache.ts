import { healthFromOutcome } from './api-health.js';

/**
 * The last shift assignment the platform served, kept so a kiosk whose
 * backend is down still knows what it was working on.
 *
 * The Vorgaben have been cached per element since `element_vorgaben` went in,
 * and an imported file has always survived a restart — but a *fetched* shift
 * assignment was held in nothing at all. A kiosk that listed its elements
 * yesterday and met an unreachable backend this morning showed
 * „Verbindungsproblem" and an import button: the element list, the one screen
 * a worker starts from, was gone, for a list the kiosk had successfully read
 * fifteen hours earlier. Degrading to the last known state is the rule this
 * software is built on and this screen was the exception.
 *
 * Stored verbatim, devices and their `vorgaben` together, because that is what
 * the element screen reads: a cached list whose Soll values had been stripped
 * would open elements with no geology profile and no targets.
 *
 * The *base* name: the stored key carries the site id (`siteMetaKey`), because
 * this is one site's element list and a bridge's piers each have their own key
 * and their own `P-01`. See site.ts.
 */
export const SHIFT_CACHE_KEY = 'last_shift_assignment';

export interface ShiftCacheEntry {
  /** When the platform served this list. */
  fetchedAt: number;
  measuring_devices: Record<string, unknown>[];
}

/** An element this kiosk has uploaded, as `getCompletedElements` reports it. */
export interface CompletedElementRef {
  elementName: string;
  lastUpload: number;
}

export function serialiseShiftCache(devices: unknown, now: number): string | null {
  if (!Array.isArray(devices)) return null;
  const entry: ShiftCacheEntry = {
    fetchedAt: now,
    measuring_devices: devices as Record<string, unknown>[],
  };
  return JSON.stringify(entry);
}

export function parseShiftCache(raw: string | undefined): ShiftCacheEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ShiftCacheEntry>;
    if (!Array.isArray(parsed.measuring_devices)) return null;
    if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) return null;
    return { fetchedAt: parsed.fetchedAt, measuring_devices: parsed.measuring_devices };
  } catch {
    // An unreadable cache is the same as no cache: the element list falls back
    // to the connection error it would have shown anyway.
    return null;
  }
}

/**
 * Whether this failure is one the cache should answer.
 *
 * The same distinction the rest of this kiosk makes between "the platform said
 * no" and "the platform said nothing" — a 404 means *there is no shift
 * assignment for today*, which is an answer, and showing yesterday's list
 * instead of „Kein Schichtauftrag für heute" would be inventing work. A 401
 * means the key is wrong and a technician has to fix it; serving a list over
 * the top of that hides the one message that leads anywhere. Only
 * `unreachable` — no answer at all, or a 5xx — is the case the cache exists
 * for, and that classification lives in exactly one place.
 */
export function cacheServesFailure(err: unknown): boolean {
  return healthFromOutcome(err) === 'unreachable';
}

/**
 * Drop elements this kiosk finished after the cache was taken.
 *
 * The platform's list is "unfinished elements", so it is only true as of
 * `fetchedAt`. An element the kiosk uploaded since then is complete — the
 * upload wrote its `Ausführungsdatum`, so the platform would no longer list it
 * — and the kiosk knows this without asking anybody. Left in, a pillar
 * finished yesterday evening sits in the grid this morning looking like work
 * to do, which is how an element gets drilled twice.
 *
 * They are not hidden: the element list's „Abgeschlossene Elemente" row is built
 * from the same local completions, so a dropped element appears there with its
 * date and can still be resumed.
 */
export function pruneCompleted(
  entry: ShiftCacheEntry,
  completed: CompletedElementRef[],
): Record<string, unknown>[] {
  const finishedSince = new Set(
    completed.filter((c) => c.lastUpload > entry.fetchedAt).map((c) => c.elementName),
  );
  if (finishedSince.size === 0) return entry.measuring_devices;
  return entry.measuring_devices.filter((d) => {
    const name = (d as { name?: unknown }).name;
    return typeof name !== 'string' || !finishedSince.has(name);
  });
}
