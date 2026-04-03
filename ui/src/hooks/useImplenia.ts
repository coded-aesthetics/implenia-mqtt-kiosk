import { useState, useEffect, useCallback } from 'react';

function friendlyApiError(status: number, _body: string): string {
  if (status === 502) {
    return 'Implenia-Server nicht erreichbar. Bitte Netzwerkverbindung prüfen und IMPLENIA_API_URL in der .env-Datei kontrollieren (im Projektverzeichnis).';
  }
  if (status === 503) {
    return 'Implenia-API ist nicht konfiguriert. Bitte IMPLENIA_API_URL und IMPLENIA_API_KEY in der .env-Datei im Projektverzeichnis hinterlegen und den Server neu starten.';
  }
  if (status >= 500) {
    return 'Serverfehler bei der Implenia-Schnittstelle. Bitte später erneut versuchen.';
  }
  if (status === 401 || status === 403) {
    return 'Zugriff verweigert. Bitte API-Schlüssel in den Einstellungen prüfen.';
  }
  return `Unerwarteter Fehler (${status})`;
}

// --- Config ---

export interface ConfigState {
  hasApiKey: boolean;
  apiUrl: string | null;
  apiUrlSource: 'env' | 'runtime' | null;
  loading: boolean;
  refetch: () => void;
}

export function useConfig(): ConfigState {
  const [state, setState] = useState<{ hasApiKey: boolean; apiUrl: string | null; apiUrlSource: 'env' | 'runtime' | null; loading: boolean }>({
    hasApiKey: false,
    apiUrl: null,
    apiUrlSource: null,
    loading: true,
  });

  const refetch = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => setState({ hasApiKey: data.hasApiKey, apiUrl: data.apiUrl, apiUrlSource: data.apiUrlSource, loading: false }))
      .catch(() => setState((s) => ({ ...s, loading: false })));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return { ...state, refetch };
}

// --- Shift Assignment ---

export interface MeasuringDevice {
  id: string;
  name: string;
  description: string;
}

export interface ShiftAssignment {
  day_of_execution: string;
  machine: { id: string; inventory_id: string; serial_no: string; machine_type_id: string };
  measuring_devices: MeasuringDevice[];
  personnel: { id: string; first_name: string; last_name: string };
  info: string | null;
}

export interface ShiftAssignmentState {
  data: ShiftAssignment | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
}

export function useShiftAssignment(enabled: boolean): ShiftAssignmentState {
  const [state, setState] = useState<ShiftAssignmentState>({
    data: null,
    loading: false,
    error: null,
    notFound: false,
  });

  useEffect(() => {
    if (!enabled) return;

    setState({ data: null, loading: true, error: null, notFound: false });
    fetch('/api/shift-assignment')
      .then(async (r) => {
        if (r.status === 404) {
          setState({ data: null, loading: false, error: null, notFound: true });
          return;
        }
        if (!r.ok) throw new Error(friendlyApiError(r.status, await r.text()));
        const data = await r.json();
        setState({ data, loading: false, error: null, notFound: false });
      })
      .catch((err) => setState({ data: null, loading: false, error: (err as Error).message, notFound: false }));
  }, [enabled]);

  return state;
}

// --- Vorgaben (specification parameters) ---

export interface VorgabenData {
  float_sensors?: Record<string, number | null>;
  int_sensors?: Record<string, number | null>;
  string_sensors?: Record<string, string | null>;
  geo_sensors?: Record<string, unknown>;
  int_float_sensors?: Record<string, unknown>;
}

export interface VorgabenState {
  data: VorgabenData | null;
  loading: boolean;
  error: string | null;
}

export function useVorgaben(elementName: string | null): VorgabenState {
  const [state, setState] = useState<VorgabenState>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!elementName) return;

    setState({ data: null, loading: true, error: null });
    fetch(`/api/elements/${encodeURIComponent(elementName)}/vorgaben`)
      .then(async (r) => {
        if (!r.ok) throw new Error(friendlyApiError(r.status, await r.text()));
        return r.json();
      })
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: (err as Error).message }));
  }, [elementName]);

  return state;
}

// --- Element sensor definitions ---

export interface SensorDef {
  id: string;
  name: string;
  unit?: string;
}

export interface SensorDefs {
  sensors_float: SensorDef[];
  sensors_int: SensorDef[];
  sensors_string: SensorDef[];
  sensors_geo: SensorDef[];
  sensors_int_float: SensorDef[];
  sensors_binary: SensorDef[];
}

export interface SensorDefsState {
  data: SensorDefs | null;
  loading: boolean;
  error: string | null;
}

export function useElementSensors(elementName: string | null): SensorDefsState {
  const [state, setState] = useState<SensorDefsState>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!elementName) return;

    setState({ data: null, loading: true, error: null });
    fetch(`/api/elements/${encodeURIComponent(elementName)}/sensors`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => setState({ data: null, loading: false, error: (err as Error).message }));
  }, [elementName]);

  return state;
}

// --- Vorgaben sensor unit map ---

// --- Herstellen (production) sensor unit map ---

export function useHerstellenUnits(elementName: string | null): Map<string, string> {
  const [units, setUnits] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!elementName) return;

    fetch(`/api/elements/${encodeURIComponent(elementName)}/sensors`)
      .then(async (r) => {
        if (!r.ok) return;
        const data: SensorDefs = await r.json();
        const map = new Map<string, string>();
        const allSensors = [
          ...(data.sensors_float ?? []),
          ...(data.sensors_int ?? []),
          ...(data.sensors_string ?? []),
          ...(data.sensors_geo ?? []),
        ];
        for (const s of allSensors) {
          if (s.unit) map.set(s.name, s.unit);
        }
        setUnits(map);
      })
      .catch(() => {});
  }, [elementName]);

  return units;
}

// --- Vorgaben sensor unit map ---

export function useVorgabenUnits(elementName: string | null): Map<string, string> {
  const [units, setUnits] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!elementName) return;

    fetch(`/api/elements/${encodeURIComponent(elementName)}/vorgaben/sensors`)
      .then(async (r) => {
        if (!r.ok) return;
        const data: SensorDefs = await r.json();
        const map = new Map<string, string>();
        const allSensors = [
          ...(data.sensors_float ?? []),
          ...(data.sensors_int ?? []),
          ...(data.sensors_string ?? []),
          ...(data.sensors_geo ?? []),
          ...(data.sensors_int_float ?? []),
          ...(data.sensors_binary ?? []),
        ];
        for (const s of allSensors) {
          if (s.unit) map.set(s.name, s.unit);
        }
        setUnits(map);
      })
      .catch(() => {});
  }, [elementName]);

  return units;
}
