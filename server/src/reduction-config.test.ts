import { describe, it, expect, beforeEach } from 'vitest';
import { databasePath, deleteMeta, setMeta } from './db.js';
import {
  DEFAULTS, GRANULARITIES, GRID_OFF, UPLOAD_MODES,
  getReductionConfig, holdMsFor, isUploadMode, setReductionConfig, validateReduction,
} from './reduction-config.js';

// This suite clears meta rows. See CLAUDE.md: a destructive suite asserts it is
// not pointed at a real database before it runs.
beforeEach(() => {
  expect(databasePath()).toBe(':memory:');
  deleteMeta('reduce_export_bucket_ms');
  deleteMeta('reduce_upload_bucket_ms');
  deleteMeta('reduce_upload_mode');
});

describe('getReductionConfig', () => {
  it('reduces to one second and uploads as CSV by default', () => {
    expect(getReductionConfig()).toEqual({
      exportBucketMs: 1000,
      uploadBucketMs: 1000,
      uploadMode: 'csv',
    });
  });

  it('round-trips what was saved', () => {
    setReductionConfig({ exportBucketMs: 5000, uploadBucketMs: 2000, uploadMode: 'sensor' });
    expect(getReductionConfig()).toEqual({
      exportBucketMs: 5000, uploadBucketMs: 2000, uploadMode: 'sensor',
    });
  });

  it('falls back to the defaults on a stored value it cannot use', () => {
    // Whatever a half-finished migration or a hand-edited row leaves behind,
    // the kiosk must still upload.
    setMeta('reduce_upload_bucket_ms', 'elf');
    setMeta('reduce_upload_mode', 'telepathie');
    expect(getReductionConfig().uploadBucketMs).toBe(DEFAULTS.uploadBucketMs);
    expect(getReductionConfig().uploadMode).toBe(DEFAULTS.uploadMode);
  });
});

describe('holdMsFor', () => {
  it('never holds less than four seconds', () => {
    // The captured rig's pumps publish every ~3 s, so a 1 s grid with a
    // shorter hold would report them as failing twice a second.
    expect(holdMsFor(1000)).toBe(4000);
    expect(holdMsFor(500)).toBe(4000);
  });

  it('scales with a coarse grid', () => {
    expect(holdMsFor(10_000)).toBe(40_000);
  });
});

describe('validateReduction', () => {
  it('accepts the grids the screen offers', () => {
    for (const { ms } of GRANULARITIES) {
      const result = validateReduction({ exportBucketMs: ms });
      expect(result.ok, `export at ${ms} ms`).toBe(true);
    }
  });

  it('leaves out what was not submitted', () => {
    setReductionConfig({ exportBucketMs: 2000, uploadBucketMs: 5000, uploadMode: 'sensor' });
    const result = validateReduction({ exportBucketMs: 1000 });
    expect(result.ok && result.value).toEqual({
      exportBucketMs: 1000, uploadBucketMs: 5000, uploadMode: 'sensor',
    });
  });

  it('refuses a CSV upload with no grid, naming the way out', () => {
    // Ungridded, every row carries one value and thirteen empty cells — and an
    // empty cell inserts a NULL, which is this kiosk's outage marker.
    const result = validateReduction({ uploadMode: 'csv', uploadBucketMs: GRID_OFF });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(UPLOAD_MODES.sensor);
  });

  it('allows no grid on the per-sensor path', () => {
    const result = validateReduction({ uploadMode: 'sensor', uploadBucketMs: GRID_OFF });
    expect(result.ok).toBe(true);
  });

  it('allows a full-resolution export whatever the upload does', () => {
    const result = validateReduction({ exportBucketMs: GRID_OFF });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.exportBucketMs).toBe(GRID_OFF);
  });

  it('refuses a grid so coarse the bore profile disappears', () => {
    const result = validateReduction({ exportBucketMs: 120_000 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Sekunden/);
  });

  it('refuses a negative or unreadable grid', () => {
    expect(validateReduction({ uploadBucketMs: -1000 }).ok).toBe(false);
    expect(validateReduction({ uploadBucketMs: NaN }).ok).toBe(false);
  });

  it('refuses an upload route it does not have', () => {
    const result = validateReduction({ uploadMode: 'brieftaube' });
    expect(result.ok).toBe(false);
  });

  it('answers in German', () => {
    const errors = [
      validateReduction({ uploadBucketMs: -1 }),
      validateReduction({ uploadMode: 'brieftaube' }),
      validateReduction({ uploadMode: 'csv', uploadBucketMs: 0 }),
      validateReduction({ exportBucketMs: 999_999 }),
    ];
    for (const e of errors) {
      expect(e.ok).toBe(false);
      expect(!e.ok && e.error).toMatch(/[äöüßA-Z]/);
      expect(!e.ok && e.error).toMatch(/Bitte|muss|ist zu grob/);
    }
  });
});

describe('isUploadMode', () => {
  it('knows the two routes and nothing else', () => {
    expect(isUploadMode('csv')).toBe(true);
    expect(isUploadMode('sensor')).toBe(true);
    expect(isUploadMode('toString')).toBe(false);
  });
});
