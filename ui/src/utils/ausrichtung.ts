import { formatNumber } from './format';
import { findSoll } from './sensors';
import type { VorgabenData } from '../hooks/useImplenia';

/**
 * Aligning the rig before drilling: the rotation about the vertical axis
 * (Horizontalneigung) and the mast's inclination (Vertikalneigung).
 *
 * Use-case code, not framework code — the two Vorgabe names below are the
 * contract of the drilling Verfahren (Injektionsbohren, Ankerbohren), and the
 * live counterparts are found by *role* so another machine type's own sensor
 * names (DSV calls them `Alpha` / `Beta`, Injektionsbohren `Richtung X` /
 * `Richtung Y`) need no change here.
 *
 * Everything in this module is pure: an angle in, a judgement out. The screen
 * draws; this decides.
 */

/** Vorgabe sensor carrying the rotation the machine has to be turned to. */
export const VORGABE_HORIZONTAL = 'Horizontalneigung';
/** Vorgabe sensor carrying the inclination the mast has to be set to. */
export const VORGABE_VERTIKAL = 'Vertikalneigung';

/**
 * Roles of the live counterparts in the herstellen CSV.
 *
 * `inclination_x` is read as the rotation and `inclination_y` as the
 * inclination. That assignment is an assumption, not a documented contract:
 * the CSVs only say `Richtung X` / `Richtung Y` (DSV: `Alpha` / `Beta`), both
 * `°`, both `secondary`, with nothing saying which axis is which. The screen
 * therefore *names the sensor it is reading* under each dial, so a swapped
 * pair is visible in one glance instead of sending a worker to turn the
 * machine the wrong way. Confirm against the rig before this ships to a site.
 */
export const ROLLE_HORIZONTAL = 'inclination_x';
export const ROLLE_VERTIKAL = 'inclination_y';

/**
 * How close counts as aligned, in **degrees**.
 *
 * Degrees rather than a percentage, which is what `statusColor()` in
 * sensor-viz works in: a relative deviation is meaningless for an angle. A
 * Soll of 0° would make every reading infinitely wrong, and 2° off a Soll of
 * 180° would come out as 1% — green on a machine that is pointing two degrees
 * into the neighbouring pillar.
 *
 * Both values are placeholders pending the expert's answer on what the rigs
 * can actually hold.
 */
export const TOLERANZ_HORIZONTAL = 1.0;
export const TOLERANZ_VERTIKAL = 0.5;

/**
 * Where the dial's scale ends.
 *
 * 90° until someone confirms the real maximum (60° is the other candidate).
 * A scale that ends short of a machine's range would hide the Soll, which is
 * why the wider guess is the safe one.
 */
export const MAX_VERTIKAL = 90;

/** Beyond this the deviation reads as "far off" rather than "almost there". */
export const NAH_SCHWELLE = 5;

/**
 * After this long without a reading the angle on screen is history, not the
 * machine. Same window as the calibration screen uses for the same reason.
 */
export const VERALTET_MS = 10_000;

export type AusrichtungStatus = 'ok' | 'nah' | 'weit';

export interface Bewertung {
  /** Signed: positive means the Soll is reached by increasing the angle. */
  abweichung: number;
  status: AusrichtungStatus;
  /** German, and an instruction rather than a number where it can be one. */
  hinweis: string;
}

export function norm360(winkel: number): number {
  return ((winkel % 360) + 360) % 360;
}

/**
 * The signed turn from `ist` to `soll`, always the short way round.
 *
 * Positive is clockwise. Without the wrap a Soll of 2° at an Ist of 358°
 * would read as "356° nach links" — a full turn of the machine to cover four
 * degrees.
 */
export function kuerzesterWeg(ist: number, soll: number): number {
  let d = norm360(soll) - norm360(ist);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function bewerteStatus(abweichung: number, toleranz: number): AusrichtungStatus {
  const a = Math.abs(abweichung);
  if (a <= toleranz) return 'ok';
  if (a <= NAH_SCHWELLE) return 'nah';
  return 'weit';
}

/**
 * The colour a deviation is drawn in.
 *
 * Alongside `statusColor()` in sensor-viz rather than inside it, because that
 * one judges relatively and this one in degrees — see TOLERANZ_HORIZONTAL.
 * Red for far off is the kiosk's own convention (bold, colour-coded status),
 * and every dial pairs it with the deviation in words: colour alone never
 * carries the message.
 */
export function statusFarbe(status: AusrichtungStatus): string {
  if (status === 'ok') return 'var(--color-success)';
  if (status === 'nah') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

/** `1,0°` — one decimal, which is the resolution these sensors actually have. */
function grad(wert: number): string {
  return `${formatNumber(wert, 1)}°`;
}

export function bewerteHorizontal(ist: number, soll: number, toleranz = TOLERANZ_HORIZONTAL): Bewertung {
  const abweichung = kuerzesterWeg(ist, soll);
  const status = bewerteStatus(abweichung, toleranz);
  return {
    abweichung,
    status,
    hinweis: status === 'ok'
      ? 'Ausgerichtet'
      : `${grad(Math.abs(abweichung))} ${abweichung > 0 ? 'nach rechts' : 'nach links'}`,
  };
}

export function bewerteVertikal(ist: number, soll: number, toleranz = TOLERANZ_VERTIKAL): Bewertung {
  const abweichung = soll - ist;
  const status = bewerteStatus(abweichung, toleranz);
  return {
    abweichung,
    status,
    hinweis: status === 'ok'
      ? 'Ausgerichtet'
      : `${grad(Math.abs(abweichung))} ${abweichung > 0 ? 'stärker neigen' : 'steiler stellen'}`,
  };
}

/**
 * Does this element have to be aligned before drilling?
 *
 * Only a mast that is tilted has to be aimed: at a Vertikalneigung of 0 the
 * hole is plumb and its rotation means nothing, so the screen is not offered
 * at all rather than offered and pointless. A missing Vorgabe is treated the
 * same way — nothing to align to.
 *
 * The rotation is deliberately *not* part of the condition: a Horizontalneigung
 * of 0 on a tilted mast is a direction like any other, and one that still has
 * to be turned to.
 */
export function ausrichtungErforderlich(vorgaben: VorgabenData | null): boolean {
  const vertikal = findSoll(vorgaben, VORGABE_VERTIKAL);
  return vertikal !== null && vertikal !== 0;
}

/**
 * Can a Soll be drawn on the inclination dial, or does it lie off the scale?
 *
 * The decision lives here rather than in the dial because the consequence of
 * getting it wrong is not cosmetic: the Soll used to be clamped into
 * `0…max`, so a Vorgabe of -8° at a live 0° laid the dashed Soll mast exactly
 * over the real one — a picture saying "aligned" under words saying
 * `8,0° steiler stellen`.
 */
export function sollImBild(soll: number | null, max = MAX_VERTIKAL): soll is number {
  return soll !== null && soll >= 0 && soll <= max;
}

/**
 * Can this kiosk's Verfahren be aligned at all?
 *
 * The Vorgaben and the live roles are declared in different CSVs and do not
 * move together: `ankerbohren-sensors.csv` carries Horizontal- and
 * Vertikalneigung while `ankerbohren-sensors-herstellen.csv` has no
 * `inclination_x`/`inclination_y` row at all. Keying the stepper slot off the
 * Vorgabe alone therefore offered `‹ Ausrichten` on every tilted Ankerbohren
 * element, behind which the screen could only ever say the feature is not
 * available — an invitation to a dead end. Both halves have to exist.
 *
 * `null` (the sensor list has not answered yet, or could not be loaded) is not
 * "no roles": it answers false here, so the slot appears once the CSV is in
 * rather than flickering, and `useVerfahrenSensors` retries a failure.
 */
export function ausrichtungMoeglich(
  sensoren: readonly { name: string; role?: string }[] | null,
): boolean {
  return sensorFuerRolle(sensoren, ROLLE_HORIZONTAL) !== null
    && sensorFuerRolle(sensoren, ROLLE_VERTIKAL) !== null;
}

/** The sensor name of a role in the Verfahren's CSV, or null when it has none. */
export function sensorFuerRolle(
  sensoren: readonly { name: string; role?: string }[] | null,
  rolle: string,
): string | null {
  return sensoren?.find((s) => s.role === rolle)?.name ?? null;
}
