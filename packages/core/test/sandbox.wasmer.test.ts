import { createServer } from 'node:net';
import { Wasmer, WasmerError } from '@wasmer/sdk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME,
  DEFAULT_SHELL_PACKAGE,
  SandboxPathError,
  WasmerSandbox,
} from '../src/index.js';

const PYTHON = 'python/python@=3.13.20';

describe('WasmerSandbox', () => {
  const wasmer = new Wasmer();
  let sandbox: WasmerSandbox;

  beforeAll(async () => {
    process.env.WASMER_SANDBOX_HOST_CANARY = 'host-only';
    sandbox = await WasmerSandbox.create({
      wasmer,
      files: { 'data/input.txt': 'from the host\n' },
      env: { BASE: 'base', SHARED: 'sandbox' },
    });
  });

  afterAll(async () => {
    delete process.env.WASMER_SANDBOX_HOST_CANARY;
    await sandbox.close();
    await wasmer.close();
  });

  it('returns non-zero exit statuses as results, with streams kept apart', async () => {
    const result = await sandbox.exec('echo out; echo err >&2; exit 7');

    expect(result).toMatchObject({
      exitCode: 7,
      reason: 'exited',
      stdout: 'out\n',
      stderr: 'err\n',
    });
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
  });

  it('reports a missing command as exit 127 from the shell', async () => {
    const result = await sandbox.exec('no-such-command');

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('command not found');
  });

  it('supports pipes and shell syntax', async () => {
    const result = await sandbox.exec('for w in a b c; do echo $w; done | wc -l');

    expect(result.stdout.trim()).toBe('3');
  });

  it('runs in /workspace by default, where injected files live', async () => {
    const result = await sandbox.exec('pwd; cat data/input.txt');

    expect(result.stdout).toBe('/workspace\nfrom the host\n');
  });

  it('honours cwd', async () => {
    const result = await sandbox.exec('pwd', { cwd: '/workspace/data' });

    expect(result.stdout).toBe('/workspace/data\n');
  });

  it('merges per-command env over the sandbox env and never inherits the host env', async () => {
    const result = await sandbox.exec('echo "$BASE $SHARED $EXTRA [$WASMER_SANDBOX_HOST_CANARY]"', {
      env: { SHARED: 'command', EXTRA: 'extra' },
    });

    expect(result.stdout).toBe('base command extra []\n');
  });

  it('feeds stdin when given and closes it otherwise', async () => {
    const piped = await sandbox.exec('tr a-z A-Z', { stdin: 'hello\n' });
    const closed = await sandbox.exec('cat; echo done', { timeoutMs: 10_000 });

    expect(piped.stdout).toBe('HELLO\n');
    expect(closed).toMatchObject({ reason: 'exited', stdout: 'done\n' });
  });

  it('does not hang when the guest ignores a large stdin', async () => {
    const result = await sandbox.exec('true', {
      stdin: new Uint8Array(4 * 1024 * 1024),
      timeoutMs: 20_000,
    });

    expect(result).toMatchObject({ exitCode: 0, reason: 'exited' });
  });

  it('kills commands that exceed timeoutMs', async () => {
    const result = await sandbox.exec('sleep 30', { timeoutMs: 500 });

    expect(result.reason).toBe('timeout');
    expect(result.durationMs).toBeLessThan(10_000);
  });

  // @wasmer/sdk 0.18.0: a new client's first command ignores timeoutMs while it
  // sleeps (spikes/2026-09-25-sdk-0.18-timeout). The host-side backstop covers it.
  it('enforces timeoutMs on the first command of a new client', async () => {
    const fresh = new Wasmer();
    try {
      const first = await WasmerSandbox.create({ wasmer: fresh });
      const started = performance.now();
      const result = await first.exec('sleep 5', { timeoutMs: 500 });

      expect(result.reason).toBe('timeout');
      expect(performance.now() - started).toBeLessThan(2_500);
      await first.close();
    } finally {
      await fresh.close();
    }
  });

  it('enforces timeoutMs on spawned commands, including a new client’s first', async () => {
    const fresh = new Wasmer();
    try {
      const first = await WasmerSandbox.create({ wasmer: fresh });
      const spawned = await first.spawn('sleep 5', { timeoutMs: 500 });
      const started = performance.now();

      expect(await spawned.wait()).toMatchObject({ reason: 'timeout' });
      expect(performance.now() - started).toBeLessThan(2_500);
      await first.close();
    } finally {
      await fresh.close();
    }
  });

  it('truncates each stream independently at outputBytes and says so', async () => {
    const result = await sandbox.exec('yes o | head -c 5000; yes e | head -c 10 >&2', {
      outputBytes: 1000,
    });

    expect(result.stdout).toHaveLength(1000);
    expect(result.stderr).toHaveLength(10);
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
  });

  it('terminates the guest on abort and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    setTimeout(() => controller.abort(reason), 300);
    const started = performance.now();

    await expect(sandbox.exec('sleep 30', { signal: controller.signal })).rejects.toBe(reason);
    expect(performance.now() - started).toBeLessThan(10_000);

    const after = await sandbox.exec('echo still usable');
    expect(after.stdout).toBe('still usable\n');
  });

  it('does not start a command whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      sandbox.exec('touch /workspace/should-not-exist', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const check = await sandbox.exec(
      'test -e /workspace/should-not-exist && echo ran || echo skipped',
    );
    expect(check.stdout).toBe('skipped\n');
  });

  it('runs commands concurrently within one sandbox', async () => {
    const started = performance.now();
    const results = await Promise.all([1, 2, 3, 4].map((n) => sandbox.exec(`sleep 1; echo ${n}`)));

    expect(results.map((r) => r.stdout.trim())).toEqual(['1', '2', '3', '4']);
    // Serial execution would take at least 4 s.
    expect(performance.now() - started).toBeLessThan(3_500);
  });

  it('records the exact packages it resolved and the network mode', () => {
    expect(sandbox.provenance).toEqual({
      packages: [DEFAULT_SHELL_PACKAGE.replace('@=', '@')],
      network: 'disabled',
    });
  });

  it('ends running commands on close, rejects later ones, and closes idempotently', async () => {
    const own = await WasmerSandbox.create({ wasmer });
    const running = own.exec('sleep 30');
    await new Promise((resolve) => setTimeout(resolve, 300));

    await own.close();
    await own.close();

    await expect(running).resolves.toMatchObject({ reason: 'terminated' });
    await expect(own.exec('echo late')).rejects.toSatisfy((error) =>
      WasmerError.is(error, 'SANDBOX_CLOSED'),
    );
    expect(own.closed).toBe(true);
  });

  it('keeps only /workspace between commands, and HOME inside it', async () => {
    await sandbox.exec(
      'echo keep > /workspace/kept.txt; echo lost > /tmp/lost.txt; echo home > ~/h',
    );
    const later = await sandbox.exec(
      'cat /workspace/kept.txt ~/h; test -e /tmp/lost.txt || echo gone',
    );

    expect(later.stdout).toBe('keep\nhome\ngone\n');
    expect(sandbox.home).toBe(DEFAULT_HOME);
  });

  it('reads and writes files, creating parents and resolving relative paths', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await sandbox.writeFile('nested/dir/bytes.bin', bytes);

    expect(await sandbox.readFile('/workspace/nested/dir/bytes.bin')).toEqual(bytes);
    const listed = await sandbox.exec('wc -c < nested/dir/bytes.bin');
    expect(listed.stdout.trim()).toBe('256');
  });

  it('sees files written by commands and returns null for missing files', async () => {
    await sandbox.exec('printf from-shell > shell-made.txt');

    expect(new TextDecoder().decode((await sandbox.readFile('shell-made.txt')) ?? undefined)).toBe(
      'from-shell',
    );
    expect(await sandbox.readFile('does/not/exist.txt')).toBeNull();
  });

  it('rejects file access outside /workspace instead of pretending it persists', async () => {
    await expect(sandbox.readFile('/tmp/x')).rejects.toBeInstanceOf(SandboxPathError);
    await expect(sandbox.writeFile('../etc/x', 'x')).rejects.toBeInstanceOf(SandboxPathError);
  });

  it('streams output from spawned commands while they run', async () => {
    // Gaps are wide so that a lagging reader cannot see two lines as one chunk.
    const spawned = await sandbox.spawn('for i in 1 2 3; do echo $i; sleep 1; done; echo e >&2');
    let exited = false;
    void spawned.wait().then(() => {
      exited = true;
    });
    const reader = spawned.stdout.getReader();
    const first = await reader.read();
    const firstArrivedWhileRunning = !exited;
    const [rest, stderr, exit] = await Promise.all([
      (async () => {
        let text = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text;
          text += new TextDecoder().decode(chunk.value);
        }
      })(),
      new Response(spawned.stderr).text(),
      spawned.wait(),
    ]);

    expect(new TextDecoder().decode(first.value)).toBe('1\n');
    expect(firstArrivedWhileRunning).toBe(true);
    expect(rest).toBe('2\n3\n');
    expect(stderr).toBe('e\n');
    expect(exit).toEqual({ exitCode: 0, reason: 'exited' });
    expect(spawned.pid).toBeTypeOf('number');
  });

  it('kills spawned commands idempotently', async () => {
    const spawned = await sandbox.spawn('sleep 30');
    await spawned.kill();
    await spawned.kill();

    expect(await spawned.wait()).toMatchObject({ reason: 'terminated' });
    await spawned.kill();
  });

  it('rejects wait() with the abort reason when a spawned command is aborted', async () => {
    const controller = new AbortController();
    const spawned = await sandbox.spawn('sleep 30', { signal: controller.signal });
    const reason = new Error('stop');
    controller.abort(reason);

    await expect(spawned.wait()).rejects.toBe(reason);
  });

  it('closes a client it created itself', async () => {
    const own = await WasmerSandbox.create();
    expect((await own.exec('echo owned')).stdout).toBe('owned\n');
    await own.close();
  });
});

// bash's /dev/tcp reports "Not supported" in every network mode, so it cannot
// show that the policy is enforced. Python sockets can.
describe('WasmerSandbox network default', () => {
  const wasmer = new Wasmer();
  const server = createServer((socket) => socket.end('pong\n'));
  let port = 0;
  let connections = 0;

  beforeAll(async () => {
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    port = address.port;
  });

  afterAll(async () => {
    server.close();
    await wasmer.close();
  });

  const probe = () => `import socket
try:
    socket.create_connection(("127.0.0.1", ${port}), timeout=3).recv(16)
    print("connected")
except OSError as error:
    print("blocked", error.errno)
`;

  it('blocks guest sockets unless networking is explicitly enabled', async () => {
    const sandbox = await WasmerSandbox.create({
      wasmer,
      packages: [PYTHON],
      files: { 'probe.py': probe() },
    });
    const before = connections;
    try {
      const result = await sandbox.exec('python /workspace/probe.py', { timeoutMs: 30_000 });

      expect(result.stdout).toMatch(/^blocked /);
      expect(connections).toBe(before);
      expect(sandbox.provenance.network).toBe('disabled');
    } finally {
      await sandbox.close();
    }
  });

  it('control: the same probe connects in host mode', async () => {
    const sandbox = await WasmerSandbox.create({
      wasmer,
      packages: [PYTHON],
      files: { 'probe.py': probe() },
      network: { mode: 'host' },
    });
    const before = connections;
    try {
      const result = await sandbox.exec('python /workspace/probe.py', { timeoutMs: 30_000 });

      expect(result.stdout).toBe('connected\n');
      expect(connections).toBe(before + 1);
    } finally {
      await sandbox.close();
    }
  });
});
