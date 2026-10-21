import { EventEmitter } from 'node:events';

/**
 * Whether sensor data is *arriving*, as the third thing the header reports.
 *
 * The other two are about data leaving the kiosk — internet (`connectivity`)
 * and the platform (`api-health`) — and both are recoverable: a failed upload
 * is buffered and retried. This one is not. A kiosk whose link to the box dies
 * mid-hole keeps showing the last value it got, on every gauge, for as long as
 * the link stays down; the depth hero reads 8,40 m while the drill keeps
 * going, and a running recording records nothing. Until this existed, the only
 * sign of it on screen was the recording bar's reading count sitting still.
 *
 * - `unknown` — not observed yet.
 * - `connected` — the source has its transport up.
 * - `disconnected` — it does not, and it is configured to have one.
 * - `unconfigured` — no broker, no devices: a fresh machine, or one the setup
 *   wizard has not finished. Claims nothing, exactly like `api-health`'s own
 *   `unconfigured`, because a kiosk on a bench must not report a fault.
 */
export type SourceHealth = 'unknown' | 'connected' | 'disconnected' | 'unconfigured';

export interface SourceReport {
  connected: boolean;
  /** False when nothing has been set up for this source to connect *to*. */
  configured: boolean;
}

/** Pure, so the one interesting decision is testable without a transport. */
export function healthFromSource(report: SourceReport): SourceHealth {
  if (!report.configured) return 'unconfigured';
  return report.connected ? 'connected' : 'disconnected';
}

class SourceHealthTracker extends EventEmitter {
  private state: SourceHealth = 'unknown';
  private type = 'mqtt';

  getState(): SourceHealth {
    return this.state;
  }

  /** `mqtt`, `serial`, `replay` — what the UI names in its message. */
  getSourceType(): string {
    return this.type;
  }

  report(health: SourceHealth, sourceType: string): void {
    if (health === this.state && sourceType === this.type) return;
    this.state = health;
    this.type = sourceType;
    this.emit('change', health, sourceType);
  }

  /** Test seam. */
  reset(): void {
    this.state = 'unknown';
    this.type = 'mqtt';
  }
}

export const sourceHealth = new SourceHealthTracker();

/**
 * How often the ingestion layer re-reads the source's connection state.
 *
 * **Polled rather than event-driven, deliberately.** Each `DataSource` flips
 * its own `_connected` in between two and five places (mqtt on connect, close
 * and error; serial on open, close, error and unplug), so emitting from every
 * one of them is five files and a dozen edit sites where a missed one makes
 * the indicator quietly wrong — the failure this is being built to end.
 * `device-source` settles it outright: its `connected` is *derived*
 * (`deviceManager.getStatus().some(d => d.connected)`) and has no transition
 * point to emit from at all.
 *
 * One boolean read per second, in the framework seam that already owns the
 * source, cannot be forgotten by a source added later.
 */
export const SOURCE_POLL_INTERVAL_MS = 1_000;
