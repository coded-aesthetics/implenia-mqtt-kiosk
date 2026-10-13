import { fetchImplenia, type ApiError } from './implenia-api.js';
import { getSensorMetaLookup } from './sensor-meta.js';
import { getElementSensors, setElementSensors } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('herstellen-sensors');

export interface SensorMeta {
  source?: string;   // "mqtt" | "kiosk" | "user" | "server"
  role?: string;     // e.g. "depth", "is_completed"
  priority?: string; // "hero" | "primary" | "secondary"
}

/**
 * Sensor definition as returned by the Implenia API.
 */
export interface SensorDef {
  id: string;
  name: string;
  unit?: string;
  meta?: SensorMeta | null;
}

export interface SensorDefs {
  sensors_float?: SensorDef[];
  sensors_int?: SensorDef[];
  sensors_string?: SensorDef[];
  sensors_geo?: SensorDef[];
}

/** The sensor type keys we support. */
const SENSOR_KEYS = ['sensors_float', 'sensors_int', 'sensors_string', 'sensors_geo'] as const;

/**
 * Every key the platform's sensor list can carry.
 *
 * Two more than the kiosk records: it never produces an `int_float` or a
 * `binary` value, so neither can be in a session's sensor map. But the
 * *vorgaben* side is passed straight through to the element screen, which
 * reads all six to build its unit lookup — so anything caching that response
 * has to keep them, or a Soll value quietly loses its unit.
 */
const ALL_SENSOR_KEYS = [
  ...SENSOR_KEYS, 'sensors_int_float', 'sensors_binary',
] as const;

/** A platform sensor list, with every key it may carry. */
export type AnySensorDefs = Partial<Record<(typeof ALL_SENSOR_KEYS)[number], SensorDef[]>>;

/** Sources the kiosk itself produces a value for, and must therefore upload. */
const RECORDABLE_SOURCES = new Set(['mqtt', 'kiosk', 'user']);

/**
 * Roles the kiosk writes regardless of the source the CSV names.
 *
 * `GeoDIN` (role `geology_nr`) is declared `server` in both herstellen CSVs,
 * and `sensor-meta.ts` in implenia-web documents it as "derived from
 * geology_text by server" — but nothing derives it. No implementation exists in
 * the backend or in web; the comment is aspirational. Meanwhile web's protocol
 * and export read `GeoDIN` directly as the worker-observed geology
 * (`herstellungLayersFromRows`), so the kiosk is in fact its only writer.
 *
 * Without this exception the sensor is absent from the session's sensor map,
 * every geology reading is stored with a null `sensor_id`, and none of them is
 * ever uploaded — silent, total loss of the whole feature, with the readings
 * sitting in SQLite looking fine.
 *
 * The honest fix is to change `Quelle` to `kiosk` in implenia-web's CSVs and
 * re-sync (the source of truth is always implenia-web — never edit the copies
 * in this repo). Until that lands this keeps the two versions interoperable,
 * and it stays harmless afterwards.
 */
const RECORDABLE_ROLES = new Set(['geology_nr']);

/**
 * Should this sensor be part of the recording session's sensor map?
 *
 * `user` belongs here even though nothing arrives over the wire for it: the
 * worker enters it on the touchscreen. Injektionsbohren's `Status` is the
 * case that matters — it drives every phase-segmented KPI, the protocol and
 * the "produced" check in implenia-web. Leaving `user` out meant a Status
 * reading was stored with a null sensor_id and silently never uploaded.
 *
 * `server` stays out: those values are computed by the platform after upload —
 * except where the CSV says `server` but nothing on the platform actually
 * computes it, see RECORDABLE_ROLES.
 */
export function isRecordableSensor(
  sensor: { id: string; meta?: SensorMeta | null },
  vorgabenIds: ReadonlySet<string>,
): boolean {
  if (sensor.meta?.role != null && RECORDABLE_ROLES.has(sensor.meta.role)) {
    return true;
  }
  if (sensor.meta != null && sensor.meta.source != null) {
    return RECORDABLE_SOURCES.has(sensor.meta.source);
  }
  // Legacy fallback (pre-migration devices, no meta): everything that is not
  // a vorgaben sensor.
  return !vorgabenIds.has(sensor.id);
}

/**
 * An element's sensor definitions exactly as they arrive, before the kiosk
 * decides which of them it records.
 *
 * This is what gets cached, and it is deliberately the *unfiltered* pair: the
 * element's own sensors plus which of them are Vorgabe sensors. Caching the
 * filtered result instead would freeze the decision made by the sensor CSVs
 * and `isRecordableSensor` as they stood on the day of the fetch, so a sensor
 * CSV sync or a fix to that filter would not reach anything already cached.
 */
export interface ElementSensorDefs {
  /** The element's own sensors — what a recording session is built from. */
  sensors?: SensorDefs;
  /**
   * The `vorgaben` child device's sensor list, verbatim as the platform
   * returns it. Serves the element screen's Soll units offline, and is where
   * the legacy fallback's "which of these are Vorgabe sensors" comes from.
   */
  vorgabenSensors?: AnySensorDefs;
  /**
   * Legacy: the Vorgabe sensor ids alone, with no names or units. Written by
   * an import whose file predates `vorgaben_sensors`, and still read so such
   * an import keeps working.
   */
  vorgabenIds?: string[];
}

/**
 * Merge a patch into an element's cached definitions.
 *
 * Read-modify-write rather than a plain overwrite, because the two halves
 * arrive from different places: the element's own sensors come from the
 * herstellen fetch or an import, the Vorgabe sensors from either that same
 * fetch or the element screen's own request. A plain write from one would
 * drop the other. Never throws — a cache that cannot be written costs the
 * offline path, not the request that succeeded.
 */
function mergeElementSensors(elementName: string, patch: ElementSensorDefs): void {
  try {
    const existing = (getElementSensors(elementName) ?? {}) as ElementSensorDefs;
    setElementSensors(elementName, { ...existing, ...patch });
  } catch (err) {
    log.warn('Could not cache sensors for "%s": %s', elementName, (err as Error).message);
  }
}

/**
 * Narrow the element's sensors to the ones the kiosk produces a value for.
 *
 * Also enriches each sensor from the local sensor CSVs, which carry the
 * `source`/`role`/`priority`/`unit` the platform does not always store. Note
 * the direction: the CSV only fills in what is missing. It never decides
 * whether a sensor exists — the CSVs are synced by hand from implenia-web and
 * version separately from both the platform and this kiosk, so a sensor added
 * there and not yet synced here must still end up in the sensor map. One
 * missing from the map is recorded with a null sensor id and silently never
 * uploaded, which is the worst failure this software has.
 */
export function filterHerstellenSensors(
  allDefs: SensorDefs,
  vorgabenIds: ReadonlySet<string>,
): SensorDefs {
  const csvMeta = getSensorMetaLookup();

  const result: SensorDefs = {};
  for (const key of SENSOR_KEYS) {
    const all = allDefs[key] ?? [];
    const filtered = all.filter((s) => {
      // Enrich with CSV metadata where the API doesn't provide it
      const csv = csvMeta.get(s.name);
      if (csv) {
        if (!s.meta) s.meta = {};
        if (!s.meta.source && csv.source) s.meta.source = csv.source;
        if (!s.meta.role && csv.role) s.meta.role = csv.role;
        if (!s.meta.priority && csv.priority) s.meta.priority = csv.priority;
        if (!s.unit && csv.unit) s.unit = csv.unit;
      }

      return isRecordableSensor(s, vorgabenIds);
    });
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }

  return result;
}

/**
 * Whether an element's cache already records which of its sensors are Vorgabe
 * sensors — as a list, or as the legacy bare ids.
 *
 * The distinction that matters is "known to be empty" versus "never
 * answered": a cache entry with neither subtracts nothing, which on a pillar
 * whose Soll and Ist sensors sit side by side would have the kiosk record and
 * upload the Soll values as if they were measurements.
 */
function hasVorgabenInfo(elementName: string): boolean {
  const raw = getElementSensors(elementName) as ElementSensorDefs | null;
  return raw?.vorgabenSensors != null || Array.isArray(raw?.vorgabenIds);
}

/** Every sensor id on the vorgaben device, across all sensor types. */
function collectVorgabenIds(vorgabenDefs: AnySensorDefs): Set<string> {
  const ids = new Set<string>();
  for (const key of ALL_SENSOR_KEYS) {
    for (const s of vorgabenDefs[key] ?? []) {
      ids.add(s.id);
    }
  }
  return ids;
}

/**
 * Compute herstellen (production) sensors for an element, from the API.
 *
 * Two modes, chosen per-sensor based on whether `meta` is present:
 *
 * — Meta-aware (new devices): include sensors the kiosk produces a value for
 *   (see isRecordableSensor).
 *
 * — Legacy fallback (pre-migration devices): meta is null/absent. Fall back to
 *   the original strategy: herstellen = allSensors − vorgabenSensors.
 *
 * Both modes can be active on the same element — each sensor is evaluated
 * independently based on its own meta field.
 *
 * The result is cached on the way out, so the next start for this element does
 * not need the network. See `setElementSensors`.
 */
export async function fetchHerstellenSensors(
  elementName: string,
  options?: { timeoutMs?: number },
): Promise<SensorDefs> {
  const encoded = encodeURIComponent(elementName);
  const { timeoutMs } = options ?? {};

  /*
   * Whether the answer to "which of these are Vorgabe sensors" is actually
   * known, as opposed to assumed empty because the request failed.
   *
   * A 404 is the real answer for a pillar predating the `vorgaben` child
   * device: it has none, and the legacy fallback subtracts nothing. Anything
   * else means we do not know, and caching an empty set would be worse than
   * not caching at all — on a legacy pillar it would later have the kiosk
   * record and upload the Soll values as if they were measurements.
   */
  let vorgabenKnown = true;

  // Fetch all sensors and vorgaben sensors in parallel.
  // Vorgaben fetch is always done — needed for the legacy fallback path and for
  // mixed devices where only some sensors have been migrated.
  const [allDefs, vorgabenDefs] = await Promise.all([
    fetchImplenia<SensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}?include_meta=true`,
      { timeoutMs },
    ),
    fetchImplenia<AnySensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}/child/name:vorgaben?include_meta=true`,
      { timeoutMs },
    ).catch((err: unknown) => {
      if ((err as ApiError).statusCode !== 404) vorgabenKnown = false;
      return {} as AnySensorDefs;
    }),
  ]);

  const vorgabenIds = collectVorgabenIds(vorgabenDefs);

  /*
   * The whole Vorgabe list is cached, not just its ids: the element screen
   * needs the names and units to label its Soll values, and this request has
   * them in hand.
   *
   * Nothing is cached at all while the Vorgabe answer is merely assumed — see
   * `vorgabenKnown`. The exception is an element whose Vorgabe half is already
   * on record from an earlier fetch or from the import: the merge keeps it, so
   * the entry stays safe and the element's own sensors can be refreshed.
   */
  if (vorgabenKnown) {
    mergeElementSensors(elementName, { sensors: allDefs, vorgabenSensors: vorgabenDefs });
  } else if (hasVorgabenInfo(elementName)) {
    mergeElementSensors(elementName, { sensors: allDefs });
  }

  return filterHerstellenSensors(allDefs, vorgabenIds);
}

/**
 * Herstellen sensors for an element from the local cache, or null if there are
 * none to be had.
 *
 * The offline path of `beginRecording`. Returns null rather than an empty map
 * on purpose: an element with no recordable sensors cannot be recorded in any
 * useful sense — every reading would be stored with a null sensor id and never
 * upload — so the caller reports it as missing definitions instead of starting
 * a session that looks healthy and keeps nothing.
 */
export function cachedHerstellenSensors(elementName: string): SensorDefs | null {
  const raw = getElementSensors(elementName) as ElementSensorDefs | null;
  if (!raw || typeof raw !== 'object' || !raw.sensors || typeof raw.sensors !== 'object') {
    return null;
  }

  // Derived from the cached list where there is one, so a fix to
  // collectVorgabenIds reaches everything already cached. `vorgabenIds` is the
  // legacy shape, and an import whose file carries no Vorgabe sensors at all.
  const vorgabenIds = raw.vorgabenSensors
    ? collectVorgabenIds(raw.vorgabenSensors)
    : new Set(Array.isArray(raw.vorgabenIds) ? raw.vorgabenIds : []);

  const filtered = filterHerstellenSensors(raw.sensors, vorgabenIds);
  return SENSOR_KEYS.some((key) => (filtered[key]?.length ?? 0) > 0) ? filtered : null;
}

/**
 * The cached `vorgaben` sensor list for an element, or null if none was seen.
 *
 * Returned verbatim, the way the element screen expects the platform's
 * response — unlike the herstellen side there is nothing to filter: every
 * Vorgabe sensor is one the screen may need to label.
 */
export function cachedVorgabenSensors(elementName: string): AnySensorDefs | null {
  const raw = getElementSensors(elementName) as ElementSensorDefs | null;
  const vorgaben = raw?.vorgabenSensors;
  if (!vorgaben || typeof vorgaben !== 'object') return null;
  return ALL_SENSOR_KEYS.some((key) => (vorgaben[key]?.length ?? 0) > 0) ? vorgaben : null;
}

/**
 * Starting a recording, or opening an element screen, found no sensor
 * definitions for the element — not from the platform, and not in the local
 * cache.
 *
 * Its own type because it is the one failure here that is neither a conflict
 * nor a bug, and callers answer it differently from a real error: a 503, and a
 * message naming the one thing that fixes it.
 */
export class SensorDefsUnavailableError extends Error {
  constructor(public readonly elementName: string) {
    /*
     * Three sentences, in the order the operator needs them: what is missing,
     * why, and the one thing that fixes it. „Schichtauftrag importieren" is
     * the exact label of the button on the element list, so the instruction
     * names something they can see rather than something they have to find.
     */
    super(
      `Für „${elementName}" fehlen die Sensordefinitionen. `
      + 'Die Implenia-Plattform ist nicht erreichbar und dieses Element wurde hier '
      + 'noch nie aufgezeichnet. Bitte den Schichtauftrag im Portal neu exportieren '
      + 'und über „Schichtauftrag importieren" einlesen — oder warten, bis die '
      + 'Verbindung wieder steht.',
    );
    this.name = 'SensorDefsUnavailableError';
  }
}

/**
 * How long a request a worker is waiting behind may wait on the platform.
 *
 * Both callers are in front of somebody: the Start button is disabled while
 * the start resolves, and the element screens have no sensor list until theirs
 * does. So this bounds how long nothing happens — not how long the request is
 * allowed to succeed in. Generous enough for a slow mobile link, short enough
 * not to read as a frozen kiosk, and irrelevant once the element is cached,
 * which after the first resolution it always is.
 */
export const SENSOR_RESOLVE_TIMEOUT_MS = 8000;

/**
 * An element's herstellen sensors, from the platform when it answers and from
 * the local cache when it does not.
 *
 * The platform comes first even when it is probably unreachable: it is
 * authoritative, and a successful fetch refreshes the cache. But it must not
 * be *required*. Resolving sensor ids used to be the only part of starting a
 * recording that touched the network, which made the single most important
 * action on a construction site depend on the thing least likely to work
 * there — a site with an imported Schichtauftrag could list its elements and
 * then neither record one nor see its sensors.
 *
 * The cache is filled by every successful fetch and by the imported
 * Schichtauftrag, which carries each element's sensors with their platform
 * ids — so the ids are always real and a session started offline uploads
 * normally once the link comes back. Nothing here invents one: a reading
 * stored without a real sensor id would never upload and nothing on screen
 * would say so.
 *
 * @throws SensorDefsUnavailableError when there is nothing to be had.
 */
export async function resolveHerstellenSensors(elementName: string): Promise<SensorDefs> {
  try {
    return await fetchHerstellenSensors(elementName, {
      timeoutMs: SENSOR_RESOLVE_TIMEOUT_MS,
    });
  } catch (err) {
    const cached = cachedHerstellenSensors(elementName);
    if (cached) {
      log.warn(
        'Platform unreachable for "%s" (%s) — using the cached sensor definitions',
        elementName, (err as Error).message,
      );
      return cached;
    }
    log.error(
      'No sensor definitions for "%s", neither from the platform (%s) nor cached',
      elementName, (err as Error).message,
    );
    throw new SensorDefsUnavailableError(elementName);
  }
}

/**
 * An element's `vorgaben` sensor list, from the platform when it answers and
 * from the local cache when it does not.
 *
 * The element screen reads this for the names and units of the Soll values it
 * draws. Before it was cached, the request failed offline and
 * `useVorgabenSensors` swallowed that into an empty list — so every Soll value
 * on the screen lost its unit, on exactly the sites that work from an import.
 *
 * `include_meta=true` where the old request had no query at all: it costs
 * nothing, matches the herstellen fetch, and makes a cache written from here
 * as good as one written from there. The extra field is additive for the
 * screen, which already types `meta` as optional.
 *
 * @throws SensorDefsUnavailableError when there is nothing to be had.
 */
export async function resolveVorgabenSensors(elementName: string): Promise<AnySensorDefs> {
  const encoded = encodeURIComponent(elementName);
  try {
    const data = await fetchImplenia<AnySensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}/child/name:vorgaben?include_meta=true`,
      { timeoutMs: SENSOR_RESOLVE_TIMEOUT_MS },
    );
    mergeElementSensors(elementName, { vorgabenSensors: data });
    return data;
  } catch (err) {
    const cached = cachedVorgabenSensors(elementName);
    if (cached) {
      log.warn(
        'Platform unreachable for "%s" vorgaben sensors (%s) — using the cache',
        elementName, (err as Error).message,
      );
      return cached;
    }
    /*
     * A 404 is a real answer: a pillar predating the `vorgaben` child device
     * has none. Answering "no sensor definitions, re-import the
     * Schichtauftrag" for that would send the operator after a file that
     * cannot help. An empty list is what the screen already handles.
     */
    if ((err as ApiError).statusCode === 404) return {};
    log.error(
      'No vorgaben sensor definitions for "%s" (%s) and none cached',
      elementName, (err as Error).message,
    );
    throw new SensorDefsUnavailableError(elementName);
  }
}

/**
 * Cache the sensor definitions an imported Schichtauftrag carries.
 *
 * The file is produced by implenia-web's shift assignment export, which
 * includes each element's sensors with their platform ids for exactly this
 * reason — it is the only way a site that has never been online can start a
 * recording whose data is uploadable afterwards. Returns how many elements it
 * cached, which is 0 for a file exported before that field existed.
 *
 * Lenient throughout: a file is worth whatever can be read out of it, and an
 * element that cannot be is simply not cached, which the start route then
 * reports in terms the operator can act on.
 */
export function cacheImportedSensors(devices: unknown): number {
  if (!Array.isArray(devices)) return 0;

  let cached = 0;
  for (const device of devices) {
    const d = device as {
      name?: unknown; sensors?: unknown;
      vorgaben_sensors?: unknown; vorgaben_sensor_ids?: unknown;
    };
    if (typeof d?.name !== 'string' || !d.name) continue;
    if (!d.sensors || typeof d.sensors !== 'object') continue;

    const patch: ElementSensorDefs = { sensors: d.sensors as SensorDefs };

    if (d.vorgaben_sensors && typeof d.vorgaben_sensors === 'object') {
      // Carries the names and units too, so the element screen can label its
      // Soll values offline — and the Vorgabe ids come out of it.
      patch.vorgabenSensors = d.vorgaben_sensors as AnySensorDefs;
    } else if (Array.isArray(d.vorgaben_sensor_ids)) {
      patch.vorgabenIds = d.vorgaben_sensor_ids
        .filter((id): id is string => typeof id === 'string');
    }

    mergeElementSensors(d.name, patch);
    cached++;
  }
  return cached;
}
