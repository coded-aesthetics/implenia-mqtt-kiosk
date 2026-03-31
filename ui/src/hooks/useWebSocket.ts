import { useState, useEffect, useRef, useCallback } from 'react';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
}

export interface QueueStats {
  pending: number;
  uploaded: number;
  failed: number;
}

interface WebSocketState {
  readings: Map<string, SensorReading>;
  connectivity: 'online' | 'offline' | 'unknown';
  queueStats: QueueStats;
  updateAvailable: string | null;
  updateApplying: boolean;
}

export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    readings: new Map(),
    connectivity: 'unknown',
    queueStats: { pending: 0, uploaded: 0, failed: 0 },
    updateAvailable: null,
    updateApplying: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelay.current = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'reading':
            setState((prev) => {
              const next = new Map(prev.readings);
              next.set(msg.topic, {
                topic: msg.topic,
                payload: msg.payload,
                receivedAt: msg.receivedAt,
              });
              return { ...prev, readings: next };
            });
            break;

          case 'connectivity':
            setState((prev) => ({ ...prev, connectivity: msg.state }));
            break;

          case 'queue-stats':
            setState((prev) => ({
              ...prev,
              queueStats: {
                pending: msg.pending,
                uploaded: msg.uploaded,
                failed: msg.failed,
              },
            }));
            break;

          case 'update-available':
            setState((prev) => ({
              ...prev,
              updateAvailable: msg.version,
            }));
            break;

          case 'update-applying':
            setState((prev) => ({ ...prev, updateApplying: true }));
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 30_000);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
