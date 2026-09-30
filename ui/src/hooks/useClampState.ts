import { useState, useEffect, useMemo } from 'react';

interface ClampConfig {
  clampTopic: string | null;
  openThreshold: number;
  closeThreshold: number;
}

interface ClampState {
  clampConfig: ClampConfig;
  clampValue: number;
  isClampOpen: boolean;
}

export function useClampState(sensorValues: Map<string, number>): ClampState {
  const [clampConfig, setClampConfig] = useState<ClampConfig>({
    clampTopic: null,
    openThreshold: 50,
    closeThreshold: 100,
  });

  useEffect(() => {
    fetch('/api/config/rohrwechsel')
      .then((r) => r.json())
      .then((data) => {
        setClampConfig({
          clampTopic: data.clampTopic ?? null,
          openThreshold: data.openThreshold ?? 50,
          closeThreshold: data.closeThreshold ?? 100,
        });
      })
      .catch(() => {});
  }, []);

  const clampValue = useMemo(() => {
    if (!clampConfig.clampTopic) return 0;
    return sensorValues.get(clampConfig.clampTopic) ?? 0;
  }, [sensorValues, clampConfig.clampTopic]);

  const [isClampOpen, setIsClampOpen] = useState(true);

  useEffect(() => {
    if (clampValue >= clampConfig.closeThreshold) {
      setIsClampOpen(false);
    } else if (clampValue < clampConfig.openThreshold) {
      setIsClampOpen(true);
    }
  }, [clampValue, clampConfig.closeThreshold, clampConfig.openThreshold]);

  return { clampConfig, clampValue, isClampOpen };
}
