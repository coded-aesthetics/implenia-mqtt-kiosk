import { describe, it, expect, afterEach } from 'vitest';
import { SimulatorSource, type DeviceFrame } from './simulator-source.js';

describe('SimulatorSource', () => {
  let source: SimulatorSource;

  afterEach(() => {
    source?.stop();
  });

  it('emits frames with 15 finite values', async () => {
    source = new SimulatorSource(1);
    const frames: DeviceFrame[] = [];

    source.on('frame', (f: DeviceFrame) => frames.push(f));
    source.start();

    await new Promise((r) => setTimeout(r, 1200));
    source.stop();

    expect(frames.length).toBeGreaterThanOrEqual(2);

    for (const frame of frames) {
      expect(frame.deviceId).toBe(1);
      expect(frame.values).toHaveLength(15);
      for (const v of frame.values) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(frame.receivedAt).toBeGreaterThan(0);
    }
  });

  it('reports connected state', () => {
    source = new SimulatorSource(42);
    expect(source.connected).toBe(false);

    source.start();
    expect(source.connected).toBe(true);

    source.stop();
    expect(source.connected).toBe(false);
  });

  it('does not emit after stop', async () => {
    source = new SimulatorSource(1);
    const frames: DeviceFrame[] = [];

    source.on('frame', (f: DeviceFrame) => frames.push(f));
    source.start();

    await new Promise((r) => setTimeout(r, 600));
    source.stop();
    const countAtStop = frames.length;

    await new Promise((r) => setTimeout(r, 600));
    expect(frames.length).toBe(countAtStop);
  });
});
