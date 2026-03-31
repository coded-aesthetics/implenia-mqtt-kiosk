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
    return new Promise((resolve) => {
      dns.resolve(config.CONNECTIVITY_PROBE_HOST, (err) => {
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
