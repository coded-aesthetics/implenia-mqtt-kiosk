import mqtt from 'mqtt';
import { DataSource } from './data-source.js';
import { getMqttSettings } from './mqtt-config.js';
import { broadcastMessage, setBroadcastSuppressed } from './websocket.js';
import { beginTransaction, commitTransaction, rollbackTransaction } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('mqtt');

const REPLAY_CONTROL_TOPIC = '$replay/control';

class MqttSource extends DataSource {
  private client: mqtt.MqttClient | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  get sourceType(): string {
    return 'mqtt';
  }

  start(): void {
    // Settings come from the setup wizard (meta table), falling back to env.
    // Not configured yet (fresh machine) → stay disconnected and let the rest
    // of the kiosk boot; the UI already handles a disconnected source.
    const { brokerUrl, topics: topicFilter } = getMqttSettings();
    if (!brokerUrl || !topicFilter) {
      log.warn('MQTT is not configured (broker URL and/or topics missing) — source stays disconnected');
      return;
    }

    const topics = topicFilter.split(',').map((t) => t.trim()).filter(Boolean);

    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.client.on('connect', () => {
      this._connected = true;
      log.info('Connected to %s', brokerUrl);

      for (const topic of topics) {
        this.client!.subscribe(topic, (err) => {
          if (err) {
            log.error('Subscribe error for %s: %s', topic, err.message);
          } else {
            log.info('Subscribed to %s', topic);
          }
        });
      }

      // $-prefixed topics are not matched by wildcard subscriptions (MQTT
      // spec §4.7.2), so subscribe explicitly. The replay server publishes
      // seek control messages on this topic.
      this.client!.subscribe(REPLAY_CONTROL_TOPIC, () => {});
    });

    this.client.on('message', (topic, message) => {
      if (topic === REPLAY_CONTROL_TOPIC) {
        const action = message.toString();
        if (action === 'seek-start') {
          log.info('Replay seek started — suppressing broadcast');
          broadcastMessage({ type: 'replay-seeking', seeking: true });
          setBroadcastSuppressed(true);
          this.emit('seek-start');
          try {
            beginTransaction();
          } catch (err) {
            log.error('Failed to begin seek transaction: %s', (err as Error).message);
          }
        } else if (action === 'seek-end') {
          log.info('Replay seek finished — resuming broadcast');
          try {
            commitTransaction();
          } catch (err) {
            log.error('Failed to commit seek transaction, rolling back: %s', (err as Error).message);
            try { rollbackTransaction(); } catch { /* already outside a transaction */ }
          }
          this.emit('seek-end');
          setBroadcastSuppressed(false);
          broadcastMessage({ type: 'replay-seeking', seeking: false });
        } else if (action === 'seek-abort') {
          log.warn('Replay seek aborted — rolling back');
          try { rollbackTransaction(); } catch { /* no transaction open */ }
          this.emit('seek-end');
          setBroadcastSuppressed(false);
          broadcastMessage({ type: 'replay-seeking', seeking: false });
        } else if (action === 'replay-start') {
          log.info('Replay session requested');
          this.emit('replay-start');
        } else if (action === 'replay-stop') {
          log.info('Replay session end requested');
          this.emit('replay-stop');
        }
        return;
      }

      this.emit('reading', {
        topic,
        payload: message.toString(),
        receivedAt: Date.now(),
      });
    });

    this.client.on('close', () => {
      this._connected = false;
      log.info('Disconnected');
    });

    this.client.on('error', (err) => {
      log.error('Error: %s', err.message);
    });

    this.client.on('reconnect', () => {
      log.info('Reconnecting...');
    });
  }

  stop(): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this._connected = false;
    }
  }
}

export const mqttSource = new MqttSource();
