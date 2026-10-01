import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ingestion } from './ingestion.js';
import type { SensorReading } from './data-source.js';
import { connectivity, type ConnectivityState } from './connectivity.js';
import { updater, type UpdateSource } from './updater.js';
import { deviceManager } from './device-manager.js';
import type { DeviceFrame } from './simulator-source.js';
import { getRecordingState } from './recording.js';
import { getSessionReadingCount } from './db.js';
import type { DrillStatus } from './rohrwechsel.js';

const clients = new Set<WebSocket>();

let broadcastSuppressed = false;

/** Toggle broadcast suppression (used by replay fast-forward). */
export function setBroadcastSuppressed(suppressed: boolean): void {
  broadcastSuppressed = suppressed;
}

function broadcast(data: Record<string, unknown>): void {
  if (broadcastSuppressed) return;
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

    // Rohrverlängerung state, so a screen that connects mid-Rohrwechsel does
    // not claim the rig is drilling.
    const drill = ingestion.drillStatus;
    if (drill) {
      socket.send(JSON.stringify({ type: 'rohrwechsel', transition: null, status: drill }));
    }

    if (updater.updateAvailable) {
      socket.send(
        JSON.stringify({
          type: 'update-available',
          version: updater.updateAvailable,
          source: updater.updateSource,
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

  ingestion.on('reading', (msg: SensorReading) => {
    broadcast({
      type: 'reading',
      topic: msg.topic,
      payload: msg.payload,
      receivedAt: msg.receivedAt,
    });
  });

  ingestion.on('rohrwechsel', (event: { transition: string | null; status: DrillStatus }) => {
    broadcast({ type: 'rohrwechsel', ...event });
  });

  ingestion.on('operating-mode', (mode: string) => {
    broadcast({ type: 'operating-mode', mode });
  });

  connectivity.on('change', (state: ConnectivityState) => {
    broadcast({ type: 'connectivity', state });
  });

  updater.on('update-available', (version: string, source: UpdateSource) => {
    broadcast({ type: 'update-available', version, source });
  });

  updater.on('update-applying', () => {
    broadcast({ type: 'update-applying' });
  });

  // Raw frames drive the channel picker, which needs values by index. The
  // mapped readings arrive via ingestion's 'reading' event above — the same
  // path MQTT takes — so they are not re-broadcast here.
  deviceManager.on('frame', (frame: DeviceFrame) => {
    broadcast({
      type: 'device-frame',
      deviceId: frame.deviceId,
      values: frame.values,
      receivedAt: frame.receivedAt,
    });
  });

  deviceManager.on('device-status', (status: { deviceId: number; connected: boolean }) => {
    broadcast({ type: 'device-status', ...status });
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
