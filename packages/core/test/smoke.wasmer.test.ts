import { Wasmer } from '@wasmer/sdk/node';
import { afterAll, describe, expect, it } from 'vitest';

// Real Wasmer execution: proves the SDK loads its workers from pnpm's
// symlinked node_modules layout and can run a shell string.
describe('Wasmer SDK smoke', () => {
  const wasmer = new Wasmer();
  afterAll(() => wasmer.close());

  it('runs a shell string through wasmer/bash with networking disabled', async () => {
    const sandbox = await wasmer.sandboxes.create({
      packages: ['wasmer/bash'],
      shell: 'bash',
      network: { mode: 'disabled' },
    });
    try {
      const output = await sandbox.shell('echo hello; echo oops >&2; exit 3').run({ check: false });

      expect(output.reason).toBe('exited');
      expect(output.exitCode).toBe(3);
      expect(output.stdout.text()).toBe('hello\n');
      expect(output.stderr.text()).toBe('oops\n');
    } finally {
      await sandbox.close();
    }
  });
});
