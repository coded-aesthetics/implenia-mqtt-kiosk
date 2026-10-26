import type { FastifyInstance } from 'fastify';
import { getActiveSession } from '../db.js';
import { power, type PowerController } from '../power.js';
import { createLogger } from '../logger.js';

const log = createLogger('system');

/**
 * Switching the machine off from Einstellungen.
 *
 * Under `/api/system` rather than `/api/config`: this is an operation on the
 * machine, not a setting somebody stores on it.
 *
 * `controller` is a parameter so the tests drive a scripted one and never go
 * near a real `systemctl`.
 */
export function registerSystemRoutes(
  app: FastifyInstance, controller: PowerController = power,
): void {
  /**
   * Never fails. A machine without systemd answers `available: false` with a
   * German reason, and the tile shows that instead of a tap target that cannot
   * work.
   */
  app.get('/api/system/power', async () => ({ capability: await controller.capability() }));

  app.post('/api/system/shutdown', async (_request, reply) => {
    /*
     * Deliberately *not* refused while a recording runs, unlike
     * `POST /api/update`, the WLAN switch and the site switch. Those three
     * would cost the running session measurements it can never get back; this
     * one costs nothing — the session stays open in SQLite and
     * `resumeRecording()` picks it up at the next boot. A crew going home has
     * to be able to switch the box off, and a button that refuses would send
     * them back to the socket, which is the unclean shutdown this replaces.
     * The tile warns instead.
     */
    const active = getActiveSession();
    if (active) {
      log.warn('Powering off while the recording for "%s" is running', active.element_name);
    } else {
      log.info('Powering off on request from the settings screen');
    }

    const result = await controller.poweroff();
    if (!result.ok) {
      // 500: the request was fine and so is the machine's state — this kiosk
      // is missing a permission its provisioning was supposed to grant.
      return reply.status(500).send({ error: result.error });
    }
    return reply.send({ ok: true });
  });
}
