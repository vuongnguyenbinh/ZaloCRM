import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          globals: false,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globals: false,
          // Testcontainers needs more time to spin up
          testTimeout: 90_000,
          hookTimeout: 90_000,
          // Run integration tests serially in a single fork so all test files
          // share one Postgres container (faster + avoids port races).
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
  },
});
