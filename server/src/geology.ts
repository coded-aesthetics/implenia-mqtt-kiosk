/**
 * Worker-observed geology — the write side of the `Geologieprofil` contract
 * shared with implenia-web.
 *
 * A committed profile is **one JSON value** in a `Geologieprofil` string
 * sensor (CSV role `geology_profile`), dated at the sentinel
 * `2000-01-01T00:00:00Z`:
 *
 *     {"end":12.4,"layers":[{"t":0.0,"nr":12,"name":"Steine"},
 *                           {"t":2.0,"nr":60,"name":"Hindernis Beton","q":"vorgabe"}]}
 *
 * Inserts upsert on `(sensor_id, date)`, so the profile is one overwritable
 * slot: a re-commit replaces rather than appends, and nothing accumulates.
 * Same sentinel, and the same reasoning, as `Ausführungsdatum`.
 *
 * **Why it is not a time series any more.** It used to be uploaded as a
 * `GeoDIN` integer series plus a `Geologie` text series, and implenia-web
 * turned that back into layers by change detection — each new code starting a
 * layer at the depth of *the same reading*, matched on millisecond equality.
 * A `GeoDIN` reading carried no depth, so the timestamp was the entire depth
 * mechanism: a reading dated one sample out produced no layer at all, and the
 * profile uploaded cleanly, appeared in raw charts, and showed zero observed
 * layers in the protocol. Five mechanisms existed only to protect that one
 * borrowed integer, and one of them had already been cut by a compression
 * change that guarded `GeoDIN` from the grid while thinning the depth series
 * it pointed at.
 *
 * That join was never designed. The third-party software that wrote every
 * `GeoDIN` row on the platform grew out of a CSV upload, where one row carries
 * one timestamp and every column on it, so the alignment came for free. It only
 * became load-bearing when a writer had to date a geology reading on its own.
 *
 * Four properties of the write survive from that contract, for their own
 * reasons rather than by inheritance:
 *
 * 1. **An obstruction is not a separate concept.** DIN 4023 numbers 59–64
 *    (`Hindernis Stahl/Beton/Holz/Sonstiges`, `Hohlräume`, `Findling`) live in
 *    the same number space as soils and rocks, so an obstruction is a thin
 *    layer and entering and leaving it are two ordinary layers.
 * 2. **Every committed profile is complete, and says which parts were
 *    observed.** Partial geology is not representable — a single code asserts
 *    the ground runs to the bottom of the hole — so back-filling the
 *    unconfirmed stretches from the Schichtauftrag is the only option that
 *    neither discards what the operator saw nor invents a boundary they
 *    rejected. Provenance is the per-layer `q` field now, not a ` (Vorgabe)`
 *    suffix smuggled through display text, which is also what lets anything
 *    aggregating "ground types actually encountered" exclude the back-fill
 *    instead of string-matching for it.
 * 3. **A layer carries its *start* depth.** `mergeProfile` extends the
 *    shallowest layer up to 0 unless it is an obstruction — asserting the drill
 *    met concrete from the surface is a claim nobody made — so a profile
 *    legitimately begins below 0 with the stretch above making no claim. End
 *    depths per layer cannot express that.
 * 4. **`end` is written, not derived.** `profileEndTiefe` can land deeper than
 *    any recorded reading when the hole stopped short of the plan, so a reader
 *    recomputing it from the depth series would get a different number.
 *
 * Live entries go to `session_geology`, as depths. See the "Worker-observed
 * geology" section in CLAUDE.md before changing any of this.
 */

import { findByNr } from '@coded-aesthetics/din4023';
import {
  countSessionSensorReadings,
  deletePendingSensorReadings,
  inTransaction,
  getElementVorgaben,
  getSessionDepthSamples,
  getSessionGeology,
  getElementSensorTextSeries,
  getSessionSensorTextSeries,
  insertSessionGeology,
  insertSessionReading,
  maxDrilledValue,
  type Session,
} from './db.js';
import { drilledDepth, type DepthSample } from './depth-timestamp.js';
import { createLogger } from './logger.js';
import { parseSensorMap, sensorNameByRole } from './recording.js';
import { mergeProfile, profileEndTiefe, type MergedProfile } from './geology-profile.js';
import { parseVorgabeGeology, type VorgabeProfile } from './vorgabe-geology.js';

const log = createLogger('geology');

/**
 * The instant a committed profile is stored at.
 *
 * A fixed date makes the profile a single overwritable slot per element rather
 * than a time series: inserts upsert on `(sensor_id, date)`, so a re-commit
 * replaces the previous profile and clearing one is possible. The same
 * sentinel implenia-web uses for materialized per-element values.
 */
export const PROFILE_SENTINEL_AT = Date.UTC(2000, 0, 1);

/**
 * How far the hole must have moved for the session to count as having drilled.
 *
 * Below this there is no profile worth confirming, and asking anyway would be
 * the kind of nagging this feature exists to avoid. Grouting-only and
 * stood-still sessions stop exactly as they always have.
 */
export const MIN_DRILL_SPAN_M = 0.5;

/**
 * Depth tolerance, in metres — far below the 0.1 m grid the editor snaps to.
 *
 * Comparing a snapped depth against a raw reading is float arithmetic either
 * way, and the only comparison that matters here decides whether a layer is
 * kept or dropped.
 */
const TIEFE_EPS = 1e-6;

/** Where a boundary came from. */
export type Quelle = 'ist' | 'vorgabe';

/** One layer of a profile as the UI commits it. */
export interface GeologyLayerInput {
  /** Depth the layer starts at, in metres. */
  tiefe: number;
  /** DIN 4023 `GeologieEintrag.nr`. */
  nr: number;
  /**
   * Overrides the DIN name in the layer's `name` field.
   *
   * Only for a layer the operator described themselves. Left out, the name
   * comes from the DIN tables here, so a profile reads the same however the
   * recording was stopped — and a client cannot label a layer as something it
   * is not. `nr` stays authoritative either way; `name` is a label.
   */
  name?: string;
  /** Observed during production, or carried over from the Schichtauftrag. */
  quelle?: Quelle;
}

/** One layer as it goes on the wire. */
interface WireLayer {
  t: number;
  nr: number;
  name?: string;
  q?: 'vorgabe';
}

/**
 * The human-readable label for a ground type.
 *
 * From the DIN 4023 tables the din4023 package owns, rather than a copy kept
 * here: the numbers and names are generated data belonging to that repo, and a
 * second copy would be wrong the first time a table changed. Only the root
 * entry of the package is used, which carries the tables and no React.
 *
 * It is carried in the value even though implenia-web can resolve `nr` itself:
 * the two repos version the DIN tables independently, so the name recorded
 * here is what the operator was actually shown at sign-off rather than what
 * the entry is called wherever it is later read.
 */
export function geologieText(nr: number, override?: string): string {
  const eigen = override?.trim();
  if (eigen) return eigen;
  return findByNr(nr)?.name ?? `GeoDIN ${nr}`;
}

/** The sensors this Verfahren uses for geology, with their ids in a session. */
interface GeologySensors {
  depthName: string;
  depthId: string;
  profilName: string;
  profilId: string;
  profilType: string;
}

/**
 * Resolve the geology sensors for a session, or explain why it cannot be done.
 *
 * By role throughout, never by name: `depth` is `Bohrtiefe` for
 * Injektionsbohren and Ankerbohren but `Tiefe` for DSV. Both halves of the
 * resolution come from the session's own `sensor_map` — the role→name step as
 * much as the name→id one — so a recording keeps behaving the way it did when
 * it started.
 *
 * Taking the name from the current sensor CSVs instead was the subtle half of
 * this. A role is a property of the element: the platform stamps each sensor's
 * meta when the element is created, the kiosk's CSV copy is whatever its last
 * release shipped, and the kiosk self-updates — so a renamed sensor or a moved
 * role made this resolve to a name that is not in this session's map, for an
 * older element or simply for a session that outlived an update. See
 * `sensorNameByRole`.
 */
function resolveSensors(session: Session): GeologySensors | { fehler: string } {
  const map = parseSensorMap(session.sensor_map);
  const depthName = sensorNameByRole(map, 'depth');
  const profilName = sensorNameByRole(map, 'geology_profile');

  if (!profilName) {
    return { fehler: 'Dieses Verfahren erfasst keine Geologie.' };
  }
  if (!depthName) {
    return { fehler: 'Dieses Verfahren hat keinen Tiefensensor — ohne ihn lässt sich die Geologie keiner Tiefe zuordnen.' };
  }

  const depth = map.get(depthName.toLowerCase());
  const profil = map.get(profilName.toLowerCase());

  if (!depth) {
    return {
      fehler: `Der Sensor „${depthName}" fehlt in dieser Aufzeichnung. `
        + 'Die Geologie kann nicht zugeordnet werden; die Messwerte werden normal hochgeladen.',
    };
  }
  if (!profil) {
    return {
      fehler: `Der Sensor „${profilName}" fehlt in dieser Aufzeichnung. `
        + 'Die Geologie kann nicht hochgeladen werden; die Messwerte werden normal hochgeladen.',
    };
  }

  return {
    depthName, depthId: depth.sensorId,
    profilName, profilId: profil.sensorId, profilType: profil.sensorType,
  };
}

function isError(r: GeologySensors | { fehler: string }): r is { fehler: string } {
  return 'fehler' in r;
}

/**
 * The end of the window every geology read is restricted to, or null while the
 * rig is still drilling.
 *
 * The operating mode never lands on a reading — `session_readings.phase` is
 * only `bohren` or `rohrwechsel` — so a depth recorded while the rig retracts
 * through Austausch, Einbauen and Auffüllen is stored as drilling data and
 * `getSessionDepthSamples` hands it straight on. Two things go wrong when it
 * does, both quiet:
 *
 * 1. `drilledDepth` is `max - min`, and once the pipes are back out `min`
 *    falls toward zero — making the "did this session drill?" gate more
 *    permissive than it means to be.
 * 2. `maxTiefe` is the bottom of what was observed, and the merge bounds the
 *    profile by it. Retraction cannot deepen it, but a session credited with
 *    drilling it never did would be offered a sign-off for a hole that is not
 *    there.
 *
 * The third reason this used to matter is gone with the alignment: a boundary
 * can no longer be dated on the way back up, because boundaries are not dated
 * at all.
 *
 * `drilling_ended_at` is stamped by the step out of `bohren`, which is also
 * when the sign-off is shown, so the profile is built from drilling alone
 * however long the operator spends reviewing it.
 */
function drillingWindowEnd(session: Session): number | null {
  return session.drilling_ended_at;
}

/** Depth samples in the shape depth-timestamp.ts wants. */
function depthSamples(
  sessionId: number, sensorId: string, bis?: number | null,
): DepthSample[] {
  return getSessionDepthSamples(sessionId, sensorId, bis)
    .map((p) => ({ receivedAt: p.receivedAt, depth: p.value }));
}

export interface GeologyContext {
  /** Does this Verfahren record geology at all? */
  verfuegbar: boolean;
  /** Did this session drill far enough to have a profile worth confirming? */
  gebohrt: boolean;
  /** How far the hole moved, in metres. */
  gebohrteTiefe: number;
  /** The deepest depth recorded, in metres — the bottom of what was observed. */
  maxTiefe: number;
  /** The planned profile, for back-filling what the operator did not confirm. */
  vorgabe: VorgabeProfile | null;
  /**
   * Everything about this hole that somebody actually asserted: the taps in
   * `session_geology`, plus the layers a previous commit recorded as observed.
   *
   * Deliberately persisted rather than remembered in the browser: a PM2
   * restart mid-element loses any client-side state. Each tap carries the
   * depth that was current when the operator made it, so nothing has to be
   * recovered by joining series on a timestamp — which is what used to make a
   * misaligned write cost a layer silently.
   *
   * **The committed profile is read back too, and only its unmarked layers.**
   * A tap is not the only way to assert ground: the sign-off screen is where
   * an operator retypes a planned boundary or adds one the taps missed, and
   * those edits arrive as `quelle: 'ist'` layers that never enter
   * `session_geology`. The re-ask — a step back into `bohren` to drill deeper
   * clears `geology_confirmed_at` — rebuilds this context, so without reading
   * them back every correction made at the first sign-off is silently
   * reverted to the Schichtauftrag at the second.
   *
   * Nothing back-filled comes back with them: a layer the kiosk filled in
   * from the plan carries `q: "vorgabe"` in the committed value and is
   * dropped here, so the plan is never reported as observation. That is what
   * `observedOnly` had to reconstruct in the series shape, where provenance
   * only survived as a suffix on display text.
   */
  beobachtet: { tiefe: number; nr: number }[];
  /**
   * Whether the operator has already signed this profile off.
   *
   * Set by the step out of `bohren`, cleared by a step back into it. The stop
   * uses it to not ask a second time, and to leave the committed profile
   * alone.
   */
  bestaetigt: boolean;
  /**
   * The profile that will be committed: the observed layers with the
   * unconfirmed stretches back-filled from the Vorgabe, each layer saying
   * which it is.
   *
   * Produced here rather than in the browser because *every* stop commits one —
   * by voice, from another tab, straight from the recording bar — and the
   * sign-off screen edits this rather than deriving its own. One
   * implementation, one answer.
   */
  profil: MergedProfile | null;
  /** German, actionable, shown to the operator when something is degraded. */
  hinweis?: string;
}

/**
 * Everything the confirmation screen needs to build the profile it presents.
 *
 * Never throws: a kiosk that cannot work out its geology must still be able to
 * stop a recording and upload its measurements.
 */
export function getGeologyContext(session: Session): GeologyContext {
  const leer: GeologyContext = {
    verfuegbar: false, gebohrt: false, gebohrteTiefe: 0, maxTiefe: 0,
    vorgabe: null, beobachtet: [], bestaetigt: false, profil: null,
  };

  const sensors = resolveSensors(session);
  if (isError(sensors)) {
    // "No geology sensors" is not a fault, so it carries no hinweis. A missing
    // sensor in an otherwise geology-capable Verfahren is, and does. Asked of
    // the same source resolveSensors just used, so the two cannot disagree.
    const profilName = sensorNameByRole(parseSensorMap(session.sensor_map), 'geology_profile');
    return profilName ? { ...leer, hinweis: sensors.fehler } : leer;
  }

  const bis = drillingWindowEnd(session);
  const samples = depthSamples(session.id, sensors.depthId, bis);
  const gebohrteTiefe = drilledDepth(samples);
  const maxTiefe = samples.reduce((max, s) => (s.depth > max ? s.depth : max), 0);

  let vorgabe: VorgabeProfile | null = null;
  try {
    vorgabe = parseVorgabeGeology(getElementVorgaben(session.element_name));
  } catch (err) {
    log.warn(
      'Could not read vorgabe geology for "%s": %s',
      session.element_name, (err as Error).message,
    );
  }

  // One assertion per depth, folded oldest first so the newest wins:
  //
  //   1. what an *earlier* session of this element committed,
  //   2. this session's live taps,
  //   3. this session's own last commit.
  //
  // The order is the whole content of this. A tap made now is a better answer
  // than a boundary committed on a previous shift at the same depth, and this
  // session's sign-off is a better answer than the tap it was correcting.
  // Deduplicated here rather than left to `mergeProfile`, which would answer
  // the same but hand the screen the layer twice.
  const committed = committedObserved(session, sensors);
  const beobachtetByTiefe = new Map<number, { tiefe: number; nr: number }>();
  for (const l of committed) {
    if (l.sessionId !== session.id) beobachtetByTiefe.set(l.tiefe, { tiefe: l.tiefe, nr: l.nr });
  }
  for (const e of getSessionGeology(session.id)) {
    beobachtetByTiefe.set(e.depth, { tiefe: e.depth, nr: e.nr });
  }
  for (const l of committed) {
    if (l.sessionId === session.id) beobachtetByTiefe.set(l.tiefe, { tiefe: l.tiefe, nr: l.nr });
  }
  const beobachtet = [...beobachtetByTiefe.values()].sort((a, b) => a.tiefe - b.tiefe);

  return {
    verfuegbar: true,
    gebohrt: gebohrteTiefe >= MIN_DRILL_SPAN_M,
    gebohrteTiefe,
    maxTiefe,
    vorgabe,
    beobachtet,
    bestaetigt: session.geology_confirmed_at != null,
    profil: mergeProfile(vorgabe, beobachtet, maxTiefe),
  };
}

/**
 * The layers an already-committed profile of this *element* recorded as
 * observed, oldest session first and tagged with the session that wrote them.
 *
 * Two different losses make this necessary, and they need the same read:
 *
 * 1. **A re-ask inside one session.** The sign-off screen is a second source
 *    of observations — the operator retypes a planned boundary or adds one the
 *    taps missed, and those arrive as `quelle: 'ist'` layers that never enter
 *    `session_geology`. A step back into `bohren` clears
 *    `geology_confirmed_at`, so the next step out rebuilds this context: no
 *    read-back, and every correction is reverted to the Schichtauftrag.
 * 2. **A resumed element.** The profile is one sentinel-dated slot per
 *    element, so a second session's commit *replaces* the first's on the
 *    platform rather than adding to it. A session that reopens an element to
 *    drill deeper observes only its own stretch, and without the earlier
 *    session's layers its commit back-fills the whole hole above from the plan
 *    — overwriting real observations with `q: "vorgabe"` copies of the
 *    Schichtauftrag. The element's own Herstellprotokoll then reports planned
 *    ground for the part somebody actually looked at.
 *
 * Only the layers without `q` come back. A back-filled one is a copy of the
 * plan, and returning it would report the Schichtauftrag as something somebody
 * saw — which is also what stops `mergeProfile` from having anything left to
 * mark. Provenance is a field now, so the filter is one comparison rather than
 * the series-shape reconstruction `observedOnly` had to do.
 *
 * Only the newest value *per session* is read. Within one session a later
 * commit is a correction of the one before it, deletions included, so folding
 * an earlier write in too would resurrect a boundary the operator had just
 * removed. Across sessions they accumulate, which is the point.
 *
 * Never throws: a profile this cannot parse is treated as absent, which costs
 * that session's recovery and leaves the taps, the other sessions and the plan
 * to build from.
 */
function committedObserved(
  session: Session, sensors: GeologySensors,
): { sessionId: number; tiefe: number; nr: number }[] {
  // Newest value per session. Insertion order survives an overwrite in a Map,
  // so this stays in the query's ascending session order.
  const latestBySession = new Map<number, string>();
  for (const v of getElementSensorTextSeries(session.element_name, sensors.profilId)) {
    latestBySession.set(v.sessionId, v.text);
  }

  const out: { sessionId: number; tiefe: number; nr: number }[] = [];
  for (const [sessionId, text] of latestBySession) {
    try {
      const parsed = JSON.parse(text) as { layers?: unknown };
      if (!Array.isArray(parsed.layers)) continue;
      for (const l of parsed.layers) {
        const w = l as WireLayer | null;
        if (w == null || w.q !== undefined) continue;
        if (!Number.isFinite(w.t) || !Number.isInteger(w.nr) || w.nr <= 0) continue;
        out.push({ sessionId, tiefe: w.t, nr: w.nr });
      }
    } catch {
      log.warn('Session %d: committed geology profile is not readable', sessionId);
    }
  }
  return out;
}

/**
 * Commit the profile a stop would produce on its own: the observations with
 * the Vorgabe filling what was never confirmed.
 *
 * This is what makes the sign-off screen a review step rather than a gate.
 * Every stop path lands here unless it carried an edited profile, so a
 * recording stopped by voice, from a second tab, or straight from the bar
 * back-fills exactly the way the reviewed one does.
 *
 * Does nothing — and says so by returning null — when the Verfahren records no
 * geology, when the session never really drilled, or when there is no profile
 * to build. None of those is a fault.
 */
export function commitDefaultGeology(session: Session): GeologyCommitResult | null {
  const ctx = getGeologyContext(session);
  if (!ctx.verfuegbar || !ctx.gebohrt || !ctx.profil) return null;

  return commitGeology(session, ctx.profil.schichten.map((s) => ({
    tiefe: s.tiefe,
    nr: s.nr,
    quelle: s.quelle,
  })));
}

/**
 * Is there any geology on record for this session at all?
 *
 * The question the stop asks before it skips its own back-fill. The sign-off
 * marks a session confirmed even when the commit failed — the operator is not
 * sent back to a screen whose only button just threw — so the mark says "the
 * operator was asked", not "a profile was written". Those two come apart on a
 * kiosk whose disk filled up for a minute, and without this check the stop
 * trusted the mark and skipped the back-fill: confirmed, nothing written, and
 * the element uploaded with no geology whatsoever.
 *
 * **A committed profile, never a live entry.** `session_geology` is a
 * scratchpad that is never uploaded — only the committed `Geologieprofil`
 * value leaves the kiosk — so counting a tap here would answer "yes" for a
 * session whose sign-off commit threw and whose taps reach nobody. The stop
 * would then trust the mark, skip its own back-fill, and upload the element
 * with no geology whatsoever: exactly the silent, total loss this check
 * exists to prevent, and the common case rather than the rare one, because an
 * operator who signs off has usually tapped something.
 */
export function hasGeologyReadings(session: Session): boolean {
  const sensors = resolveSensors(session);
  if (isError(sensors)) return false;
  return getSessionSensorTextSeries(session.id, sensors.profilId).length > 0;
}

export interface GeologyCommitResult {
  /** How many layers the committed profile holds. */
  geschrieben: number;
  /** Where the profile bottoms out, in metres. */
  endTiefe: number;
  /** Layers dropped because nobody drilled or planned that deep. */
  zuTief: number[];
  /** Whether this commit replaced an earlier one. */
  ersetzt: number;
  /** German, actionable — set only when something could not be done. */
  hinweis?: string;
}

/**
 * Write a geology profile into the session as one `Geologieprofil` reading.
 *
 * Repeatable, and routinely repeated: the sign-off happens at the step out of
 * `bohren`, and a step back to drill deeper brings the operator through it
 * again. The previous commit's not-yet-uploaded reading is removed first, so
 * two profiles never stack — and because it is one value at one instant, the
 * replacement is a replacement rather than a merge. Only `pending` rows are
 * touched, so nothing already on the platform is ever removed.
 *
 * A profile is atomic, so a malformed one costs the whole profile rather than
 * a layer. It is validated here, before the write, and `session_geology` plus
 * the Schichtauftrag remain the local source of truth — so a failed or bad
 * write can be re-committed from the recording.
 *
 * Never throws for a reason the caller cannot fix. Stopping a recording and
 * uploading its measurements must not depend on the geology working out.
 */
export function commitGeology(
  session: Session,
  layers: readonly GeologyLayerInput[],
): GeologyCommitResult {
  const empty: GeologyCommitResult = {
    geschrieben: 0, endTiefe: 0, zuTief: [], ersetzt: 0,
  };

  const sensors = resolveSensors(session);
  if (isError(sensors)) {
    log.warn('Session %d: geology not committed — %s', session.id, sensors.fehler);
    return { ...empty, hinweis: sensors.fehler };
  }

  // The deepest reading of the drilling window, as one aggregate rather than
  // the whole series: `getGeologyContext` has already loaded those 27 000 rows
  // on this very path, and all that is wanted here is their maximum. A null is
  // "this session recorded no depth at all", which is the guard below.
  const gemessen = maxDrilledValue(session.id, sensors.depthId, drillingWindowEnd(session));
  if (gemessen === null) {
    const hinweis = `Für diese Aufzeichnung sind keine Messwerte von „${sensors.depthName}" `
      + 'vorhanden. Die Geologie kann keiner Tiefe zugeordnet werden — bitte die '
      + 'Tiefenmessung prüfen und das Profil danach erneut bestätigen.';
    log.warn('Session %d: geology not committed — no depth readings', session.id);
    return { ...empty, hinweis };
  }
  const maxTiefe = Math.max(gemessen, 0);

  let vorgabeEnd: number | null = null;
  try {
    vorgabeEnd = parseVorgabeGeology(getElementVorgaben(session.element_name))?.endTiefe ?? null;
  } catch {
    // A profile without the plan's bottom is bounded by the hole instead,
    // which is the honest answer when the Schichtauftrag cannot be read.
  }

  // `tiefe >= 0` matters: a negative depth is not merely ignored downstream,
  // it would sort ahead of the real first layer and claim ground above the
  // surface.
  const usable = layers
    .filter((l) => Number.isFinite(l.tiefe) && l.tiefe >= 0
      && Number.isInteger(l.nr) && l.nr > 0)
    .slice()
    .sort((a, b) => a.tiefe - b.tiefe);

  // A layer deeper than anything drilled *or* planned is a claim nobody made.
  // Dropping it is validation now rather than data loss — there is no reading
  // it failed to find — but keeping it would push `end` past the hole and
  // render ground the drill never reached. The plan's bottom counts, because a
  // planned layer below the deepest reading is legitimate on a hole that
  // stopped short.
  //
  // `TIEFE_EPS` is what `alignBoundaries` carried for the same reason: the
  // sign-off screen snaps a depth onto a 0.1 m grid and the bound comes off a
  // raw reading, so a layer at the very bottom of the hole can land a float
  // hair below it. Without the tolerance that layer — the deepest ground
  // anybody saw — is dropped, and `zuTief` is reported nowhere the operator
  // looks.
  const grenze = Math.max(maxTiefe, vorgabeEnd ?? 0);
  const zuTief = usable.filter((l) => l.tiefe > grenze + TIEFE_EPS).map((l) => l.tiefe);
  const behalten = usable.filter((l) => l.tiefe <= grenze + TIEFE_EPS);

  // At a repeated depth the *first* layer wins: a Schichtauftrag that names
  // ground types without their end depths produces several layers at one
  // depth, and keeping the last committed the deepest planned type from 0 m —
  // failing in the wrong direction. The shallowest is the better guess.
  const byDepth = new Map<number, GeologyLayerInput>();
  for (const l of behalten) if (!byDepth.has(l.tiefe)) byDepth.set(l.tiefe, l);
  const final = [...byDepth.values()];

  if (final.length === 0) {
    const hinweis = 'Für diese Aufzeichnung konnte kein Geologieprofil gebildet werden.';
    log.warn('Session %d: geology not committed — no usable layers', session.id);
    return { ...empty, zuTief, hinweis };
  }

  const endTiefe = profileEndTiefe(
    final[final.length - 1].tiefe, vorgabeEnd, maxTiefe,
  );

  const wire: WireLayer[] = final.map((l) => {
    const layer: WireLayer = {
      t: l.tiefe,
      nr: l.nr,
      name: geologieText(l.nr, l.name),
    };
    if (l.quelle === 'vorgabe') layer.q = 'vorgabe';
    return layer;
  });
  const value = JSON.stringify({ end: endTiefe, layers: wire });

  // One transaction: a failure between dropping the previous commit and
  // writing this one would leave the session with neither.
  const ersetzt = inTransaction(() => {
    const weg = deletePendingSensorReadings(session.id, sensors.profilId);
    insertSessionReading(
      session.id, sensors.profilName, sensors.profilId, sensors.profilType,
      null, value, { receivedAt: PROFILE_SENTINEL_AT },
    );
    return weg;
  });

  if (zuTief.length > 0) {
    log.info(
      'Session %d: geology profile committed with %d layers to %s m; below the hole: %s',
      session.id, final.length, endTiefe.toFixed(2),
      zuTief.map((d) => d.toFixed(2)).join(', '),
    );
  } else {
    log.info(
      'Session %d: geology profile committed with %d layers to %s m',
      session.id, final.length, endTiefe.toFixed(2),
    );
  }

  return { geschrieben: final.length, endTiefe, zuTief, ersetzt };
}

/**
 * Record one layer change at the depth the rig is at right now.
 *
 * The live path: the operator sees the ground change and taps. No depth comes
 * from the browser — this reads the most recent depth reading and stores *that
 * depth*. A depth the client measured would be a second opinion about where
 * the hole is, and the rig's own reading is the one the rest of the profile is
 * bounded by.
 *
 * Returns the depth it used so the screen can confirm what was recorded
 * ("Sand ab 3,40 m") rather than just that something was.
 *
 * **Refused once drilling has ended.** Both the buttons and the voice commands
 * are gated on `operatingMode === 'bohren'`, but those gates are the browser's
 * view of the mode: a second tab, or one whose WebSocket reconnected a moment
 * late, still offers them. The newest reading is then a retraction reading,
 * outside the window the profile is built from, so the entry would be written,
 * answered with a depth, shown as recorded — and absent from the profile.
 * Clamping it onto the last drilling reading instead would be no better: it
 * would silently assert the operator saw that ground at the bottom of the hole.
 */
export function recordLiveLayer(
  session: Session,
  nr: number,
  name?: string,
): { tiefe: number; receivedAt: number } | { fehler: string } {
  if (!Number.isInteger(nr) || nr <= 0) {
    return { fehler: 'Ungültige Bodenart.' };
  }

  if (drillingWindowEnd(session) != null) {
    return {
      fehler: 'Das Bohren ist für diese Aufzeichnung abgeschlossen — die Geologie '
        + 'kann nur während des Bohrens erfasst werden. Für eine Korrektur im '
        + 'Kopf zurück auf „Bohren" wechseln.',
    };
  }

  const sensors = resolveSensors(session);
  if (isError(sensors)) return sensors;

  const samples = depthSamples(session.id, sensors.depthId);
  const latest = samples[samples.length - 1];
  if (!latest) {
    /*
     * Two very different machines look the same from here, and the operator
     * can fix either one — but only if told which it is. Both cost a field
     * setup on 2026-10-26, where the message named neither.
     *
     * Nothing recorded at all means the channel is not reaching the kiosk
     * under this sensor: a topic the box publishes the depth under that
     * nothing has been wired to. The measurements are not being uploaded
     * either, which is the more expensive half and is why the message says
     * where to go.
     *
     * Readings that exist but are all held back means the Klemmbacke is
     * reading "zu" for everything, so every depth is tagged as a pipe change
     * and dropped from the profile. On a rig publishing an absolute depth that
     * is invisible otherwise — the depth keeps moving on screen, because an
     * absolute depth is not frozen during a Rohrwechsel.
     */
    const roh = countSessionSensorReadings(session.id, sensors.depthId);
    return {
      fehler: roh === 0
        ? `Noch kein Messwert von „${sensors.depthName}" — die Geologie kann erst ab `
          + 'dem ersten Tiefenmesswert erfasst werden. Bitte prüfen, ob dem Sensor '
          + `„${sensors.depthName}" ein Topic zugeordnet ist `
          + '(Einstellungen → Messwerte → Sensorzuordnung).'
        : `Alle Messwerte von „${sensors.depthName}" sind als Rohrwechsel markiert, `
          + 'deshalb lässt sich die Geologie keiner Tiefe zuordnen. Bitte in den '
          + 'Einstellungen unter „Rohrverlängerung" den aktuellen Wert der Klemmbacke '
          + 'ablesen und die Schwellen danach setzen.',
    };
  }

  /*
   * A second entry at the same depth replaces the first — the primary key on
   * `(session_id, depth)` does it.
   *
   * `getSessionDepthSamples` is filtered to `phase = 'bohren'`, so the latest
   * reading stands still for the whole of a Rohrverlängerung — minutes in which
   * every tap lands on one depth. Replacing is what the operator means: two
   * ground types at one depth is not a profile, and the second tap is a
   * correction.
   */
  insertSessionGeology(
    session.id, latest.depth, nr, name?.trim() || null, Date.now(),
  );

  log.info(
    'Session %d: geology %d recorded at %s m',
    session.id, nr, latest.depth.toFixed(2),
  );
  return { tiefe: latest.depth, receivedAt: latest.receivedAt };
}
