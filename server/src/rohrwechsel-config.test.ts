import { describe, it, expect, beforeAll } from 'vitest';

let cfg: typeof import('./rohrwechsel-config.js');

beforeAll(async () => {
  cfg = await import('./rohrwechsel-config.js');
});

/** A complete, valid submission — individual tests break one field at a time. */
const valid = {
  clampTopic: 'machine/Klemmbacke',
  depthMode: 'absolut',
  pipeLength: 2,
  closeThreshold: 100,
  openThreshold: 50,
  tolerance: 0.3,
};

describe('Rohrverlängerung settings', () => {
  it('is off until a Klemmbacke topic is configured', () => {
    expect(cfg.getRohrwechselConfig().enabled).toBe(false);
    expect(cfg.getRohrwechselConfig().clampTopic).toBeNull();
  });

  it('accepts and persists a complete configuration', () => {
    const result = cfg.validateRohrwechsel(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    cfg.setRohrwechselConfig(result.value);
    const stored = cfg.getRohrwechselConfig();
    expect(stored.enabled).toBe(true);
    expect(stored.clampTopic).toBe('machine/Klemmbacke');
    expect(stored.pipeLength).toBe(2);
  });

  it('applies a partial change on top of what is stored', () => {
    const result = cfg.validateRohrwechsel({ pipeLength: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pipeLength).toBe(3);
    expect(result.value.clampTopic).toBe('machine/Klemmbacke');
  });

  it('can be switched off again', () => {
    const result = cfg.validateRohrwechsel({ ...valid, clampTopic: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    cfg.setRohrwechselConfig(result.value);
    expect(cfg.getRohrwechselConfig().enabled).toBe(false);

    // Restore for the remaining cases.
    const back = cfg.validateRohrwechsel(valid);
    if (back.ok) cfg.setRohrwechselConfig(back.value);
  });

  it('remembers how the rig reports its depth', () => {
    const result = cfg.validateRohrwechsel({ ...valid, depthMode: 'inkrementell' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    cfg.setRohrwechselConfig(result.value);
    expect(cfg.getRohrwechselConfig().depthMode).toBe('inkrementell');

    // Restore for the remaining cases.
    const back = cfg.validateRohrwechsel(valid);
    if (back.ok) cfg.setRohrwechselConfig(back.value);
  });

  it('refuses a depth mode it does not know', () => {
    const result = cfg.validateRohrwechsel({ ...valid, depthMode: 'geschaetzt' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Bohrtiefe');
  });

  it('refuses thresholds that would flap on sensor noise', () => {
    const result = cfg.validateRohrwechsel({ ...valid, openThreshold: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // German, and it says why — a technician on site has to act on this.
    expect(result.error).toContain('Öffnungsdruck');
    expect(result.error).toContain('kleiner');
  });

  it('refuses a tolerance that would hide a missed Rohrwechsel', () => {
    const result = cfg.validateRohrwechsel({ ...valid, tolerance: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Toleranz');
  });

  it('refuses an implausible pipe length', () => {
    expect(cfg.validateRohrwechsel({ ...valid, pipeLength: 0 }).ok).toBe(false);
    const tooLong = cfg.validateRohrwechsel({ ...valid, pipeLength: 40 });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error).toContain('2 m oder 3 m');
  });

  it('refuses an empty topic, but not an explicit "off"', () => {
    const blank = cfg.validateRohrwechsel({ ...valid, clampTopic: '   ' });
    expect(blank.ok).toBe(false);
    expect(cfg.validateRohrwechsel({ ...valid, clampTopic: null }).ok).toBe(true);
  });
});

describe('clamp topic matching', () => {
  it('matches the configured topic exactly', () => {
    expect(cfg.isClampTopic('machine/Klemmbacke', 'machine/Klemmbacke')).toBe(true);
    expect(cfg.isClampTopic('MACHINE/KLEMMBACKE', 'machine/Klemmbacke')).toBe(true);
  });

  it('matches on the last segment, so serial and MQTT share one setting', () => {
    // The serial source publishes as device/<id>/<sensor name>.
    expect(cfg.isClampTopic('device/1/Klemmbacke', 'machine/Klemmbacke')).toBe(true);
  });

  it('does not match another sensor', () => {
    expect(cfg.isClampTopic('machine/Drehzahl', 'machine/Klemmbacke')).toBe(false);
  });

  it('matches nothing when handling is off', () => {
    expect(cfg.isClampTopic('machine/Klemmbacke', null)).toBe(false);
  });
});
