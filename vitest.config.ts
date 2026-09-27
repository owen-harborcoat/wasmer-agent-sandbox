import { defineConfig } from 'vitest/config';

// `unit` never touches Wasmer. `wasmer` runs real sandboxes, downloads registry
// packages into ./.wasmer on first use, and runs files serially so timings and
// resource probes are not skewed by parallel sandboxes. Workspace packages
// resolve to their TypeScript sources through the `wasmer-agent-sandbox-source` export condition.
// Tests run in Vite's server (SSR) environment, which reads `ssr.resolve.conditions`; setting it
// replaces Vite's defaults, so they are repeated (Vite 8 `defaultServerConditions`). Without this,
// tests silently imported built `dist/` output and failed when it was missing.
const serverConditions = ['module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions: ['wasmer-agent-sandbox-source'] },
  ssr: { resolve: { conditions: ['wasmer-agent-sandbox-source', ...serverConditions] } },
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
          setupFiles: ['packages/core/test/keep-client-open.ts'],
          testTimeout: 180_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
