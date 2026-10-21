import net from 'node:net';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { apiHealth } from './api-health.js';
import { fetchImplenia, getApiConfig } from './implenia-api.js';
import { createLogger } from './logger.js';

const log = createLogger('connectivity');

export type ConnectivityState = 'online' | 'offline';

class ConnectivityWatchdog extends EventEmitter {
  private state: ConnectivityState = 'offline';
  private timer: ReturnType<typeof setInterval> | null = null;

  isOnline(): boolean {
    return this.state === 'online';
  }

  getState(): ConnectivityState {
    return this.state;
  }

  async probe(): Promise<boolean> {
    const host = config.CONNECTIVITY_PROBE_HOST;

    // If host is an IP address, do a TCP connect to port 53 (DNS)
    if (net.isIP(host)) {
      return new Promise((resolve) => {
        const socket = net.createConnection({ host, port: 53, timeout: 5000 });
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
      });
    }

    // Otherwise resolve as a hostname
    return new Promise((resolve) => {
      dns.resolve(host, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Ask the platform whether it is there, but only if nothing else just did.
   *
   * The passive reports from `fetchImplenia` cover a kiosk that is being used:
   * a page load, an upload batch or an element screen answers the question for
   * free. This fills the gap on an idle one — a kiosk sitting on the element
   * list overnight — and is deliberately throttled to
   * `API_PROBE_INTERVAL_MS`, because the uplink is a metered mobile link and
   * the indicator is not worth a megabyte a day.
   *
   * Never while the internet is down: the answer is already known, and the
   * header says „Offline" rather than guessing at the platform behind it.
   * Never without a configuration either — `unconfigured` is reported by the
   * attempt itself, which would otherwise be a request to nowhere every tick.
   */
  private async checkApi(): Promise<void> {
    if (this.state !== 'online') return;
    if (apiHealth.ageMs() < config.API_PROBE_INTERVAL_MS) return;
    if (!getApiConfig()) {
      apiHealth.set('unconfigured');
      return;
    }
    try {
      // The lightest authenticated call there is, and the same one the
      // connection screen validates with. A timeout because a half-open TCP
      // connection on a sulking mobile link otherwise hangs past the next
      // tick and the probe would pile up.
      await fetchImplenia('/api/v1/measuring-device/self', { timeoutMs: 10_000 });
    } catch (err) {
      // fetchImplenia already reported it; this is only for the log.
      log.debug('API probe failed: %s', (err as Error).message);
    }
  }

  private async check(): Promise<void> {
    const online = await this.probe();
    const newState: ConnectivityState = online ? 'online' : 'offline';

    if (newState !== this.state) {
      this.state = newState;
      this.emit(newState);
      this.emit('change', newState);
    }

    await this.checkApi();
  }

  start(): void {
    // Run initial check immediately
    this.check();
    this.timer = setInterval(() => this.check(), config.CONNECTIVITY_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const connectivity = new ConnectivityWatchdog();
