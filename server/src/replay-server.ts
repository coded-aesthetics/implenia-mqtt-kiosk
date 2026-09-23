// Replay server — publishes recorded MQTT dumps to an embedded broker.
//
// The kiosk connects to this broker (MQTT_URL=mqtt://localhost:1884) and
// processes the messages through its real pipeline: topic resolution,
// calibration, Rohrwechsel, recording, display. This exercises the full
// end-to-end path without needing a rig or an external broker.
//
// Usage:  npm run replay          (from repo root)
//         npm run replay -w server (from server/)

import Fastify from 'fastify';
import { Aedes } from 'aedes';
import { createServer } from 'node:net';
import mqtt from 'mqtt';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplaySource, type ReplaySpeed } from './replay-source.js';
import type { SensorReading } from './data-source.js';
import { createLogger } from './logger.js';

const log = createLogger('replay-server');

const MQTT_PORT = Number(process.env.REPLAY_MQTT_PORT ?? 1884);
const HTTP_PORT = Number(process.env.REPLAY_PORT ?? 3001);

const VALID_SPEEDS: ReplaySpeed[] = [1, 10, 60, 'max'];
const REPLAY_CONTROL_TOPIC = '$replay/control';

// ── Playback source ─────────────────────────────────────────────────────

const source = new ReplaySource();

let client: mqtt.MqttClient | null = null;

source.on('reading', (reading: SensorReading) => {
  client?.publish(reading.topic, reading.payload);
});

function publishControl(action: string): Promise<void> {
  return new Promise((resolve) => {
    if (!client) { resolve(); return; }
    client.publish(REPLAY_CONTROL_TOPIC, action, () => resolve());
  });
}

// ── HTTP server (replay control UI + API) ────────────────────────────────

const app = Fastify();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiHtml = fs.readFileSync(path.join(__dirname, 'replay-ui.html'), 'utf-8');

app.get('/', async (_req, reply) => reply.type('text/html').send(uiHtml));

app.post<{ Body: { file?: string } }>('/api/replay/load', async (req, reply) => {
  const file = req.body?.file;
  if (!file) return reply.status(400).send({ error: 'Dateipfad fehlt' });

  const projectRoot = path.resolve(process.cwd(), '..');
  const resolved = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

  if (!fs.existsSync(resolved)) {
    return reply.status(404).send({ error: `Datei nicht gefunden: ${resolved}` });
  }

  source.stop();
  await publishControl('replay-stop');
  const result = source.load(resolved);

  const totalSec = Math.floor(result.durationMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  return reply.send({
    ...result,
    file: resolved,
    durationFormatted: `${h}h ${m}m ${s}s`,
  });
});

app.post('/api/replay/play', async (_req, reply) => {
  if (source.state.totalMessages === 0) {
    return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
  }
  await publishControl('replay-start');
  source.start();
  return reply.send(source.state);
});

app.post('/api/replay/pause', async (_req, reply) => {
  source.pause();
  return reply.send(source.state);
});

app.post('/api/replay/stop', async (_req, reply) => {
  source.stop();
  source.reset();
  await publishControl('replay-stop');
  return reply.send(source.state);
});

app.post<{ Body: { speed?: unknown } }>('/api/replay/speed', async (req, reply) => {
  const s = req.body?.speed;
  if (s !== 1 && s !== 10 && s !== 60 && s !== 'max') {
    return reply.status(400).send({ error: `Geschwindigkeit muss einer der folgenden Werte sein: ${VALID_SPEEDS.join(', ')}` });
  }
  source.setSpeed(s);
  return reply.send(source.state);
});

app.post<{ Body: { offsetMs?: number } }>('/api/replay/seek', async (req, reply) => {
  const offsetMs = req.body?.offsetMs;
  if (typeof offsetMs !== 'number' || offsetMs < 0) {
    return reply.status(400).send({ error: 'offsetMs muss eine nicht-negative Zahl sein' });
  }
  if (source.state.totalMessages === 0) {
    return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
  }

  const wasPlaying = source.state.playing;
  source.pause();
  source.reset();

  // Tell the kiosk to suppress WebSocket broadcast during fast-forward.
  // The kiosk subscribes to $replay/control and calls setBroadcastSuppressed.
  await publishControl('seek-start');

  // Fast-forward from 0 to the target: readings are emitted, published to
  // the broker, and the kiosk processes them through its real pipeline
  // (ingestion → SQLite) — so path-dependent state (depth, volumes, clamp)
  // is rebuilt correctly. The kiosk just doesn't push them to the UI.
  const count = await source.fastForwardTo(offsetMs);

  await publishControl('seek-end');

  if (wasPlaying) {
    source.start();
  }

  return reply.send({ ...source.state, seeked: true, messagesReplayed: count });
});

app.get('/api/replay/state', async (_req, reply) => reply.send(source.state));

// ── Start ──────────────────────────────────────────────────────────────

let aedes: InstanceType<typeof Aedes>;
let broker: ReturnType<typeof createServer>;

async function start() {
  aedes = await Aedes.createBroker();
  broker = createServer(aedes.handle);

  await new Promise<void>((resolve, reject) => {
    broker.listen(MQTT_PORT, () => {
      log.info('MQTT broker listening on mqtt://localhost:%d', MQTT_PORT);
      resolve();
    });
    broker.on('error', reject);
  });

  client = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`);
  await new Promise<void>((resolve) => client!.on('connect', () => resolve()));

  await app.listen({ port: HTTP_PORT, host: '0.0.0.0' });
  log.info('Replay UI at http://localhost:%d', HTTP_PORT);
  log.info('Configure the kiosk with:  MQTT_URL=mqtt://localhost:%d', MQTT_PORT);
}

function shutdown() {
  source.stop();
  client?.end();
  broker?.close();
  app.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => { log.error('Failed to start: %s', err.message); process.exit(1); });
