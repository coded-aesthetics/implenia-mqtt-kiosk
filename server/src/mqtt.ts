import mqtt from 'mqtt';
import { DataSource } from './data-source.js';
import { getMqttSettings } from './mqtt-config.js';
import { createLogger } from './logger.js';

const log = createLogger('mqtt');

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
    });

    this.client.on('message', (topic, message) => {
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
