import { useState, useEffect, useRef, useCallback } from 'react';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
}

/**
 * Rohrverlängerung state. Null when it is not configured for this machine, or
 * when nothing is being recorded.
 */
export interface RohrwechselStatus {
  phase: 'bohren' | 'rohrwechsel';
  /** Bohrrohre in the ground. 1 while the first one is being drilled. */
  pipeCount: number;
  /** Metres currently added to the rig's reading. Always 0 on an absolute rig. */
  offset: number;
  /** German, user-facing. Set when the last Rohrwechsel did not add up. */
  warning: string | null;
  implausibleChanges: number;
  phaseSince: number | null;
}

/** What the rig is doing. Only `bohren` treats a closed Klemmbacke as a pipe change. */
export type OperatingMode = 'bohren' | 'verpressen';

export interface RecordingState {
  active: boolean;
  sessionId: number | null;
  elementName: string | null;
  startedAt: number | null;
  readingCount: number;
  rohrwechsel: RohrwechselStatus | null;
  operatingMode: OperatingMode | null;
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
}

export type UpdateSource = 'github' | 'usb';

export interface DeviceFrame {
  deviceId: number;
  values: number[];
  receivedAt: number;
}

interface WebSocketState {
  readings: Map<string, SensorReading>;
  deviceFrames: Map<number, DeviceFrame>;
  connectivity: 'online' | 'offline' | 'unknown';
  recordingState: RecordingState;
  uploadProgress: UploadProgress | null;
  updateAvailable: string | null;
  updateSource: UpdateSource | null;
  updateApplying: boolean;
}

const INITIAL_RECORDING: RecordingState = {
  active: false,
  sessionId: null,
  elementName: null,
  startedAt: null,
  readingCount: 0,
  rohrwechsel: null,
  operatingMode: null,
};

export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    readings: new Map(),
    deviceFrames: new Map(),
    connectivity: 'unknown',
    recordingState: INITIAL_RECORDING,
    uploadProgress: null,
    updateAvailable: null,
    updateSource: null,
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

          case 'device-frame':
            setState((prev) => {
              const next = new Map(prev.deviceFrames);
              next.set(msg.deviceId, {
                deviceId: msg.deviceId,
                values: msg.values,
                receivedAt: msg.receivedAt,
              });
              return { ...prev, deviceFrames: next };
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
                rohrwechsel: msg.rohrwechsel ?? null,
                operatingMode: msg.operatingMode ?? null,
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

          // Pushed on every phase change, and once on connect so a screen
          // that loads mid-Rohrwechsel does not claim the rig is drilling.
          case 'rohrwechsel':
            setState((prev) => ({
              ...prev,
              recordingState: { ...prev.recordingState, rohrwechsel: msg.status ?? null },
            }));
            break;

          case 'operating-mode':
            setState((prev) => ({
              ...prev,
              recordingState: { ...prev.recordingState, operatingMode: msg.mode ?? null },
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
              updateSource: msg.source ?? null,
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
