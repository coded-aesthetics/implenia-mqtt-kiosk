import net from 'node:net';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

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

  private async check(): Promise<void> {
    const online = await this.probe();
    const newState: ConnectivityState = online ? 'online' : 'offline';

    if (newState !== this.state) {
      this.state = newState;
      this.emit(newState);
      this.emit('change', newState);
    }
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
