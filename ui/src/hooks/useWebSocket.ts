import { useState, useEffect, useRef, useCallback } from 'react';

export interface SensorReading {
  topic: string;
  payload: string;
  receivedAt: number;
  /**
   * The sensor this topic resolved to on the server, lowercased — null when it
   * resolved to nothing. The only way to find a sensor whose topic was wired
   * on site: see `sensorValue()` in utils/sensors.
   */
  sensor?: string | null;
}

/**
 * Rohrverlängerung state. Null when it is not configured for this machine, or
 * when nothing is being recorded.
 */
export interface RohrwechselStatus {
  phase: 'bohren' | 'rohrwechsel';
  /** Bohrrohre in the ground. 1 while the first one is being drilled. */
  pipeCount: number;
  /**
   * Metres currently added to the rig's reading. On an absolute rig this is
   * the worker's manual depth correction and nothing else.
   */
  offset: number;
  /** German, user-facing. Set when the last Rohrwechsel did not add up. */
  warning: string | null;
  /** When it was raised — what the recording bar keys "already seen" off. */
  warningSince: number | null;
  implausibleChanges: number;
  phaseSince: number | null;
}

/** What the rig is doing. Only `bohren` treats a closed Klemmbacke as a pipe change. */
export type OperatingMode = 'bohren' | 'austausch' | 'einbauen' | 'auffuellen';

export interface RecordingState {
  active: boolean;
  sessionId: number | null;
  elementName: string | null;
  startedAt: number | null;
  readingCount: number;
  rohrwechsel: RohrwechselStatus | null;
  operatingMode: OperatingMode | null;
  /**
   * Metres the worker has corrected the depth by on this element, or null when
   * nothing is being recorded.
   *
   * Its own field rather than part of `rohrwechsel`, which is null on a kiosk
   * with no Klemmbacke — a depth correction applies on every rig.
   */
  depthCorrection: number | null;
}

export interface UploadProgress {
  sessionId: number;
  sensorsTotal: number;
  sensorsCompleted: number;
  sensorsFailed: number;
  currentSensor: string | null;
  /**
   * What the counters count: sensors on the per-sensor upload, chunks ("Pakete")
   * on the CSV one. Defaulted rather than required, because a browser tab can
   * outlive a server restart onto a build that does not send it.
   */
  unit: 'sensor' | 'paket';
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
  /** Why the last apply gave up, in German. Null while none has. */
  updateFailure: string | null;
  replaySeeking: boolean;
}

const INITIAL_RECORDING: RecordingState = {
  active: false,
  sessionId: null,
  elementName: null,
  startedAt: null,
  readingCount: 0,
  rohrwechsel: null,
  operatingMode: null,
  depthCorrection: null,
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
    updateFailure: null,
    replaySeeking: false,
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
      // A disconnect during replay seek leaves replaySeeking true with no
      // dismiss mechanism. The server doesn't re-send seek state on connect,
      // so reset it here.
      setState((prev) => prev.replaySeeking ? { ...prev, replaySeeking: false } : prev);
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
                sensor: msg.sensor ?? null,
              });
              return { ...prev, readings: next };
            });
            break;

          /*
           * The server's last-known value per topic, sent once on connect.
           *
           * Without it every tile reads 0 until the rig publishes again: the
           * map starts empty on each page load, so a reload — or a PM2 restart
           * mid-element — blanks the depth and the slurry volume of a pillar
           * that is half drilled. A live reading that arrived first wins, by
           * timestamp, so this can never put an older value back on screen.
           */
          case 'snapshot':
            setState((prev) => {
              const next = new Map(prev.readings);
              for (const r of msg.readings as SensorReading[]) {
                const known = next.get(r.topic);
                if (known && known.receivedAt >= r.receivedAt) continue;
                next.set(r.topic, {
                  topic: r.topic,
                  payload: r.payload,
                  receivedAt: r.receivedAt,
                  sensor: r.sensor ?? null,
                });
              }
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
                depthCorrection: msg.depthCorrection ?? null,
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
                unit: msg.unit === 'paket' ? 'paket' : 'sensor',
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
            setState((prev) => ({ ...prev, updateApplying: true, updateFailure: null }));
            break;

          // The apply gave up, so the app is not restarting after all. Clearing
          // `wasApplyingUpdate` matters: left set, the next reconnect — a server
          // restart hours later, for any reason — would reload the page as if
          // the update had landed.
          case 'update-failed':
            wasApplyingUpdate.current = false;
            setState((prev) => ({
              ...prev,
              updateApplying: false,
              updateFailure: typeof msg.reason === 'string' ? msg.reason : 'Update fehlgeschlagen',
            }));
            break;

          case 'replay-seeking':
            setState((prev) => ({ ...prev, replaySeeking: !!msg.seeking }));
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
