import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Every server test runs against an in-memory database.
     *
     * Set here rather than inside a test file because db.ts opens its
     * connection at import time: a `process.env.DB_PATH` assignment in
     * `beforeAll` is too late if anything has already imported the module,
     * and a destructive test then runs against the developer's real
     * kiosk.db. That is not hypothetical — it happened.
     */
    env: { DB_PATH: ':memory:' },
  },
});
