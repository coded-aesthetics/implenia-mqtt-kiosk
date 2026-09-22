import { getMeta, setMeta, deleteMeta } from './db.js';
import {
  DEFAULT_SETTINGS, DEPTH_MODES, isDepthMode,
  type DepthMode, type RohrwechselSettings,
} from './rohrwechsel.js';

/**
 * Rohrverlängerung settings.
 *
 * These describe the rig and the site — which topic carries the Klemmbacke
 * pressure, how long the Bohrrohre are — so they live in the `meta` table
 * alongside the MQTT settings rather than in the environment. A release image
 * is identical across sites; this is not.
 *
 * Handling is **off until a Klemmbacke topic is configured**. A kiosk on a rig
 * without a clamp signal must behave exactly as it did before this existed:
 * raw depth through, nothing clipped.
 */

const TOPIC_KEY = 'rohrwechsel_clamp_topic';
const PIPE_LENGTH_KEY = 'rohrwechsel_pipe_length';
const CLOSE_KEY = 'rohrwechsel_close_threshold';
const OPEN_KEY = 'rohrwechsel_open_threshold';
const TOLERANCE_KEY = 'rohrwechsel_tolerance';
const DEPTH_MODE_KEY = 'rohrwechsel_depth_mode';

/** What the Implenia MQTT box publishes on the rigs seen so far. */
export const DEFAULT_CLAMP_TOPIC = 'machine/Klemmbacke';

export interface RohrwechselConfig extends RohrwechselSettings {
  /**
   * Topic carrying the Klemmbacke pressure, or null when the feature is off.
   * Matched like any other topic: full match or last segment.
   */
  clampTopic: string | null;
  enabled: boolean;
}

function readNumber(key: string, fallback: number): number {
  const raw = getMeta(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getRohrwechselConfig(): RohrwechselConfig {
  const clampTopic = getMeta(TOPIC_KEY) ?? null;
  const storedMode = getMeta(DEPTH_MODE_KEY);
  return {
    clampTopic,
    enabled: clampTopic !== null,
    depthMode:
      storedMode && isDepthMode(storedMode) ? storedMode : DEFAULT_SETTINGS.depthMode,
    pipeLength: readNumber(PIPE_LENGTH_KEY, DEFAULT_SETTINGS.pipeLength),
    closeThreshold: readNumber(CLOSE_KEY, DEFAULT_SETTINGS.closeThreshold),
    openThreshold: readNumber(OPEN_KEY, DEFAULT_SETTINGS.openThreshold),
    tolerance: readNumber(TOLERANCE_KEY, DEFAULT_SETTINGS.tolerance),
  };
}

export interface RohrwechselInput {
  clampTopic?: string | null;
  depthMode?: string;
  pipeLength?: number;
  closeThreshold?: number;
  openThreshold?: number;
  tolerance?: number;
}

export type ValidationResult =
  | { ok: true; value: Omit<RohrwechselConfig, 'enabled'> }
  | { ok: false; error: string };

/**
 * Validate what the config screen submitted.
 *
 * The messages are German and say what to do, because a technician on site
 * reads them and cannot call anyone.
 */
export function validateRohrwechsel(input: RohrwechselInput): ValidationResult {
  const current = getRohrwechselConfig();

  const rawTopic = input.clampTopic === undefined ? current.clampTopic : input.clampTopic;
  const clampTopic = typeof rawTopic === 'string' ? rawTopic.trim() : null;

  if (clampTopic !== null && clampTopic === '') {
    return {
      ok: false,
      error:
        'Bitte das Topic der Klemmbacke angeben, z. B. machine/Klemmbacke — oder die ' +
        'Rohrverlängerung ausschalten, wenn das Gerät kein Klemmbacken-Signal liefert.',
    };
  }
  if (clampTopic !== null && /\s/.test(clampTopic)) {
    return {
      ok: false,
      error: `Das Topic „${clampTopic}" darf keine Leerzeichen enthalten.`,
    };
  }

  const depthMode: DepthMode = input.depthMode === undefined
    ? current.depthMode
    : isDepthMode(input.depthMode)
      ? input.depthMode
      : (null as unknown as DepthMode);
  if (depthMode === null) {
    return {
      ok: false,
      error:
        'Bitte angeben, wie das Gerät die Bohrtiefe liefert: ' +
        Object.values(DEPTH_MODES).join(' oder ') + '.',
    };
  }

  const pipeLength = input.pipeLength ?? current.pipeLength;
  if (!Number.isFinite(pipeLength) || pipeLength <= 0) {
    return { ok: false, error: 'Bitte eine Rohrlänge in Metern angeben, z. B. 2 oder 3.' };
  }
  if (pipeLength > 12) {
    return {
      ok: false,
      error: `Eine Rohrlänge von ${pipeLength} m ist unplausibel. Übliche Längen sind 2 m oder 3 m.`,
    };
  }

  const closeThreshold = input.closeThreshold ?? current.closeThreshold;
  const openThreshold = input.openThreshold ?? current.openThreshold;
  if (!Number.isFinite(closeThreshold) || closeThreshold <= 0) {
    return {
      ok: false,
      error: 'Bitte den Druck in bar angeben, ab dem die Klemmbacke als geschlossen gilt.',
    };
  }
  if (!Number.isFinite(openThreshold) || openThreshold < 0) {
    return {
      ok: false,
      error: 'Bitte den Druck in bar angeben, unter dem die Klemmbacke als offen gilt.',
    };
  }
  if (openThreshold >= closeThreshold) {
    return {
      ok: false,
      error:
        `Der Öffnungsdruck (${openThreshold} bar) muss kleiner sein als der Schließdruck ` +
        `(${closeThreshold} bar). Sonst schaltet die Erkennung bei jedem Messrauschen hin und her.`,
    };
  }

  const tolerance = input.tolerance ?? current.tolerance;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return {
      ok: false,
      error: 'Bitte eine Toleranz in Metern angeben, z. B. 0,3.',
    };
  }
  if (tolerance >= pipeLength) {
    return {
      ok: false,
      error:
        `Die Toleranz (${tolerance} m) muss kleiner sein als die Rohrlänge (${pipeLength} m), ` +
        'sonst fällt ein Rohrwechsel ohne Bohrfortschritt nicht mehr auf.',
    };
  }

  return {
    ok: true,
    value: {
      clampTopic, depthMode, pipeLength,
      closeThreshold, openThreshold, tolerance,
    },
  };
}

/** Persist validated settings. Callers must validate first. */
export function setRohrwechselConfig(value: Omit<RohrwechselConfig, 'enabled'>): void {
  if (value.clampTopic === null) {
    deleteMeta(TOPIC_KEY);
  } else {
    setMeta(TOPIC_KEY, value.clampTopic);
  }
  setMeta(DEPTH_MODE_KEY, value.depthMode);
  setMeta(PIPE_LENGTH_KEY, String(value.pipeLength));
  setMeta(CLOSE_KEY, String(value.closeThreshold));
  setMeta(OPEN_KEY, String(value.openThreshold));
  setMeta(TOLERANCE_KEY, String(value.tolerance));
}

/**
 * Whether a reading's topic is the configured Klemmbacke.
 *
 * Matched on the full topic or its last segment, exactly like
 * `resolveSensorKey` — so `machine/Klemmbacke` (MQTT) and
 * `device/1/Klemmbacke` (serial) both hit the same configured value.
 */
export function isClampTopic(topic: string, clampTopic: string | null): boolean {
  if (!clampTopic) return false;
  const wanted = clampTopic.toLowerCase();
  const full = topic.toLowerCase();
  if (full === wanted) return true;
  const segment = full.split('/').pop() ?? '';
  const wantedSegment = wanted.split('/').pop() ?? '';
  return segment !== '' && segment === wantedSegment;
}
