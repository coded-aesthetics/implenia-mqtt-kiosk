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
import { parseDump, type DumpMessage } from './mqtt-dump.js';

const MQTT_PORT = Number(process.env.REPLAY_MQTT_PORT ?? 1884);
const HTTP_PORT = Number(process.env.REPLAY_PORT ?? 3001);

type ReplaySpeed = 1 | 10 | 60 | 'max';
const VALID_SPEEDS: ReplaySpeed[] = [1, 10, 60, 'max'];

// ── State ──────────────────────────────────────────────────────────────

let messages: DumpMessage[] = [];
let position = 0;
let speed: ReplaySpeed = 1;
let playing = false;
let filePath: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let client: mqtt.MqttClient | null = null;

function getState() {
  return {
    file: filePath,
    totalMessages: messages.length,
    position,
    speed,
    playing,
    currentOffsetMs: position > 0 ? messages[position - 1].offsetMs : 0,
    durationMs: messages.length > 0 ? messages[messages.length - 1].offsetMs : 0,
  };
}

// ── Playback engine ────────────────────────────────────────────────────

function stopPlayback() {
  playing = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

function publishMsg(msg: DumpMessage) {
  client?.publish(msg.topic, msg.payload);
}

function scheduleNext() {
  if (!playing || position >= messages.length) {
    if (position >= messages.length) {
      playing = false;
    }
    return;
  }

  const msg = messages[position];

  if (speed === 'max') {
    const BATCH = 1000;
    let emitted = 0;
    while (playing && position < messages.length && emitted < BATCH) {
      publishMsg(messages[position]);
      position++;
      emitted++;
    }
    if (playing && position < messages.length) {
      timer = setTimeout(scheduleNext, 0);
    } else if (position >= messages.length) {
      playing = false;
    }
    return;
  }

  const prevOffset = position > 0 ? messages[position - 1].offsetMs : msg.offsetMs;
  const delay = Math.max(0, (msg.offsetMs - prevOffset) / speed);

  timer = setTimeout(() => {
    if (!playing) return;
    publishMsg(msg);
    position++;
    scheduleNext();
  }, delay);
}

// ── MQTT broker (created in start()) ───────────────────────────────────

let aedes: InstanceType<typeof Aedes>;
let broker: ReturnType<typeof createServer>;

// ── HTTP server (replay control UI + API) ──────────────────────────────

const app = Fastify();

const uiHtml = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), 'replay-ui.html'),
  'utf-8',
);

app.get('/', async (_req, reply) => reply.type('text/html').send(uiHtml));

app.post<{ Body: { file?: string } }>('/api/replay/load', async (req, reply) => {
  const file = req.body?.file;
  if (!file) return reply.status(400).send({ error: 'Dateipfad fehlt' });

  const projectRoot = path.resolve(process.cwd(), '..');
  const resolved = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

  if (!fs.existsSync(resolved)) {
    return reply.status(404).send({ error: `Datei nicht gefunden: ${resolved}` });
  }

  stopPlayback();
  const content = fs.readFileSync(resolved, 'utf-8');
  messages = parseDump(content);
  position = 0;
  filePath = resolved;

  const durationMs = messages.length > 0 ? messages[messages.length - 1].offsetMs : 0;
  const totalSec = Math.floor(durationMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  return reply.send({
    messages: messages.length,
    durationMs,
    file: resolved,
    durationFormatted: `${h}h ${m}m ${s}s`,
  });
});

app.post('/api/replay/play', async (_req, reply) => {
  if (messages.length === 0) {
    return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
  }
  if (!playing) {
    playing = true;
    scheduleNext();
  }
  return reply.send(getState());
});

app.post('/api/replay/pause', async (_req, reply) => {
  stopPlayback();
  return reply.send(getState());
});

app.post('/api/replay/stop', async (_req, reply) => {
  stopPlayback();
  position = 0;
  return reply.send(getState());
});

app.post<{ Body: { speed?: unknown } }>('/api/replay/speed', async (req, reply) => {
  const s = req.body?.speed;
  if (s !== 1 && s !== 10 && s !== 60 && s !== 'max') {
    return reply.status(400).send({ error: `Geschwindigkeit muss einer der folgenden Werte sein: ${VALID_SPEEDS.join(', ')}` });
  }
  speed = s;
  return reply.send(getState());
});

app.post<{ Body: { offsetMs?: number } }>('/api/replay/seek', async (req, reply) => {
  const offsetMs = req.body?.offsetMs;
  if (typeof offsetMs !== 'number' || offsetMs < 0) {
    return reply.status(400).send({ error: 'offsetMs muss eine nicht-negative Zahl sein' });
  }
  if (messages.length === 0) {
    return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
  }

  const wasPlaying = playing;
  stopPlayback();
  position = 0;

  // Fast-forward: publish all messages up to the target offset at max speed
  while (position < messages.length && messages[position].offsetMs <= offsetMs) {
    publishMsg(messages[position]);
    position++;
    // Yield every 5000 messages
    if (position % 5000 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  if (wasPlaying) {
    playing = true;
    scheduleNext();
  }

  return reply.send({ ...getState(), seeked: true });
});

app.get('/api/replay/state', async (_req, reply) => reply.send(getState()));

// ── Start ──────────────────────────────────────────────────────────────

async function start() {
  aedes = await Aedes.createBroker();
  broker = createServer(aedes.handle);

  await new Promise<void>((resolve, reject) => {
    broker.listen(MQTT_PORT, () => {
      console.log(`MQTT broker listening on mqtt://localhost:${MQTT_PORT}`);
      resolve();
    });
    broker.on('error', reject);
  });

  client = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`);
  await new Promise<void>((resolve) => client!.on('connect', () => resolve()));

  await app.listen({ port: HTTP_PORT, host: '0.0.0.0' });
  console.log(`Replay UI at http://localhost:${HTTP_PORT}`);
  console.log(`\nConfigure the kiosk with:  MQTT_URL=mqtt://localhost:${MQTT_PORT}`);
}

function shutdown() {
  stopPlayback();
  client?.end();
  broker.close();
  app.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => { console.error(err); process.exit(1); });
