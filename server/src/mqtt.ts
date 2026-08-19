import mqtt from 'mqtt';
import { DataSource } from './data-source.js';
import { config } from './config.js';

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
    const topics = config.MQTT_TOPICS.split(',').map((t) => t.trim());

    this.client = mqtt.connect(config.MQTT_BROKER_URL, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.client.on('connect', () => {
      this._connected = true;
      console.log(`[MQTT] Connected to ${config.MQTT_BROKER_URL}`);

      for (const topic of topics) {
        this.client!.subscribe(topic, (err) => {
          if (err) {
            console.error(`[MQTT] Subscribe error for ${topic}:`, err.message);
          } else {
            console.log(`[MQTT] Subscribed to ${topic}`);
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
      console.log('[MQTT] Disconnected');
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
    });

    this.client.on('reconnect', () => {
      console.log('[MQTT] Reconnecting...');
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
