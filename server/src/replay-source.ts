/**
 * Replay a recorded MQTT dump through the real ingestion pipeline.
 *
 * Reads a capture file in the format `mqtt-dump.ts` understands — one message
 * per line, as the box published it — and emits each message as a
 * `SensorReading` event with the same timing the rig originally had, scaled by
 * a speed multiplier.
 *
 * Dev-only. A replay session runs through the full pipeline (topic resolution,
 * calibration, Rohrwechsel, recording), exercising every path real data takes,
 * but against a throwaway database so nothing can reach the Implenia API or
 * contaminate a real kiosk.db.
 *
 * ## Seek
 *
 * Jump-to-time is implemented as reset-and-fast-forward: the caller clears the
 * session, resets drill state, and the source replays from the first message to
 * the target offset with broadcast suppressed and no artificial delay. The
 * pipeline is path-dependent (cumulative volumes, clamp state machine), so this
 * is the only correct approach short of full state snapshots.
 */

import { DataSource, type SensorReading } from './data-source.js';
import { parseDump, type DumpMessage } from './mqtt-dump.js';
import { createLogger } from './logger.js';
import fs from 'node:fs';

const log = createLogger('replay');

export type ReplaySpeed = 1 | 10 | 60 | 'max';

export interface ReplayState {
  /** File loaded, if any. */
  file: string | null;
  /** Total messages in the dump. */
  totalMessages: number;
  /** How many messages have been emitted so far. */
  position: number;
  /** Current speed multiplier. */
  speed: ReplaySpeed;
  /** Whether playback is running. */
  playing: boolean;
  /** Whether the source is in fast-forward mode (seek / broadcast suppressed). */
  fastForwarding: boolean;
  /** Offset of the last emitted message in ms (relative to dump start). */
  currentOffsetMs: number;
  /** Total duration of the dump in ms. */
  durationMs: number;
}

/**
 * Base epoch for replay timestamps. Replay sessions need a plausible clock so
 * the export path and any duration calculation produce sane numbers, but the
 * actual instant does not matter — it is a replay, not a live recording.
 * Using a fixed epoch makes tests deterministic.
 */
const REPLAY_EPOCH = new Date('2026-01-01T00:00:00+01:00').getTime();

export class ReplaySource extends DataSource {
  private messages: DumpMessage[] = [];
  private position = 0;
  private _speed: ReplaySpeed = 1;
  private _playing = false;
  private _connected = false;
  private _fastForwarding = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file: string | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get sourceType(): string {
    return 'replay';
  }

  get speed(): ReplaySpeed {
    return this._speed;
  }

  get state(): ReplayState {
    return {
      file: this.file,
      totalMessages: this.messages.length,
      position: this.position,
      speed: this._speed,
      playing: this._playing,
      fastForwarding: this._fastForwarding,
      currentOffsetMs: this.position > 0
        ? this.messages[this.position - 1].offsetMs
        : 0,
      durationMs: this.messages.length > 0
        ? this.messages[this.messages.length - 1].offsetMs
        : 0,
    };
  }

  /** Load a capture file. Stops any running playback. */
  load(filePath: string): { messages: number; durationMs: number } {
    this.stopPlayback();
    const content = fs.readFileSync(filePath, 'utf-8');
    this.messages = parseDump(content);
    this.position = 0;
    this.file = filePath;
    this._connected = true;

    const durationMs = this.messages.length > 0
      ? this.messages[this.messages.length - 1].offsetMs
      : 0;

    log.info(
      'Loaded %d messages from %s (duration %ds)',
      this.messages.length, filePath, Math.round(durationMs / 1000),
    );

    return { messages: this.messages.length, durationMs };
  }

  setSpeed(speed: ReplaySpeed): void {
    this._speed = speed;
    log.info('Replay speed set to %s', speed === 'max' ? 'max' : `${speed}x`);
  }

  /** Start or resume playback from the current position. */
  start(): void {
    if (this.messages.length === 0) {
      log.warn('No dump loaded — nothing to replay');
      return;
    }
    if (this._playing) return;
    this._playing = true;
    this._connected = true;
    log.info('Replay started at position %d/%d', this.position, this.messages.length);
    this.scheduleNext();
  }

  /** Pause playback, keeping the current position. */
  pause(): void {
    this._playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('Replay paused at position %d/%d', this.position, this.messages.length);
  }

  stop(): void {
    this.stopPlayback();
    this._connected = false;
  }

  private stopPlayback(): void {
    this._playing = false;
    this._fastForwarding = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reset to the beginning. Does NOT clear the database — the caller is
   * responsible for that (see replay routes).
   */
  reset(): void {
    this.stopPlayback();
    this.position = 0;
  }

  /**
   * Fast-forward from the current position to a target offset, emitting
   * readings synchronously with no delay and no WebSocket broadcast.
   *
   * The caller suppresses broadcast by listening to the `fast-forward-start`
   * and `fast-forward-end` events. Returns the number of messages emitted.
   */
  fastForwardTo(targetOffsetMs: number): number {
    if (this.messages.length === 0) return 0;

    this._fastForwarding = true;
    this.emit('fast-forward-start');
    let count = 0;

    while (this.position < this.messages.length) {
      const msg = this.messages[this.position];
      if (msg.offsetMs > targetOffsetMs) break;

      this.emitReading(msg);
      this.position++;
      count++;
    }

    this._fastForwarding = false;
    this.emit('fast-forward-end');
    log.info(
      'Fast-forwarded %d messages to offset %ds',
      count, Math.round(targetOffsetMs / 1000),
    );
    return count;
  }

  private emitReading(msg: DumpMessage): void {
    const reading: SensorReading = {
      topic: msg.topic,
      payload: msg.payload,
      receivedAt: REPLAY_EPOCH + msg.offsetMs,
    };
    this.emit('reading', reading);
  }

  private scheduleNext(): void {
    if (!this._playing || this.position >= this.messages.length) {
      if (this.position >= this.messages.length) {
        this._playing = false;
        log.info('Replay finished — all %d messages emitted', this.messages.length);
        this.emit('finished');
      }
      return;
    }

    const msg = this.messages[this.position];

    if (this._speed === 'max') {
      // Emit in batches to avoid starving the event loop
      const BATCH_SIZE = 1000;
      let emitted = 0;
      while (this._playing && this.position < this.messages.length && emitted < BATCH_SIZE) {
        this.emitReading(this.messages[this.position]);
        this.position++;
        emitted++;
      }
      // Yield to the event loop, then continue
      if (this._playing && this.position < this.messages.length) {
        this.timer = setTimeout(() => this.scheduleNext(), 0);
      } else if (this.position >= this.messages.length) {
        this._playing = false;
        log.info('Replay finished — all %d messages emitted', this.messages.length);
        this.emit('finished');
      }
      return;
    }

    // For timed playback, compute the delay to the next message
    const nextOffset = msg.offsetMs;
    const prevOffset = this.position > 0
      ? this.messages[this.position - 1].offsetMs
      : nextOffset;
    const realDelay = nextOffset - prevOffset;
    const scaledDelay = Math.max(0, realDelay / this._speed);

    this.timer = setTimeout(() => {
      if (!this._playing) return;
      this.emitReading(msg);
      this.position++;
      this.scheduleNext();
    }, scaledDelay);
  }
}

export const replaySource = new ReplaySource();
