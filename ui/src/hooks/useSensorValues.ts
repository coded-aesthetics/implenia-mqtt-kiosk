import { useMemo } from 'react';
import type { SensorReading } from './useWebSocket';
import { buildSensorValues } from '../utils/sensors';

export function useSensorValues(readings: Map<string, SensorReading>): Map<string, number> {
  return useMemo(() => buildSensorValues(readings), [readings]);
}
