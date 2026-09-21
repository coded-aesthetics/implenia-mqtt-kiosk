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
    /**
     * Never collect from the build output.
     *
     * tsconfig used to compile the test files into dist/, so after a build
     * vitest ran every suite twice — once from source, once from dist — and
     * the reported test count was double the real one. The tsconfig exclude
     * stops new builds producing them; this stops a stale dist/ on someone's
     * machine from quietly doing it again.
     */
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
