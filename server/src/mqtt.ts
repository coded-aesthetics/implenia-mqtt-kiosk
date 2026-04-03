import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { insertBuffer, pruneBuffer, insertSessionReading } from './db.js';
import { parsePayload } from './parse-payload.js';

export interface SensorMessage {
  topic: string;
  payload: string;
  receivedAt: number;
}

export interface SensorMapEntry {
  sensorId: string;
  sensorType: string;
}

class MqttClient extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private _connected = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: { id: number; sensorMap: Map<string, SensorMapEntry> } | null = null;

  get connected(): boolean {
    return this._connected;
  }

  startRecording(sessionId: number, sensorMap: Map<string, SensorMapEntry>): void {
    this.activeSession = { id: sessionId, sensorMap };
  }

  stopRecording(): void {
    this.activeSession = null;
  }

  get isRecording(): boolean {
    return this.activeSession !== null;
  }

  get recordingSessionId(): number | null {
    return this.activeSession?.id ?? null;
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
      const payload = message.toString();
      const receivedAt = Date.now();

      // 1. Always persist to rolling buffer
      insertBuffer(topic, payload);

      // 2. Always emit for WebSocket broadcast
      const msg: SensorMessage = { topic, payload, receivedAt };
      this.emit('reading', msg);

      // 3. If recording, write to session_readings with sensor mapping
      if (this.activeSession) {
        const topicSuffix = topic.split('/').pop()?.toLowerCase() ?? '';
        const mapping = this.activeSession.sensorMap.get(topicSuffix);
        const { valueNumeric, valueText } = parsePayload(payload);

        insertSessionReading(
          this.activeSession.id,
          topic,
          mapping?.sensorId ?? null,
          mapping?.sensorType ?? null,
          valueNumeric,
          valueText,
        );
      }
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

    // Prune buffer every 10 minutes
    this.pruneTimer = setInterval(() => {
      pruneBuffer();
    }, 10 * 60 * 1000);
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this._connected = false;
    }
  }
}

export const mqttClient = new MqttClient();
