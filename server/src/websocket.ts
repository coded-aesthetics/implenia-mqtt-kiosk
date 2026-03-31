import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { mqttClient, type SensorMessage } from './mqtt.js';
import { connectivity, type ConnectivityState } from './connectivity.js';
import { updater } from './updater.js';
import { getStats } from './db.js';

const clients = new Set<WebSocket>();

function broadcast(data: Record<string, unknown>): void {
  const message = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      // OPEN
      ws.send(message);
    }
  }
}

// Broadcast queue stats periodically
let statsTimer: ReturnType<typeof setInterval> | null = null;

function broadcastStats(): void {
  const stats = getStats();
  broadcast({
    type: 'queue-stats',
    pending: stats.pending,
    uploaded: stats.uploaded,
    failed: stats.failed,
  });
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

    const stats = getStats();
    socket.send(
      JSON.stringify({
        type: 'queue-stats',
        pending: stats.pending,
        uploaded: stats.uploaded,
        failed: stats.failed,
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

  // Broadcast stats every 10 seconds
  statsTimer = setInterval(broadcastStats, 10_000);
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
