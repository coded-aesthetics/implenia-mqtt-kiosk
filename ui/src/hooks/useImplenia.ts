import { useState, useEffect, useCallback, useRef } from 'react';

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
  vorgaben?: VorgabenData;
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
  source: 'api' | 'import' | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  refetch: () => void;
  importShift: (file: File) => Promise<{ ok: boolean; error?: string }>;
  clearImport: () => Promise<void>;
}

export function useShiftAssignment(hasApiKey: boolean): ShiftAssignmentState {
  const [state, setState] = useState<{
    data: ShiftAssignment | null;
    source: 'api' | 'import' | null;
    loading: boolean;
    error: string | null;
    notFound: boolean;
  }>({
    data: null,
    source: null,
    loading: false,
    error: null,
    notFound: false,
  });
  const fetchIdRef = useRef(0);

  const fetchShift = useCallback(() => {
    const id = ++fetchIdRef.current;
    setState((s) => ({ ...s, loading: true, error: null, notFound: false }));
    fetch('/api/shift-assignment')
      .then(async (r) => {
        if (id !== fetchIdRef.current) return;
        if (r.status === 404) {
          setState({ data: null, source: null, loading: false, error: null, notFound: true });
          return;
        }
        if (r.status === 503 && !hasApiKey) {
          setState({ data: null, source: null, loading: false, error: null, notFound: true });
          return;
        }
        if (!r.ok) throw new Error(friendlyApiError(r.status, await r.text()));
        const data = await r.json();
        const source = data.source === 'import' ? 'import' as const : 'api' as const;
        setState({ data, source, loading: false, error: null, notFound: false });
      })
      .catch((err) => {
        if (id !== fetchIdRef.current) return;
        setState({ data: null, source: null, loading: false, error: (err as Error).message, notFound: false });
      });
  }, [hasApiKey]);

  useEffect(() => {
    fetchShift();
  }, [fetchShift]);

  const importShift = useCallback(async (file: File): Promise<{ ok: boolean; error?: string }> => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!Array.isArray(json.measuring_devices)) {
        return { ok: false, error: 'Datei enthält keinen gültigen Schichtauftrag (measuring_devices fehlt).' };
      }
      const res = await fetch('/api/shift-assignment/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unbekannter Fehler' }));
        return { ok: false, error: body.error };
      }
      fetchShift();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Datei konnte nicht gelesen werden. Bitte eine gültige JSON-Datei wählen.' };
    }
  }, [fetchShift]);

  const clearImport = useCallback(async () => {
    await fetch('/api/shift-assignment/import', { method: 'DELETE' });
    fetchShift();
  }, [fetchShift]);

  return { ...state, refetch: fetchShift, importShift, clearImport };
}

// --- Vorgaben (specification parameters) ---

export interface VorgabenData {
  float_sensors?: Record<string, number | null>;
  int_sensors?: Record<string, number | null>;
  string_sensors?: Record<string, string | null>;
  geo_sensors?: Record<string, unknown>;
  int_float_sensors?: Record<string, unknown>;
}

// --- Element sensor definitions ---

export interface SensorMeta {
  source?: string;
  role?: string;
  priority?: string;
}

export interface SensorDef {
  id: string;
  name: string;
  unit?: string;
  meta?: SensorMeta | null;
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

// --- Herstellen (production) sensor definitions ---

/** Returns all herstellen sensor definitions (with meta) for an element. */
export function useHerstellenSensors(elementName: string | null): SensorDef[] {
  const [sensors, setSensors] = useState<SensorDef[]>([]);

  useEffect(() => {
    if (!elementName) return;

    fetch(`/api/elements/${encodeURIComponent(elementName)}/sensors`)
      .then(async (r) => {
        if (!r.ok) return;
        const data: SensorDefs = await r.json();
        setSensors([
          ...(data.sensors_float ?? []),
          ...(data.sensors_int ?? []),
          ...(data.sensors_string ?? []),
          ...(data.sensors_geo ?? []),
        ]);
      })
      .catch(() => {});
  }, [elementName]);

  return sensors;
}

/** Returns all vorgaben sensor definitions (with meta) for an element. */
export function useVorgabenSensors(elementName: string | null): SensorDef[] {
  const [sensors, setSensors] = useState<SensorDef[]>([]);

  useEffect(() => {
    if (!elementName) return;

    fetch(`/api/elements/${encodeURIComponent(elementName)}/vorgaben/sensors`)
      .then(async (r) => {
        if (!r.ok) return;
        const data: SensorDefs = await r.json();
        setSensors([
          ...(data.sensors_float ?? []),
          ...(data.sensors_int ?? []),
          ...(data.sensors_string ?? []),
          ...(data.sensors_geo ?? []),
          ...(data.sensors_int_float ?? []),
          ...(data.sensors_binary ?? []),
        ]);
      })
      .catch(() => {});
  }, [elementName]);

  return sensors;
}

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
