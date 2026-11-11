import { defineConfig } from 'vitest/config';

import unitConfig from './vitest.config.js';

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ['test/integration/**/*.test.ts'],
    coverage: { enabled: false },
    passWithNoTests: true,
  },
});
