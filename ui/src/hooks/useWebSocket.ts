import { useState, useEffect, useRef, useCallback } from 'react';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
}

export interface RecordingState {
  active: boolean;
  sessionId: number | null;
  elementName: string | null;
  startedAt: number | null;
  readingCount: number;
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
}

interface WebSocketState {
  readings: Map<string, SensorReading>;
  connectivity: 'online' | 'offline' | 'unknown';
  recordingState: RecordingState;
  uploadProgress: UploadProgress | null;
  updateAvailable: string | null;
  updateApplying: boolean;
}

const INITIAL_RECORDING: RecordingState = {
  active: false,
  sessionId: null,
  elementName: null,
  startedAt: null,
  readingCount: 0,
};

export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    readings: new Map(),
    connectivity: 'unknown',
    recordingState: INITIAL_RECORDING,
    uploadProgress: null,
    updateAvailable: null,
    updateApplying: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  const wasApplyingUpdate = useRef(false);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelay.current = 1000;
      if (wasApplyingUpdate.current) {
        window.location.reload();
        return;
      }
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

          case 'recording-state':
            setState((prev) => ({
              ...prev,
              recordingState: {
                active: msg.active,
                sessionId: msg.sessionId,
                elementName: msg.elementName,
                startedAt: msg.startedAt,
                readingCount: msg.readingCount,
              },
            }));
            break;

          case 'recording-count':
            setState((prev) => ({
              ...prev,
              recordingState: {
                ...prev.recordingState,
                readingCount: msg.readingCount,
              },
            }));
            break;

          case 'upload-progress':
            setState((prev) => ({
              ...prev,
              uploadProgress: {
                sessionId: msg.sessionId,
                sensorsTotal: msg.sensorsTotal,
                sensorsCompleted: msg.sensorsCompleted,
                sensorsFailed: msg.sensorsFailed,
                currentSensor: msg.currentSensor,
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
            wasApplyingUpdate.current = true;
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
