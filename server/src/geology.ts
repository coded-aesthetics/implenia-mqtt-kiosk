/**
 * Worker-observed geology — the write side of the `GeoDIN` contract shared
 * with implenia-web.
 *
 * The contract already existed before this module: both herstellen CSVs define
 * `Geologie` (Text, role `geology_text`) and `GeoDIN` (Integer, role
 * `geology_nr`), and implenia-web derives the layers a worker actually saw by
 * change detection over the `GeoDIN` series, each new code starting a layer at
 * the depth of *the same reading*. Nothing had ever written it.
 *
 * Three properties of the write are load-bearing:
 *
 * 1. **Every reading is dated at the exact `received_at` of a recorded depth
 *    reading.** web aligns by millisecond equality and drops rows missing
 *    either value, so a reading dated at "now" produces no layer at all —
 *    silently. See depth-timestamp.ts, which owns the inversion.
 *
 * 2. **An obstruction is not a separate concept.** DIN 4023 numbers 59–64
 *    (`Hindernis Stahl/Beton/Holz/Sonstiges`, `Hohlräume`, `Findling`) live in
 *    the same number space as soils and rocks, so an obstruction is a thin
 *    layer and entering and leaving it are two ordinary code changes. web's
 *    existing reader renders it correctly with no change at all.
 *
 * 3. **The profile committed at stop is complete, and says which parts were
 *    observed.** Partial geology is not representable: a single code asserts
 *    the ground runs to the bottom of the hole, so there is no way to say "sand
 *    from 2 m, and I make no claim below that". Back-filling the unconfirmed
 *    stretches from the Schichtauftrag is therefore the only option that
 *    neither discards what the operator did see nor invents a boundary they
 *    rejected — and the stretches that came from the plan say so, in the
 *    `Geologie` text, with a `(Vorgabe)` suffix.
 *
 * See the "Worker-observed geology" section in CLAUDE.md before changing any of
 * this.
 */

import { findByNr } from '@coded-aesthetics/din4023';
import {
  deletePendingSensorReadings,
  getElementVorgaben,
  getSessionDepthSamples,
  getSessionSensorSeries,
  insertSessionReading,
  type Session,
} from './db.js';
import {
  alignBoundaries, drilledDepth, observedLayers, type DepthSample,
} from './depth-timestamp.js';
import { createLogger } from './logger.js';
import { parseSensorMap } from './recording.js';
import { findSensorNameByRole } from './sensor-meta.js';
import { mergeProfile, type MergedProfile } from './geology-profile.js';
import { parseVorgabeGeology, type VorgabeProfile } from './vorgabe-geology.js';

const log = createLogger('geology');

/**
 * Suffix marking a boundary the operator never confirmed.
 *
 * In the text series rather than anywhere else because nothing else survives
 * the trip: the backend stores numbers and strings, and `GeoDIN` has no room
 * for provenance. `Geologie` is written by nobody but this kiosk — the CSV
 * calls it `user` and no importer touches it — so the suffix cannot collide
 * with another writer's convention.
 */
export const VORGABE_SUFFIX = ' (Vorgabe)';

/**
 * How far the hole must have moved for the session to count as having drilled.
 *
 * Below this there is no profile worth confirming, and asking anyway would be
 * the kind of nagging this feature exists to avoid. Grouting-only and
 * stood-still sessions stop exactly as they always have.
 */
export const MIN_DRILL_SPAN_M = 0.5;

/** Where a boundary came from. */
export type Quelle = 'ist' | 'vorgabe';

/** One layer of a profile as the UI commits it. */
export interface GeologyLayerInput {
  /** Depth the layer starts at, in metres. */
  tiefe: number;
  /** DIN 4023 `GeologieEintrag.nr`. */
  nr: number;
  /**
   * Overrides the DIN name in the `Geologie` text series.
   *
   * Only for a layer the operator described themselves. Left out, the name
   * comes from the DIN tables here, so a profile reads the same however the
   * recording was stopped — and a client cannot label a layer as something it
   * is not.
   */
  name?: string;
  /** Observed during production, or carried over from the Schichtauftrag. */
  quelle?: Quelle;
}

/**
 * The human-readable value of the `Geologie` text series for a ground type.
 *
 * From the DIN 4023 tables the din4023 package owns, rather than a copy kept
 * here: the numbers and names are generated data belonging to that repo, and a
 * second copy would be wrong the first time a table changed. Only the root
 * entry of the package is used, which carries the tables and no React.
 *
 * Nothing in implenia-web reads this series — `GeoDIN` is what layers are
 * derived from — so a number that is not in the tables degrades to its bare
 * value rather than failing anything.
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
  nrName: string;
  nrId: string;
  nrType: string;
  textName: string | null;
  textId: string | null;
  textType: string | null;
}

/**
 * Resolve the geology sensors for a session, or explain why it cannot be done.
 *
 * By CSV role throughout, never by name: `depth` is `Bohrtiefe` for
 * Injektionsbohren and `Tiefe` for DSV, and the ids come from the session's own
 * `sensor_map` so a session recorded before a sensor was added keeps behaving
 * the way it did when it ran.
 */
function resolveSensors(session: Session): GeologySensors | { fehler: string } {
  const depthName = findSensorNameByRole('depth');
  const nrName = findSensorNameByRole('geology_nr');
  const textName = findSensorNameByRole('geology_text');

  if (!nrName) {
    return { fehler: 'Dieses Verfahren erfasst keine Geologie.' };
  }
  if (!depthName) {
    return { fehler: 'Dieses Verfahren hat keinen Tiefensensor — ohne ihn lässt sich die Geologie keiner Tiefe zuordnen.' };
  }

  const map = parseSensorMap(session.sensor_map);
  const depth = map.get(depthName.toLowerCase());
  const nr = map.get(nrName.toLowerCase());
  const text = textName ? map.get(textName.toLowerCase()) : undefined;

  if (!depth) {
    return {
      fehler: `Der Sensor „${depthName}" fehlt in dieser Aufzeichnung. `
        + 'Die Geologie kann nicht zugeordnet werden; die Messwerte werden normal hochgeladen.',
    };
  }
  if (!nr) {
    return {
      fehler: `Der Sensor „${nrName}" fehlt in dieser Aufzeichnung. `
        + 'Die Geologie kann nicht hochgeladen werden; die Messwerte werden normal hochgeladen.',
    };
  }

  return {
    depthName, depthId: depth.sensorId,
    nrName, nrId: nr.sensorId, nrType: nr.sensorType,
    textName: textName ?? null,
    textId: text?.sensorId ?? null,
    textType: text?.sensorType ?? null,
  };
}

function isError(r: GeologySensors | { fehler: string }): r is { fehler: string } {
  return 'fehler' in r;
}

/** Depth samples in the shape depth-timestamp.ts wants. */
function depthSamples(sessionId: number, sensorId: string): DepthSample[] {
  return getSessionDepthSamples(sessionId, sensorId)
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
   * The layers the operator entered during production, read back out of the
   * recorded `GeoDIN` series the same way implenia-web will read it.
   *
   * Deliberately derived from the readings rather than remembered in the
   * browser: a PM2 restart mid-element loses any client-side state, and the
   * readings are what will actually be uploaded. If a live write ever lands off
   * a depth reading's millisecond, the layer is missing here too — on the
   * kiosk, in front of the operator, instead of weeks later in a protocol.
   */
  beobachtet: { tiefe: number; nr: number }[];
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
    vorgabe: null, beobachtet: [], profil: null,
  };

  const sensors = resolveSensors(session);
  if (isError(sensors)) {
    // "No geology sensors" is not a fault, so it carries no hinweis. A missing
    // sensor in an otherwise geology-capable Verfahren is, and does.
    const nrName = findSensorNameByRole('geology_nr');
    return nrName ? { ...leer, hinweis: sensors.fehler } : leer;
  }

  const samples = depthSamples(session.id, sensors.depthId);
  const gebohrteTiefe = drilledDepth(samples);
  const maxTiefe = samples.reduce((max, s) => (s.depth > max ? s.depth : max), 0);

  const codes = getSessionSensorSeries(session.id, sensors.nrId)
    .map((p) => ({ receivedAt: p.receivedAt, nr: Math.round(p.value) }));

  let vorgabe: VorgabeProfile | null = null;
  try {
    vorgabe = parseVorgabeGeology(getElementVorgaben(session.element_name));
  } catch (err) {
    log.warn(
      'Could not read vorgabe geology for "%s": %s',
      session.element_name, (err as Error).message,
    );
  }

  const beobachtet = observedLayers(samples, codes);
  return {
    verfuegbar: true,
    gebohrt: gebohrteTiefe >= MIN_DRILL_SPAN_M,
    gebohrteTiefe,
    maxTiefe,
    vorgabe,
    beobachtet,
    profil: mergeProfile(vorgabe, beobachtet, maxTiefe),
  };
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

export interface GeologyCommitResult {
  /** How many boundaries were written. */
  geschrieben: number;
  /** Boundaries dropped because the hole never got that deep. */
  zuTief: number[];
  /** Boundaries dropped for want of a distinct depth reading. */
  nichtZuordenbar: number[];
  /** Readings from an earlier commit that this one replaced. */
  ersetzt: number;
  /** German, actionable — set only when something could not be done. */
  hinweis?: string;
}

/**
 * Write a geology profile into the session as `GeoDIN` + `Geologie` readings,
 * dated so implenia-web can align them.
 *
 * Repeatable: a previous commit's not-yet-uploaded geology readings are
 * removed first, so the operator can review, go back to recording, and stop
 * again without stacking two contradictory profiles. Only `pending` rows are
 * touched, so nothing already on the platform is ever removed.
 *
 * Never throws for a reason the caller cannot fix. Stopping a recording and
 * uploading its measurements must not depend on the geology working out.
 */
export function commitGeology(
  session: Session,
  layers: readonly GeologyLayerInput[],
): GeologyCommitResult {
  const empty: GeologyCommitResult = {
    geschrieben: 0, zuTief: [], nichtZuordenbar: [], ersetzt: 0,
  };

  const sensors = resolveSensors(session);
  if (isError(sensors)) {
    log.warn('Session %d: geology not committed — %s', session.id, sensors.fehler);
    return { ...empty, hinweis: sensors.fehler };
  }

  const usable = layers
    .filter((l) => Number.isFinite(l.tiefe) && Number.isInteger(l.nr) && l.nr > 0)
    .slice()
    .sort((a, b) => a.tiefe - b.tiefe);

  const samples = depthSamples(session.id, sensors.depthId);
  if (samples.length === 0) {
    const hinweis = 'Für diese Aufzeichnung sind keine Tiefenmesswerte vorhanden. '
      + 'Die Geologie kann keiner Tiefe zugeordnet werden.';
    log.warn('Session %d: geology not committed — no depth readings', session.id);
    return { ...empty, hinweis };
  }

  const ersetzt = deletePendingSensorReadings(session.id, sensors.nrId)
    + (sensors.textId ? deletePendingSensorReadings(session.id, sensors.textId) : 0);

  const { aligned, beyondHole, unalignable } = alignBoundaries(
    samples, usable.map((l) => l.tiefe),
  );

  // alignBoundaries works on depths; map back to the layer each depth came
  // from. Depths are deduplicated there, so the last layer at a repeated depth
  // is the one that stands — the same rule the upload's own per-timestamp
  // deduplication applies.
  const byDepth = new Map<number, GeologyLayerInput>();
  for (const l of usable) byDepth.set(l.tiefe, l);

  for (const boundary of aligned) {
    const layer = byDepth.get(boundary.depth);
    if (!layer) continue;

    insertSessionReading(
      session.id, sensors.nrName, sensors.nrId, sensors.nrType,
      layer.nr, null, { receivedAt: boundary.receivedAt },
    );

    if (sensors.textId && sensors.textName && sensors.textType) {
      const base = geologieText(layer.nr, layer.name);
      insertSessionReading(
        session.id, sensors.textName, sensors.textId, sensors.textType,
        null, layer.quelle === 'vorgabe' ? base + VORGABE_SUFFIX : base,
        { receivedAt: boundary.receivedAt },
      );
    }
  }

  const result: GeologyCommitResult = {
    geschrieben: aligned.length,
    zuTief: beyondHole,
    nichtZuordenbar: unalignable,
    ersetzt,
  };

  if (beyondHole.length > 0 || unalignable.length > 0) {
    // Not an error the operator needs to act on: these are layers below the
    // bottom of the hole, which nothing observed and nothing can report.
    log.info(
      'Session %d: %d geology boundaries written, %d below the hole (%s), %d unalignable',
      session.id, aligned.length, beyondHole.length,
      beyondHole.map((d) => d.toFixed(2)).join(', '), unalignable.length,
    );
  } else {
    log.info('Session %d: %d geology boundaries written', session.id, aligned.length);
  }

  return result;
}

/**
 * Record one layer change at the depth the rig is at right now.
 *
 * The live path: the operator sees the ground change and taps. No depth comes
 * from the browser — this takes the most recent depth reading and dates the
 * `GeoDIN` reading at exactly its `received_at`. That is not merely convenient:
 * a depth the client measured would have to be matched back to a reading, and
 * a client and server that disagree by one sample produce no layer at all.
 *
 * Returns the depth it used so the screen can confirm what was recorded
 * ("Sand ab 3,40 m") rather than just that something was.
 */
export function recordLiveLayer(
  session: Session,
  nr: number,
  name?: string,
): { tiefe: number; receivedAt: number } | { fehler: string } {
  if (!Number.isInteger(nr) || nr <= 0) {
    return { fehler: 'Ungültige Bodenart.' };
  }

  const sensors = resolveSensors(session);
  if (isError(sensors)) return sensors;

  const samples = depthSamples(session.id, sensors.depthId);
  const latest = samples[samples.length - 1];
  if (!latest) {
    return {
      fehler: `Noch kein Messwert von „${sensors.depthName}" — `
        + 'die Geologie kann erst ab dem ersten Tiefenmesswert erfasst werden.',
    };
  }

  insertSessionReading(
    session.id, sensors.nrName, sensors.nrId, sensors.nrType,
    nr, null, { receivedAt: latest.receivedAt },
  );
  if (sensors.textId && sensors.textName && sensors.textType) {
    insertSessionReading(
      session.id, sensors.textName, sensors.textId, sensors.textType,
      null, geologieText(nr, name), { receivedAt: latest.receivedAt },
    );
  }

  log.info(
    'Session %d: geology %d recorded at %s m',
    session.id, nr, latest.depth.toFixed(2),
  );
  return { tiefe: latest.depth, receivedAt: latest.receivedAt };
}
