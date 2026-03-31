import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env from project root (parent of server/)
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
// Also try cwd in case we're already at root
dotenv.config();

const envSchema = z.object({
  // MQTT
  MQTT_BROKER_URL: z.string().url('MQTT_BROKER_URL must be a valid URL (e.g. mqtt://192.168.1.50:1883)'),
  MQTT_TOPICS: z.string().min(1, 'MQTT_TOPICS must be a comma-separated list of topics'),

  // Implenia API
  IMPLENIA_API_URL: z.string().url('IMPLENIA_API_URL must be a valid URL'),
  IMPLENIA_API_KEY: z.string().min(1, 'IMPLENIA_API_KEY is required'),

  // Updater
  GITHUB_OWNER: z.string().min(1, 'GITHUB_OWNER is required'),
  GITHUB_REPO: z.string().min(1, 'GITHUB_REPO is required'),
  UPDATE_CHECK_INTERVAL_MS: z.coerce.number().positive().default(3_500_000),

  // Server
  PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // Connectivity
  CONNECTIVITY_PROBE_HOST: z.string().default('8.8.8.8'),
  CONNECTIVITY_POLL_INTERVAL_MS: z.coerce.number().positive().default(30_000),

  // Optional GitHub token for private repos
  GITHUB_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

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
