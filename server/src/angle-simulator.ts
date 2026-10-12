import { createLogger } from './logger.js';

const log = createLogger('angle-sim');

/**
 * A rig that can be aimed by hand, for driving the Ausrichten screen.
 *
 * The alignment screen reads two live angles, and neither exists in any dump:
 * the rotation and the mast inclination are the one part of the pipeline that
 * cannot be exercised by replaying field data. This publishes both to the
 * replay broker and lets them be moved from the replay UI in a second tab, so
 * the dials, the tolerance band, the deviation hint and the stale state can all
 * be driven from a slider.
 *
 * It rides along with the replay server rather than being a source of its own:
 * the broker and the UI are already there, and a dump plus the two angles is
 * exactly the mix a real rig produces.
 */

export interface AngleSimulatorState {
  running: boolean;
  /** Rotation, 0..360, as the dial reads it. */
  horizontal: number;
  /** Mast inclination. 0 is plumb. */
  vertikal: number;
  topicHorizontal: string;
  topicVertikal: string;
  /** Peak-to-peak jitter in degrees. 0 is a machine standing perfectly still. */
  rauschen: number;
  intervalMs: number;
}

export interface AngleInput {
  horizontal?: unknown;
  vertikal?: unknown;
  topicHorizontal?: unknown;
  topicVertikal?: unknown;
  rauschen?: unknown;
  running?: unknown;
}

export type AngleValidation =
  | { ok: true; value: Omit<AngleSimulatorState, 'intervalMs'> }
  | { ok: false; error: string };

/**
 * Defaults that need no Sensorzuordnung.
 *
 * A topic whose last segment equals a sensor name resolves on its own
 * (`resolveSensorKey`), so these two land on Injektionsbohren's `Richtung X` /
 * `Richtung Y` without anything being bound first. The prefix mirrors the one
 * rig that was actually captured (`Bohrgeraet/Klemmdruck`). The real angle
 * topics are not known yet, which is exactly why both are editable.
 */
export const DEFAULT_TOPIC_HORIZONTAL = 'Bohrgeraet/Richtung X';
export const DEFAULT_TOPIC_VERTIKAL = 'Bohrgeraet/Richtung Y';

/** Twice a second, like an Elvis frame. */
const INTERVAL_MS = 500;

const MAX_RAUSCHEN = 5;

function norm360(winkel: number): number {
  return ((winkel % 360) + 360) % 360;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One published sample: the set angle plus a little noise.
 *
 * Not cosmetic. A perfectly constant value hides everything that only shows up
 * on a moving number — a dial that jumps between tolerance tones, a readout
 * that jitters because it is not tabular, a status that flickers at the
 * threshold. `rnd` is injected so this is testable.
 */
export function jitter(wert: number, amplitude: number, rnd: () => number = Math.random): number {
  if (amplitude <= 0) return round2(wert);
  return round2(wert + (rnd() - 0.5) * amplitude);
}

function istZahl(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A topic the simulator may publish to.
 *
 * Wildcards are a subscription syntax and would publish to a topic literally
 * containing `#`; `$replay/...` is the control channel the kiosk listens on for
 * seek and stop, and a stray publish there would suppress its WebSocket
 * broadcast until the next replay action.
 */
function pruefeTopic(wert: unknown, feld: string, fallback: string): { ok: true; topic: string } | { ok: false; error: string } {
  if (wert === undefined) return { ok: true, topic: fallback };
  if (typeof wert !== 'string' || !wert.trim()) {
    return { ok: false, error: `${feld} darf nicht leer sein.` };
  }
  const topic = wert.trim();
  if (topic.includes('+') || topic.includes('#')) {
    return { ok: false, error: `${feld} darf keine Wildcards (+ oder #) enthalten.` };
  }
  if (topic.startsWith('$')) {
    return { ok: false, error: `${feld} darf nicht mit „$" beginnen — das ist der Steuerkanal des Replay-Servers.` };
  }
  return { ok: true, topic };
}

export function validateAngles(input: AngleInput, aktuell: AngleSimulatorState): AngleValidation {
  const h = input.horizontal === undefined ? aktuell.horizontal : input.horizontal;
  const v = input.vertikal === undefined ? aktuell.vertikal : input.vertikal;
  const r = input.rauschen === undefined ? aktuell.rauschen : input.rauschen;

  if (!istZahl(h)) return { ok: false, error: 'Horizontalneigung muss eine Zahl sein.' };
  // Any finite inclination is accepted, negative and past the end of the dial
  // included: driving the screen past its scale is one of the things this is
  // for, and the dial's own clamping is what should be seen.
  if (!istZahl(v)) return { ok: false, error: 'Vertikalneigung muss eine Zahl sein.' };
  if (!istZahl(r) || r < 0 || r > MAX_RAUSCHEN) {
    return { ok: false, error: `Rauschen muss zwischen 0 und ${MAX_RAUSCHEN} Grad liegen.` };
  }
  if (input.running !== undefined && typeof input.running !== 'boolean') {
    return { ok: false, error: 'running muss true oder false sein.' };
  }

  const th = pruefeTopic(input.topicHorizontal, 'Topic Horizontalneigung', aktuell.topicHorizontal);
  if (!th.ok) return { ok: false, error: th.error };
  const tv = pruefeTopic(input.topicVertikal, 'Topic Vertikalneigung', aktuell.topicVertikal);
  if (!tv.ok) return { ok: false, error: tv.error };
  if (th.topic === tv.topic) {
    return { ok: false, error: 'Beide Winkel auf dasselbe Topic zu legen ergibt keine Ausrichtung — bitte unterschiedliche Topics verwenden.' };
  }

  return {
    ok: true,
    value: {
      running: input.running === undefined ? aktuell.running : input.running,
      horizontal: norm360(h),
      vertikal: round2(v),
      topicHorizontal: th.topic,
      topicVertikal: tv.topic,
      rauschen: r,
    },
  };
}

export class AngleSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: AngleSimulatorState = {
    running: false,
    horizontal: 0,
    vertikal: 0,
    topicHorizontal: DEFAULT_TOPIC_HORIZONTAL,
    topicVertikal: DEFAULT_TOPIC_VERTIKAL,
    rauschen: 0.2,
    intervalMs: INTERVAL_MS,
  };

  constructor(
    private publish: (topic: string, payload: string) => void,
    private rnd: () => number = Math.random,
  ) {}

  get state(): AngleSimulatorState {
    return { ...this.current };
  }

  /** Apply an update. Starts or stops the publishing loop as `running` says. */
  apply(input: AngleInput): AngleValidation {
    const result = validateAngles(input, this.current);
    if (!result.ok) return result;

    const vorher = this.current.running;
    this.current = { ...result.value, intervalMs: INTERVAL_MS };

    if (this.current.running && !vorher) this.start();
    else if (!this.current.running && vorher) this.stop();
    // A new angle is published on the next tick rather than immediately: one
    // extra sample per slider pixel would flood the broker while dragging.

    return result;
  }

  start(): void {
    this.current.running = true;
    if (this.timer) return;
    log.info(
      'Angle simulator started — %s / %s',
      this.current.topicHorizontal, this.current.topicVertikal,
    );
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  stop(): void {
    this.current.running = false;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info('Angle simulator stopped');
  }

  private tick(): void {
    const { topicHorizontal, topicVertikal, horizontal, vertikal, rauschen } = this.current;
    this.publish(topicHorizontal, String(round2(norm360(jitter(horizontal, rauschen, this.rnd)))));
    this.publish(topicVertikal, String(jitter(vertikal, rauschen, this.rnd)));
  }
}
