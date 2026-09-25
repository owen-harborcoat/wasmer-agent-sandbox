import { defineConfig } from 'vitest/config';

// `unit` never touches Wasmer. `wasmer` runs real sandboxes, downloads registry
// packages into ./.wasmer on first use, and runs files serially so timings and
// resource probes are not skewed by parallel sandboxes. Workspace packages
// resolve to their TypeScript sources through the `wasmer-agent-sandbox-source` export condition.
export default defineConfig({
  resolve: { conditions: ['wasmer-agent-sandbox-source'] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/*.wasmer.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'wasmer',
          include: ['packages/*/test/**/*.wasmer.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
