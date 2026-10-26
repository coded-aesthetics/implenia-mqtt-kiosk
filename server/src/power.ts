import { createLogger } from './logger.js';
import { realExec, type Exec } from './network.js';

const log = createLogger('power');

/**
 * Switching this machine off from the touchscreen.
 *
 * The way a shift ends today is at the socket, and an unclean shutdown is
 * something the kiosk then has to paper over — `~/.xsession` rewrites
 * Chromium's `exited_cleanly` flag on every start so the "Restore pages?"
 * bubble does not land on top of the UI. This is the button that does it
 * properly.
 *
 * `systemctl poweroff` rather than `sudo`: the server runs as the kiosk user
 * and PM2 gives it no login session, so logind's answer comes from polkit,
 * which `scripts/provision-kiosk.sh` grants. A machine without systemd — a
 * developer's Mac — is a *state* and not an error: `capability()` says so and
 * the tile offers no tap target, the same way the WLAN screen behaves on a
 * machine with no NetworkManager.
 *
 * `Exec` comes from network.ts rather than a second copy of the same plumbing:
 * identical contract, a non-zero exit is a result rather than an error, and
 * injectable so the tests never go near a real `systemctl`.
 */

/** Bound on both systemctl calls, in ms. */
const TIMEOUT_MS = 10_000;

export type PowerCapability =
  | { available: true }
  | { available: false; reason: string };

export type PowerResult = { ok: true } | { ok: false; error: string };

export interface PowerController {
  capability(): Promise<PowerCapability>;
  poweroff(): Promise<PowerResult>;
}

export class LocalPower implements PowerController {
  private readonly exec: Exec;

  constructor(exec: Exec = realExec) {
    this.exec = exec;
  }

  async capability(): Promise<PowerCapability> {
    const result = await this.exec('systemctl', ['--version'], TIMEOUT_MS);
    if (result.code !== 0) {
      log.debug('systemctl --version failed (%d): %s', result.code, result.stderr.trim());
      return {
        available: false,
        reason:
          'Dieses Gerät kann sich nicht selbst ausschalten. Bitte den ' +
          'Einschaltknopf am Gerät verwenden.',
      };
    }
    return { available: true };
  }

  async poweroff(): Promise<PowerResult> {
    const result = await this.exec('systemctl', ['poweroff'], TIMEOUT_MS);
    if (result.code === 0) return { ok: true };

    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    log.error('systemctl poweroff failed (%d): %s', result.code, detail);
    return { ok: false, error: shutdownError(detail) };
  }
}

/**
 * The one failure worth telling apart.
 *
 * A missing polkit rule is what a kiosk provisioned before this button existed
 * answers, and logind phrases its refusal as a request for an interactive
 * authentication nobody on a construction site can give. Either way the
 * operator gets the same way out — the knob on the machine — because the fix
 * itself is the service tech's, not theirs.
 *
 * systemd's own wording is logged rather than shown. The screens that carry a
 * technical detail carry it for a technician standing in front of them; this
 * one is read by a worker in gloves, for whom `Failed to set wall message` is
 * nothing to act on. `GET /api/logs?module=power` is the service path.
 *
 * Both messages are short because the tile is where they land, and a tile is
 * 304x261 at 1024x768: the first version of this one needed 286px of it and
 * grew the grid's second row past the bottom of the screen. Measured, not
 * counted — see CLAUDE.md on the card that took three attempts.
 */
export function shutdownError(detail: string): string {
  if (/interactive authentication|access denied|not authorized|permission denied/i.test(detail)) {
    return (
      'Keine Berechtigung zum Ausschalten. Bitte den Einschaltknopf am Gerät ' +
      'verwenden und den Service informieren.'
    );
  }
  return (
    'Das Ausschalten ist fehlgeschlagen. Bitte den Einschaltknopf am Gerät ' +
    'verwenden.'
  );
}

export const power: PowerController = new LocalPower();
