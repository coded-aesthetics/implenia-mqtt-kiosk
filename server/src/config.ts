import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env from project root (parent of server/)
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
// Also try cwd in case we're already at root
dotenv.config();

/**
 * Treat a blank env var (`FOO=`) as absent. A half-filled `.env` is the normal
 * state of a machine that has not been through the setup wizard yet, and an
 * empty string must not fail validation as an "invalid URL".
 *
 * **Applied to every variable, without exception.** A failed parse here calls
 * `process.exit(1)` before the logger even exists, and PM2 restarts the
 * process — so one blank line in `.env` is not a misconfiguration, it is a
 * kiosk that boot-loops on a construction site with no screen to explain
 * itself. `PORT=` alone used to do it: `Number('')` is 0, which fails
 * `.positive()`. Variables with a `.default()` fall back to it, which is the
 * behaviour a blank value should always have had.
 */
const blankAsUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const envSchema = z.object({
  // MQTT — optional. Collected by the setup wizard and stored in the `meta`
  // table; a machine that has not been set up yet must still boot far enough
  // to serve that wizard. Without a broker URL the source stays disconnected
  // (see mqtt.ts) rather than taking the process down.
  MQTT_BROKER_URL: z.preprocess(
    blankAsUndefined,
    z.string().url('MQTT_BROKER_URL must be a valid URL (e.g. mqtt://192.168.1.50:1883)').optional(),
  ),
  MQTT_TOPICS: z.preprocess(
    blankAsUndefined,
    z.string().min(1, 'MQTT_TOPICS must be a comma-separated list of topics').optional(),
  ),

  // Implenia API (optional — can be configured at runtime via /api/config)
  IMPLENIA_API_URL: z.preprocess(
    blankAsUndefined,
    z.string().url('IMPLENIA_API_URL must be a valid URL').optional(),
  ),
  IMPLENIA_API_KEY: z.preprocess(blankAsUndefined, z.string().min(1).optional()),

  // Updater — optional. These describe the software distribution, not the
  // machine, so they are baked into the release image and never typed on site.
  // When absent, GitHub polling is skipped and USB updates still work
  // (see updater.ts) — a misconfigured updater must not stop the kiosk from
  // recording data.
  GITHUB_OWNER: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
  GITHUB_REPO: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
  UPDATE_CHECK_INTERVAL_MS: z.preprocess(
    blankAsUndefined,
    z.coerce.number().positive().default(3_500_000),
  ),

  // Database. Defaults to <cwd>/kiosk.db. ':memory:' gives an ephemeral DB,
  // which is how integration tests exercise real SQL without touching a real
  // kiosk database.
  DB_PATH: z.preprocess(blankAsUndefined, z.string().min(1).optional()),

  // Server
  PORT: z.preprocess(blankAsUndefined, z.coerce.number().positive().default(3000)),
  NODE_ENV: z.preprocess(
    blankAsUndefined,
    z.enum(['development', 'production', 'test']).default('production'),
  ),

  // Connectivity
  CONNECTIVITY_PROBE_HOST: z.preprocess(blankAsUndefined, z.string().default('8.8.8.8')),
  CONNECTIVITY_POLL_INTERVAL_MS: z.preprocess(
    blankAsUndefined,
    z.coerce.number().positive().default(30_000),
  ),

  // USB update: comma-separated directories to scan for update bundles
  USB_UPDATE_PATHS: z.preprocess(blankAsUndefined, z.string().default('/media')),

  // Optional GitHub token for private repos
  // Blank must be absent, not an empty string: an empty token would still
  // produce an `Authorization: Bearer ` header on every release check.
  GITHUB_TOKEN: z.preprocess(blankAsUndefined, z.string().optional()),

  // Upload logs as string sensor readings to the Implenia platform
  LOG_SENSOR_UPLOAD: z.preprocess(blankAsUndefined, z.coerce.boolean().default(false)),
  LOG_SENSOR_LEVEL: z.preprocess(
    blankAsUndefined,
    z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('warn'),
  ),
});

export type Config = z.infer<typeof envSchema>;

/**
 * The schema, for tests.
 *
 * Exported because the module's own parse calls `process.exit(1)` on failure —
 * which is right for a boot path and impossible to assert against. A test needs
 * to hand it a hostile environment and look at the result.
 */
export const environmentSchema = envSchema;

let config: Config;

try {
  config = envSchema.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    console.error('❌ Invalid environment configuration:\n');
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  throw err;
}

export { config };
