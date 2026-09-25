import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import {
  resolveSandboxDefaultWorkingDirectory,
  resolveSandboxHomeDir,
} from '@ai-sdk/harness/utils';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { SandboxPathError, WasmerSandbox } from '@owenota1337/wasmer-sandbox-core';
import { Wasmer } from '@wasmer/sdk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWasmerSandbox,
  type WasmerNetworkSandboxSession,
  WasmerSandboxSession,
} from '../src/index.js';

const decode = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

describe('WasmerSandboxProvider', () => {
  const wasmer = new Wasmer();
  afterAll(() => wasmer.close());

  it('implements the harness sandbox provider contract', async () => {
    const provider = createWasmerSandbox({ wasmer });
    const firstCreate: Experimental_SandboxSession[] = [];
    const session = await provider.createSession({
      onFirstCreate: async (restricted) => {
        firstCreate.push(restricted);
      },
    });
    try {
      expect(provider.specificationVersion).toBe('harness-sandbox-v1');
      expect(provider.providerId).toBe('wasmer-sandbox');
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.defaultWorkingDirectory).toBe('/workspace');
      expect(session.ports).toEqual([]);
      expect(firstCreate).toHaveLength(1);
      expect(firstCreate[0]).toBeInstanceOf(WasmerSandboxSession);
      expect(firstCreate[0]).not.toHaveProperty('stop');
      expect(session.restricted()).not.toHaveProperty('destroy');
    } finally {
      await session.destroy();
      await session.destroy();
    }
  });

  it('reports ports as an unsupported capability', async () => {
    const session = await createWasmerSandbox({ wasmer }).createSession();
    try {
      await expect(session.getPortEndpoint({ port: 4000 })).rejects.toSatisfy((error) =>
        HarnessCapabilityUnsupportedError.isInstance(error),
      );
    } finally {
      await session.destroy();
    }
  });

  it('closes sandboxes it creates, but never a sandbox the caller passed in', async () => {
    const created = await createWasmerSandbox({ wasmer }).createSession();
    await created.destroy();
    expect(created.sandbox.closed).toBe(true);

    const sandbox = await WasmerSandbox.create({ wasmer });
    const wrapped = await createWasmerSandbox({ sandbox }).createSession();
    await wrapped.destroy();
    expect(sandbox.closed).toBe(false);
    expect((await wrapped.run({ command: 'echo alive' })).stdout).toBe('alive\n');
    await sandbox.close();
  });

  it('destroys the sandbox when onFirstCreate fails', async () => {
    let seen: WasmerSandboxSession | undefined;
    const failure = new Error('bootstrap failed');
    const provider = createWasmerSandbox({ wasmer });

    await expect(
      provider.createSession({
        onFirstCreate: async (restricted) => {
          seen = restricted as WasmerSandboxSession;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await expect(seen?.run({ command: 'true' })).rejects.toThrow(/closed/);
  });

  it('works with the AI SDK harness helpers for HOME and working directory', async () => {
    const session = await createWasmerSandbox({ wasmer }).createSession();
    try {
      expect(await resolveSandboxHomeDir({ sandbox: session.restricted() })).toBe(
        '/workspace/.home',
      );
      expect(await resolveSandboxDefaultWorkingDirectory({ sandboxSession: session })).toBe(
        '/workspace',
      );
    } finally {
      await session.destroy();
    }
  });
});

describe('WasmerSandboxSession', () => {
  const wasmer = new Wasmer();
  let network: WasmerNetworkSandboxSession;
  let session: Experimental_SandboxSession;

  beforeAll(async () => {
    network = await createWasmerSandbox({ wasmer, env: { BASE: 'base' } }).createSession();
    session = network.restricted();
  });

  afterAll(async () => {
    await network.destroy();
    await wasmer.close();
  });

  it('describes the environment, including what persists', () => {
    expect(session.description).toContain('wasmer/bash@1.0.25');
    expect(session.description).toContain('Only files under /workspace persist');
    expect(session.description).toContain('Network access is disabled.');
  });

  describe('run', () => {
    it('returns exit code, stdout and stderr without throwing on failure', async () => {
      expect(await session.run({ command: 'echo out; echo err >&2; exit 4' })).toEqual({
        exitCode: 4,
        stdout: 'out\n',
        stderr: 'err\n',
      });
    });

    it('merges env and resolves a relative workingDirectory against /workspace', async () => {
      await session.run({ command: 'mkdir -p sub' });
      const result = await session.run({
        command: 'echo "$BASE $EXTRA $(pwd)"',
        workingDirectory: 'sub',
        env: { EXTRA: 'extra' },
      });

      expect(result.stdout).toBe('base extra /workspace/sub\n');
    });

    it('rejects with the abort reason and stops the command', async () => {
      const controller = new AbortController();
      const reason = new Error('cancelled by the agent');
      setTimeout(() => controller.abort(reason), 300);
      const started = performance.now();

      await expect(
        session.run({ command: 'sleep 30', abortSignal: controller.signal }),
      ).rejects.toBe(reason);
      expect(performance.now() - started).toBeLessThan(10_000);
    });
  });

  describe('spawn', () => {
    it('streams stdout and stderr and resolves wait() with the exit code', async () => {
      const proc = await session.spawn({ command: 'echo one; echo two >&2; exit 3' });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.wait(),
      ]);

      expect({ stdout, stderr, exit }).toEqual({
        stdout: 'one\n',
        stderr: 'two\n',
        exit: { exitCode: 3 },
      });
      expect(proc.pid).toBeTypeOf('number');
    });

    it('kills idempotently', async () => {
      const proc = await session.spawn({ command: 'sleep 30' });
      await proc.kill();
      await proc.kill();

      expect((await proc.wait()).exitCode).not.toBe(0);
    });

    it('rejects wait() with the abort reason', async () => {
      const controller = new AbortController();
      const proc = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });
      const reason = new Error('stop');
      controller.abort(reason);

      await expect(proc.wait()).rejects.toBe(reason);
    });
  });

  describe('files', () => {
    it('writes text with parent directories and reads line ranges', async () => {
      await session.writeTextFile({ path: 'notes/deep/a.txt', content: 'l1\nl2\nl3\nl4\n' });

      expect(await session.readTextFile({ path: '/workspace/notes/deep/a.txt' })).toBe(
        'l1\nl2\nl3\nl4\n',
      );
      expect(
        await session.readTextFile({ path: 'notes/deep/a.txt', startLine: 2, endLine: 3 }),
      ).toBe('l2\nl3');
      expect(
        await session.readTextFile({ path: 'notes/deep/a.txt', startLine: 3, endLine: 99 }),
      ).toBe('l3\nl4\n');
    });

    it('round-trips binary content through bytes and streams', async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await session.writeBinaryFile({ path: 'bin/a.dat', content: bytes });
      const body = new Blob([bytes]).stream();
      await session.writeFile({ path: 'bin/b.dat', content: body });

      expect(await session.readBinaryFile({ path: 'bin/b.dat' })).toEqual(bytes);
      const stream = await session.readFile({ path: 'bin/a.dat' });
      expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
    });

    it('shares one filesystem between file operations and commands', async () => {
      await session.run({ command: 'printf shell > from-shell.txt' });
      await session.writeTextFile({ path: 'from-api.txt', content: 'api' });

      expect(await session.readTextFile({ path: 'from-shell.txt' })).toBe('shell');
      expect((await session.run({ command: 'cat from-api.txt' })).stdout).toBe('api');
    });

    it('returns null for missing files', async () => {
      expect(await session.readFile({ path: 'missing.txt' })).toBeNull();
      expect(await session.readBinaryFile({ path: 'missing.txt' })).toBeNull();
      expect(await session.readTextFile({ path: 'missing.txt' })).toBeNull();
    });

    it('honours encodings and keeps a UTF-8 BOM', async () => {
      await session.writeTextFile({ path: 'latin1.txt', content: 'café', encoding: 'latin1' });
      await session.writeTextFile({ path: 'bom.txt', content: '﻿bom' });

      expect(decode(await session.readBinaryFile({ path: 'latin1.txt' }))).not.toBe('café');
      expect(await session.readTextFile({ path: 'latin1.txt', encoding: 'latin1' })).toBe('café');
      expect(await session.readTextFile({ path: 'bom.txt' })).toBe('﻿bom');
    });

    it('rejects paths outside /workspace', async () => {
      await expect(session.readTextFile({ path: '/tmp/x' })).rejects.toBeInstanceOf(
        SandboxPathError,
      );
      await expect(session.writeTextFile({ path: '/etc/x', content: 'x' })).rejects.toBeInstanceOf(
        SandboxPathError,
      );
    });
  });
});

// Keep time limits away from commands that merely have to finish: a new
// client's first pipeline takes ~400 ms on Windows, more under suite load.
describe('WasmerSandboxSession limits', () => {
  it('tells the model on stderr when a command times out', async () => {
    const session = await createWasmerSandbox({ limits: { timeoutMs: 500 } }).createSession();
    try {
      const timedOut = await session.run({ command: 'echo partial >&2; sleep 30' });

      expect(timedOut.exitCode).not.toBe(0);
      expect(timedOut.stderr).toBe('partial\n[wasmer-sandbox] command timed out and was killed\n');
    } finally {
      await session.destroy();
    }
  });

  it('tells the model on stderr when output is truncated', async () => {
    const session = await createWasmerSandbox({ limits: { outputBytes: 100 } }).createSession();
    try {
      const truncated = await session.run({ command: 'yes | head -c 1000' });

      expect(truncated).toEqual({
        exitCode: 0,
        stdout: 'y\n'.repeat(50),
        stderr: '[wasmer-sandbox] stdout was truncated\n',
      });
    } finally {
      await session.destroy();
    }
  });
});
