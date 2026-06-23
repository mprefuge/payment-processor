import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.{js,ts}'],
    environment: 'node',
    restoreMocks: true,
    setupFiles: ['__tests__/setup.ts'],
    // Some suites load compiled dist bundles or run full integration flows;
    // under parallel full-suite load these regularly exceed vitest's 5s default.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
