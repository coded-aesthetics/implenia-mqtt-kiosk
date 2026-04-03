import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { mqttClient, type SensorMessage } from './mqtt.js';
import { connectivity, type ConnectivityState } from './connectivity.js';
import { updater } from './updater.js';
import { getRecordingState } from './recording.js';
import { getSessionReadingCount } from './db.js';

const clients = new Set<WebSocket>();

function broadcast(data: Record<string, unknown>): void {
  const message = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

/** Public broadcast — used by recording routes to push state changes. */
export function broadcastMessage(data: Record<string, unknown>): void {
  broadcast(data);
}

// Broadcast recording count periodically
let statsTimer: ReturnType<typeof setInterval> | null = null;

function broadcastRecordingCount(): void {
  const state = getRecordingState();
  if (state.active && state.sessionId) {
    broadcast({
      type: 'recording-count',
      sessionId: state.sessionId,
      readingCount: getSessionReadingCount(state.sessionId),
    });
  }
}

export function setupWebSocket(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send current state on connect
    socket.send(
      JSON.stringify({
        type: 'connectivity',
        state: connectivity.getState(),
      })
    );

    // Send current recording state
    socket.send(
      JSON.stringify({
        type: 'recording-state',
        ...getRecordingState(),
      })
    );

    if (updater.updateAvailable) {
      socket.send(
        JSON.stringify({
          type: 'update-available',
          version: updater.updateAvailable,
        })
      );
    }

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  // Wire up event sources to broadcast

  mqttClient.on('reading', (msg: SensorMessage) => {
    broadcast({
      type: 'reading',
      topic: msg.topic,
      payload: msg.payload,
      receivedAt: msg.receivedAt,
    });
  });

  connectivity.on('change', (state: ConnectivityState) => {
    broadcast({ type: 'connectivity', state });
  });

  updater.on('update-available', (version: string) => {
    broadcast({ type: 'update-available', version });
  });

  updater.on('update-applying', () => {
    broadcast({ type: 'update-applying' });
  });

  // Broadcast recording count every 10 seconds (replaces old queue-stats)
  statsTimer = setInterval(broadcastRecordingCount, 10_000);
}

export function stopWebSocket(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  for (const ws of clients) {
    ws.close();
  }
  clients.clear();
}
