import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AngleSimulator, validateAngles, jitter,
  DEFAULT_TOPIC_HORIZONTAL, DEFAULT_TOPIC_VERTIKAL,
  type AngleSimulatorState,
} from './angle-simulator.js';

const BASIS: AngleSimulatorState = {
  running: false,
  horizontal: 0,
  vertikal: 0,
  topicHorizontal: DEFAULT_TOPIC_HORIZONTAL,
  topicVertikal: DEFAULT_TOPIC_VERTIKAL,
  rauschen: 0.2,
  intervalMs: 500,
};

describe('jitter', () => {
  it('is the value itself without noise', () => {
    expect(jitter(142.5, 0)).toBe(142.5);
    expect(jitter(142.555, 0)).toBe(142.56);
  });

  it('stays inside half the amplitude either side', () => {
    expect(jitter(100, 2, () => 1)).toBe(101);
    expect(jitter(100, 2, () => 0)).toBe(99);
    expect(jitter(100, 2, () => 0.5)).toBe(100);
  });
});

describe('validateAngles', () => {
  it('wraps a rotation into 0..360', () => {
    const r = validateAngles({ horizontal: 370 }, BASIS);
    expect(r.ok && r.value.horizontal).toBe(10);
    const l = validateAngles({ horizontal: -10 }, BASIS);
    expect(l.ok && l.value.horizontal).toBe(350);
  });

  it('accepts an inclination past the end of the dial', () => {
    // Driving the screen off its own scale is one of the things this is for.
    const r = validateAngles({ vertikal: 120 }, BASIS);
    expect(r.ok && r.value.vertikal).toBe(120);
    const n = validateAngles({ vertikal: -5 }, BASIS);
    expect(n.ok && n.value.vertikal).toBe(-5);
  });

  it('keeps what is not sent', () => {
    const r = validateAngles({ horizontal: 90 }, { ...BASIS, vertikal: 15, running: true });
    expect(r.ok && r.value).toMatchObject({ horizontal: 90, vertikal: 15, running: true });
  });

  it('refuses a value that is not a number, in German', () => {
    const r = validateAngles({ horizontal: 'links' }, BASIS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Horizontalneigung muss eine Zahl sein/);
    expect(validateAngles({ vertikal: NaN }, BASIS).ok).toBe(false);
  });

  it('refuses an empty or wildcard topic', () => {
    expect(validateAngles({ topicHorizontal: '  ' }, BASIS).ok).toBe(false);
    expect(validateAngles({ topicHorizontal: 'rig/#' }, BASIS).ok).toBe(false);
    expect(validateAngles({ topicVertikal: 'rig/+/winkel' }, BASIS).ok).toBe(false);
  });

  it('refuses the replay control channel', () => {
    // A publish to $replay/control suppresses the kiosk's WebSocket broadcast.
    const r = validateAngles({ topicHorizontal: '$replay/control' }, BASIS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Steuerkanal/);
  });

  it('refuses both angles on one topic', () => {
    const r = validateAngles({ topicVertikal: DEFAULT_TOPIC_HORIZONTAL }, BASIS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/unterschiedliche Topics/);
  });

  it('keeps the noise within bounds', () => {
    expect(validateAngles({ rauschen: 0 }, BASIS).ok).toBe(true);
    expect(validateAngles({ rauschen: -1 }, BASIS).ok).toBe(false);
    expect(validateAngles({ rauschen: 99 }, BASIS).ok).toBe(false);
  });
});

describe('AngleSimulator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('publishes both angles on every tick once running', () => {
    const publiziert: [string, string][] = [];
    const sim = new AngleSimulator((t, p) => publiziert.push([t, p]), () => 0.5);

    sim.apply({ horizontal: 142, vertikal: 15, rauschen: 0, running: true });
    expect(publiziert).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(publiziert).toEqual([
      [DEFAULT_TOPIC_HORIZONTAL, '142'],
      [DEFAULT_TOPIC_VERTIKAL, '15'],
    ]);

    vi.advanceTimersByTime(1000);
    expect(publiziert).toHaveLength(6);
  });

  it('publishes nothing until it is started, and nothing after it stops', () => {
    const publiziert: [string, string][] = [];
    const sim = new AngleSimulator((t, p) => publiziert.push([t, p]));

    sim.apply({ horizontal: 90 });
    vi.advanceTimersByTime(2000);
    expect(publiziert).toHaveLength(0);

    sim.apply({ running: true });
    vi.advanceTimersByTime(500);
    expect(publiziert).toHaveLength(2);

    sim.apply({ running: false });
    vi.advanceTimersByTime(5000);
    expect(publiziert).toHaveLength(2);
  });

  it('does not stack timers when started twice', () => {
    const publiziert: [string, string][] = [];
    const sim = new AngleSimulator((t, p) => publiziert.push([t, p]));

    sim.apply({ running: true });
    sim.apply({ running: true, horizontal: 10 });
    vi.advanceTimersByTime(500);
    expect(publiziert).toHaveLength(2);
  });

  it('publishes a wrapped rotation, never 360 or more', () => {
    const publiziert: string[] = [];
    const sim = new AngleSimulator((_t, p) => publiziert.push(p), () => 1);

    // 359.9 plus the top of a 1° jitter would be 360.4.
    sim.apply({ horizontal: 359.9, rauschen: 1, running: true });
    vi.advanceTimersByTime(500);
    expect(Number(publiziert[0])).toBeGreaterThanOrEqual(0);
    expect(Number(publiziert[0])).toBeLessThan(360);
  });

  it('rejects an invalid update without touching the running state', () => {
    const publiziert: [string, string][] = [];
    const sim = new AngleSimulator((t, p) => publiziert.push([t, p]));

    sim.apply({ horizontal: 142, running: true });
    const r = sim.apply({ horizontal: 'nordwest' });
    expect(r.ok).toBe(false);
    expect(sim.state).toMatchObject({ running: true, horizontal: 142 });

    vi.advanceTimersByTime(500);
    expect(publiziert).toHaveLength(2);
  });
});
