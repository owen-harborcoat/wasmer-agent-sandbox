import { Wasmer } from '@wasmer/sdk/node';
import { afterAll, beforeAll } from 'vitest';
import { DEFAULT_SHELL_PACKAGE } from '../src/sandbox.js';

// Workaround, not a fix. Setup file for the `wasmer` project: keeps one client open for each test
// file. With no client open, a host kill() followed by fresh clients hangs the process on Linux
// (SDK allocator spin lock left held) or, on Node 24, crashes it in V8's wasm code GC. One client
// kept open prevented both in 6,000 repro iterations; see
// spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md. Remove it once the SDK is fixed.
let keptOpen: Wasmer | undefined;

beforeAll(async () => {
  keptOpen = new Wasmer();
  const sandbox = await keptOpen.sandboxes.create({
    packages: [DEFAULT_SHELL_PACKAGE],
    shell: 'bash',
  });
  await sandbox.shell('true').run();
});

afterAll(async () => {
  await keptOpen?.close();
});
