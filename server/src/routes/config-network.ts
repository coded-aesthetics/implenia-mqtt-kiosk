import type { FastifyInstance } from 'fastify';
import { getActiveSession } from '../db.js';
import { network, type NetworkController } from '../network.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

interface ConnectBody {
  ssid?: unknown;
  psk?: unknown;
}

/**
 * The Wi-Fi of the machine this server runs on.
 *
 * Under `/api/config/netzwerk` beside the other per-machine settings, and
 * deliberately not under `/api/system`: it is a setting a technician changes on
 * the Einstellungen screens, not an operation on the process.
 *
 * `controller` is a parameter so the tests can drive a scripted
 * NetworkController, and so a future per-box agent is a different
 * implementation rather than a different route.
 */
export function registerNetworkConfigRoutes(
  app: FastifyInstance, controller: NetworkController = network,
): void {
  /**
   * Never fails. A machine without NetworkManager or without a wireless
   * interface is a normal state, and `capability` is how the screen says so
   * instead of showing an error.
   */
  app.get('/api/config/netzwerk', async () => controller.status());

  /**
   * A scan takes a few seconds, so it is its own route rather than part of the
   * status — the screen shows what the machine is on immediately and fills the
   * list in afterwards.
   */
  app.get('/api/config/netzwerk/scan', async () => ({ networks: await controller.scan() }));

  app.post<{ Body: ConnectBody }>('/api/config/netzwerk', async (request, reply) => {
    const ssid = typeof request.body?.ssid === 'string' ? request.body.ssid.trim() : '';
    // An open network has no password, so an empty string is a legal value and
    // only a non-string is rejected.
    const psk = typeof request.body?.psk === 'string' ? request.body.psk : '';

    if (!ssid) {
      return reply.status(400).send({
        error: 'Bitte ein WLAN aus der Liste auswählen.',
      });
    }

    // The box's access point is the data source. Switching networks cuts the
    // MQTT feed for as long as the new one takes to come up, and on a failed
    // attempt for the rollback too — so a running recording would lose
    // measurements it can never get back. Same guard and same reasoning as
    // `POST /api/update`, which restarts the process.
    const active = getActiveSession();
    if (active) {
      return reply.status(409).send({
        error:
          `Beim Wechsel des WLAN bricht die Verbindung zur Implenia-Box kurz ab. Die ` +
          `Aufzeichnung für „${active.element_name}" läuft gerade — dabei würden Messwerte ` +
          'fehlen. Bitte die Aufzeichnung beenden und das WLAN danach einstellen.',
      });
    }

    // The SSID is logged, the password never is: these entries are readable
    // through `GET /api/logs` and uploaded as log readings on a pilot kiosk.
    log.info('Switching Wi-Fi to "%s"', ssid);
    const result = await controller.connect(ssid, psk);

    if (!result.ok) {
      // 409 for a machine that cannot do this at all — the state of the machine
      // is in the way, and nothing about the request would fix it. 400 for a
      // network this kiosk cannot join whatever it sends, which is a problem
      // with what was asked for. 502 for a network that refused us: the
      // request was fine, the other end was not.
      const status = result.code === 'unavailable' ? 409
        : result.code === 'unsupported' ? 400
        : 502;
      return reply.status(status).send({ error: result.error, code: result.code });
    }

    return reply.send({ ok: true, ssid: result.ssid, internet: result.internet });
  });
}
