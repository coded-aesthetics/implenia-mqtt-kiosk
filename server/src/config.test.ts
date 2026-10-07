import { describe, it, expect } from 'vitest';
import { environmentSchema } from './config.js';

/**
 * A blank line in `.env` must never stop the kiosk booting.
 *
 * `config.ts` parses the environment before the logger exists and calls
 * `process.exit(1)` if anything fails. PM2 restarts the process, so a single
 * `PORT=` in `.env` is not a misconfiguration — it is a kiosk that boot-loops
 * on a construction site with nothing on screen to explain why. Several
 * variables used to do exactly that:
 *
 * - `PORT=`      → `Number('')` is 0, which fails `.positive()`
 * - `NODE_ENV=`  → not a member of the enum
 * - `IMPLENIA_API_URL=` → "must be a valid URL", on the one variable the
 *   setup wizard is explicitly meant to fill in at runtime
 *
 * These tests pin "blank means absent" for every variable, not just the ones
 * that happened to have the guard.
 */

/** Every variable, blank — the worst plausible `.env`. */
const ALL_BLANK: Record<string, string> = {
  MQTT_BROKER_URL: '',
  MQTT_TOPICS: '',
  IMPLENIA_API_URL: '',
  IMPLENIA_API_KEY: '',
  GITHUB_OWNER: '',
  GITHUB_REPO: '',
  GITHUB_TOKEN: '',
  UPDATE_CHECK_INTERVAL_MS: '',
  DB_PATH: '',
  PORT: '',
  NODE_ENV: '',
  CONNECTIVITY_PROBE_HOST: '',
  CONNECTIVITY_POLL_INTERVAL_MS: '',
  USB_UPDATE_PATHS: '',
  LOG_SENSOR_UPLOAD: '',
  LOG_SENSOR_LEVEL: '',
};

describe('environment parsing', () => {
  it('accepts an entirely blank environment', () => {
    const result = environmentSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts every variable present but blank', () => {
    const result = environmentSchema.safeParse(ALL_BLANK);
    const issues = result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(issues, `a blank .env must not stop the kiosk booting`).toEqual([]);
  });

  it('falls back to the defaults for blank values rather than to zero or empty', () => {
    const cfg = environmentSchema.parse(ALL_BLANK);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.CONNECTIVITY_PROBE_HOST).toBe('8.8.8.8');
    expect(cfg.USB_UPDATE_PATHS).toBe('/media');
    expect(cfg.LOG_SENSOR_LEVEL).toBe('warn');
    expect(cfg.LOG_SENSOR_UPLOAD).toBe(false);
    expect(cfg.CONNECTIVITY_POLL_INTERVAL_MS).toBe(30_000);
    expect(cfg.UPDATE_CHECK_INTERVAL_MS).toBe(3_500_000);
  });

  it('treats a blank optional as absent, not as an empty string', () => {
    const cfg = environmentSchema.parse(ALL_BLANK);
    // An empty API url would make getApiConfig() believe it is configured; an
    // empty token would still send an `Authorization: Bearer ` header.
    expect(cfg.IMPLENIA_API_URL).toBeUndefined();
    expect(cfg.IMPLENIA_API_KEY).toBeUndefined();
    expect(cfg.GITHUB_TOKEN).toBeUndefined();
    expect(cfg.DB_PATH).toBeUndefined();
    expect(cfg.MQTT_BROKER_URL).toBeUndefined();
  });

  it('treats whitespace as blank', () => {
    const cfg = environmentSchema.parse({ PORT: '   ', IMPLENIA_API_URL: '  ' });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.IMPLENIA_API_URL).toBeUndefined();
  });

  it('still reads real values', () => {
    const cfg = environmentSchema.parse({
      PORT: '8080',
      NODE_ENV: 'development',
      IMPLENIA_API_URL: 'https://example.test',
      IMPLENIA_API_KEY: 'secret',
      MQTT_BROKER_URL: 'mqtt://10.0.0.5:1883',
      DB_PATH: ':memory:',
      LOG_SENSOR_LEVEL: 'error',
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.IMPLENIA_API_URL).toBe('https://example.test');
    expect(cfg.IMPLENIA_API_KEY).toBe('secret');
    expect(cfg.MQTT_BROKER_URL).toBe('mqtt://10.0.0.5:1883');
    expect(cfg.DB_PATH).toBe(':memory:');
    expect(cfg.LOG_SENSOR_LEVEL).toBe('error');
  });

  it('still rejects a value that is present and wrong', () => {
    // Blank is forgiving; nonsense is not. A typo must still be reported
    // rather than silently replaced by a default.
    expect(environmentSchema.safeParse({ IMPLENIA_API_URL: 'not-a-url' }).success).toBe(false);
    expect(environmentSchema.safeParse({ PORT: '-1' }).success).toBe(false);
    expect(environmentSchema.safeParse({ NODE_ENV: 'produktion' }).success).toBe(false);
    expect(environmentSchema.safeParse({ LOG_SENSOR_LEVEL: 'verbose' }).success).toBe(false);
  });
});
