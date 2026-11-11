import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ccd-agent-kit/config-utils': new URL('../config-utils/src/index.ts', import.meta.url).pathname,
      '@ccd-agent-kit/sdk-utils': new URL('../sdk-utils/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
