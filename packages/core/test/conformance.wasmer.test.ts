import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { Wasmer, WasmerError } from '@wasmer/sdk/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WasmerSandbox } from '../src/index.js';

// Conformance v0: how the SDK and the core wrapper behave at the edges agents hit (stdin, encodings,
// big outputs, back-to-back runs, closing under load), plus the spike probes under spikes/ as tests.
// Tests that pin a known bug assert today's behaviour and name the issue, so they fail once it's fixed.

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
// Every byte value, built in the guest: `printf` turns each `\NNN` octal escape into one byte.
const PRINTF_ALL_BYTES = String.raw`printf "$(for i in $(seq 0 255); do printf '\\%03o' $i; done)"`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('conformance', () => {
  const wasmer = new Wasmer();
  let sandbox: WasmerSandbox;

  beforeAll(async () => {
    sandbox = await WasmerSandbox.create({ wasmer });
  });

  afterAll(async () => {
    await sandbox.close();
    await wasmer.close();
  });

  describe('stdin', () => {
    it('delivers a large stdin intact', async () => {
      const input = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => (i * 31 + 7) & 0xff);
      const counted = await sandbox.exec('wc -c', { stdin: input, timeoutMs: 30_000 });
      const hashed = await sandbox.exec('sha256sum', { stdin: input, timeoutMs: 30_000 });

      expect(counted.stdout.trim()).toBe(String(input.length));
      expect(hashed.stdout).toBe(`${sha256(input)}  -\n`);
    });

    it('delivers binary stdin byte for byte', async () => {
      const result = await sandbox.exec('od -An -tx1 -v', { stdin: ALL_BYTES });

      const hex = result.stdout.split(/\s+/).filter(Boolean);
      expect(hex).toEqual([...ALL_BYTES].map((b) => b.toString(16).padStart(2, '0')));
    });

    it('delivers UTF-8 stdin unchanged', async () => {
      const result = await sandbox.exec('cat', { stdin: 'héllo 世界 🎉\n' });

      expect(result.stdout).toBe('héllo 世界 🎉\n');
    });

    it('gives a partial reader the first bytes and exits cleanly', async () => {
      const input = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i & 0xff);
      const result = await sandbox.exec('head -c 4 | od -An -tx1', { stdin: input });

      expect(result).toMatchObject({ exitCode: 0, reason: 'exited' });
      expect(result.stdout.trim()).toBe('00 01 02 03');
    });

    it('lets a command that never reads stdin keep running and exit normally', async () => {
      const result = await sandbox.exec('sleep 1; echo done', {
        stdin: new Uint8Array(4 * 1024 * 1024),
        timeoutMs: 20_000,
      });

      expect(result).toMatchObject({ exitCode: 0, reason: 'exited', stdout: 'done\n' });
    });

    it('treats an empty stdin as immediate end of input', async () => {
      const result = await sandbox.exec('cat; echo "rc=$?"', { stdin: '', timeoutMs: 10_000 });

      expect(result).toMatchObject({ reason: 'exited', stdout: 'rc=0\n' });
    });
  });

  describe('output encoding', () => {
    it('decodes UTF-8 stdout and stderr exactly', async () => {
      const result = await sandbox.exec(
        String.raw`printf 'h\xc3\xa9llo \xe4\xb8\x96\xe7\x95\x8c \xf0\x9f\x8e\x89\n'; ` +
          `echo 'ünï ✓' >&2`,
      );

      expect(result.stdout).toBe('héllo 世界 🎉\n');
      expect(result.stderr).toBe('ünï ✓\n');
    });

    it('decodes invalid UTF-8 lossily instead of failing', async () => {
      const result = await sandbox.exec(String.raw`printf 'a\xffb\xfe'; printf '\xc3' >&2`);

      expect(result).toMatchObject({ exitCode: 0, stdout: 'a�b�', stderr: '�' });
    });

    it('truncates at a byte count, so a multi-byte character can be cut in half', async () => {
      // 世 is three bytes (e4 b8 96); a 3-byte limit keeps 'ab' and its first byte.
      const result = await sandbox.exec(String.raw`printf 'ab\xe4\xb8\x96cd'`, { outputBytes: 3 });

      expect(result.stdout).toBe('ab�');
      expect(result.truncated.stdout).toBe(true);
    });

    it('keeps every byte value on stdout and stderr (SDK captured bytes)', async () => {
      const output = await sandbox.sdk
        .shell(`${PRINTF_ALL_BYTES}; ${PRINTF_ALL_BYTES} >&2`)
        .run({ check: false });

      expect(output.exitCode).toBe(0);
      expect(output.stdout.bytes).toEqual(ALL_BYTES);
      expect(output.stderr.bytes).toEqual(ALL_BYTES);
    });
  });

  describe('large and interleaved output', () => {
    it('keeps a large stderr whole when it fits the limit', async () => {
      const result = await sandbox.exec(String.raw`head -c 524288 /dev/zero | tr '\0' e >&2`);

      expect(result).toMatchObject({ exitCode: 0, stdout: '' });
      expect(result.stderr).toBe('e'.repeat(524_288));
      expect(result.truncated.stderr).toBe(false);
    });

    it('truncates a large stderr at the default 1 MiB and lets the command finish', async () => {
      const result = await sandbox.exec(
        String.raw`head -c 2097152 /dev/zero | tr '\0' e >&2; echo finished`,
      );

      expect(result).toMatchObject({ exitCode: 0, reason: 'exited', stdout: 'finished\n' });
      expect(result.stderr).toBe('e'.repeat(1024 * 1024));
      expect(result.truncated).toEqual({ stdout: false, stderr: true });
    });

    it('drains large stdout and stderr written at the same time', async () => {
      const result = await sandbox.exec(
        String.raw`head -c 3000000 /dev/zero | tr '\0' o & ` +
          String.raw`head -c 3000000 /dev/zero | tr '\0' e >&2; wait`,
        { outputBytes: 4_000_000, timeoutMs: 30_000 },
      );

      expect(result).toMatchObject({ exitCode: 0, reason: 'exited' });
      expect(result.stdout).toBe('o'.repeat(3_000_000));
      expect(result.stderr).toBe('e'.repeat(3_000_000));
    });

    it('keeps each stream in order when writes alternate between them', async () => {
      const result = await sandbox.exec(
        'for i in $(seq 1 2000); do echo "out $i"; echo "err $i" >&2; done',
      );
      const lines = (prefix: string) =>
        Array.from({ length: 2000 }, (_, i) => `${prefix} ${i + 1}\n`).join('');

      expect(result.stdout).toBe(lines('out'));
      expect(result.stderr).toBe(lines('err'));
    });
  });

  describe('rapid sequential runs', () => {
    it('runs 100 commands back to back in one sandbox', async () => {
      for (let i = 0; i < 100; i++) {
        const result = await sandbox.exec(`echo ${i}`);
        expect(result).toMatchObject({ exitCode: 0, reason: 'exited', stdout: `${i}\n` });
      }
    });

    it('creates, uses and closes 20 sandboxes in a row on one client', async () => {
      for (let i = 0; i < 20; i++) {
        const own = await WasmerSandbox.create({ wasmer, files: { 'n.txt': String(i) } });
        try {
          expect((await own.exec('cat n.txt')).stdout).toBe(String(i));
        } finally {
          await own.close();
        }
      }
    });

    it('stays usable after several timeouts in a row', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await sandbox.exec('sleep 30', { timeoutMs: 300 });
        expect(result.reason).toBe('timeout');
      }
      expect((await sandbox.exec('echo ok')).stdout).toBe('ok\n');
    });
  });

  describe('close while running', () => {
    it('ends a streaming command and its output stream', async () => {
      const own = await WasmerSandbox.create({ wasmer });
      const spawned = await own.spawn('while :; do echo tick; sleep 0.1; done');
      const stdout = new Response(spawned.stdout).text();
      const stderr = new Response(spawned.stderr).text();
      await sleep(500);

      await own.close();

      expect(await spawned.wait()).toMatchObject({ reason: 'terminated' });
      expect(await stdout).toMatch(/^(tick\n)+$/);
      await stderr;
    });

    it('ends every running command', async () => {
      const own = await WasmerSandbox.create({ wasmer });
      const running = [1, 2, 3].map((n) => own.exec(`sleep 30; echo ${n}`));
      await sleep(500);

      await own.close();

      const results = await Promise.all(running);
      expect(results.map((r) => r.reason)).toEqual(['terminated', 'terminated', 'terminated']);
      expect(results.map((r) => r.stdout)).toEqual(['', '', '']);
    });

    it('ends a command whose stdin is still being written', async () => {
      const own = await WasmerSandbox.create({ wasmer });
      const running = own.exec('sleep 30', { stdin: new Uint8Array(8 * 1024 * 1024) });
      await sleep(500);

      await own.close();

      await expect(running).resolves.toMatchObject({ reason: 'terminated' });
    });
  });

  // From spikes/2026-09-24-sdk-0.18-process and spikes/2026-09-25-sdk-0.18-fs.
  describe('process and environment probes', () => {
    it('reports a kill as exit 137, terminated', async () => {
      const spawned = await sandbox.spawn('sleep 30');
      await sleep(200);
      await spawned.kill();

      expect(await spawned.wait()).toEqual({ exitCode: 137, reason: 'terminated' });
    });

    // terminate() delivers SIGTERM and the guest's trap runs, but wait() reports 143 no matter
    // what status the trap exits with. A guest can clean up but cannot report how it went.
    it('runs a SIGTERM trap on terminate(), then reports 143 instead of its status', async () => {
      const guest = await sandbox.sdk
        .shell(`trap 'echo trapped; exit 3' TERM; while :; do sleep 0.1; done`)
        .spawn({ stdout: 'capture', stderr: 'capture' });
      await sleep(300);
      await guest.terminate({ gracePeriodMs: 5_000 });
      const output = await guest.wait();

      expect(output.stdout.text()).toBe('trapped\n');
      expect(output).toMatchObject({ exitCode: 143, reason: 'terminated' });
    });

    // @wasmer/sdk 0.18.0 wrote the runtime lines from wasmerio/wasmer-sdk#540 (`Program recieved
    // termination signal`, then `fatal signal: Aborted` ×30) into a terminated guest's stderr: every
    // run on Windows 11, most runs on the Linux runners. 0.19.0 doesn't.
    it('keeps runtime signal lines out of a terminated guest’s stderr', async () => {
      const guest = await sandbox.sdk
        .shell('sleep 30')
        .spawn({ stdout: 'capture', stderr: 'capture' });
      await sleep(300);
      await guest.terminate({ gracePeriodMs: 5_000 });
      const output = await guest.wait();

      expect(output).toMatchObject({ exitCode: 143, reason: 'terminated' });
      expect(output.stderr.text()).toBe('');
    });

    // Deliberately not tested here: a guest that SIGTERMs itself (`kill -TERM $$`) exits 27, and
    // within a few repeats the SDK crashes the host process or hangs it, which would take the whole
    // suite down. On 0.19.0 a child that does it (`sh -c 'kill -TERM $$'`) is enough. See
    // spikes/2026-10-06-sdk-0.18-guest-signals.

    it('leaves USER unset and puts the working directory on PATH', async () => {
      const result = await sandbox.exec('printenv USER || echo unset; echo "$PATH"');

      expect(result.stdout).toBe(
        'unset\n/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.\n',
      );
    });

    it('ships the tools the shell package is pinned for, and not git or which', async () => {
      const result = await sandbox.exec(
        'for c in sh realpath base64 sha256sum od tr head seq uname which git; do ' +
          'command -v $c >/dev/null && echo "$c yes" || echo "$c no"; done',
      );

      expect(result.stdout).toBe(
        'sh yes\nrealpath yes\nbase64 yes\nsha256sum yes\nod yes\ntr yes\nhead yes\nseq yes\n' +
          'uname yes\nwhich no\ngit no\n',
      );
      expect((await sandbox.exec('sh -c "echo via sh"')).stdout).toBe('via sh\n');
    });
  });

  describe('filesystem API probes', () => {
    // Unfiled (upstream-drafts 04): a missing file has no error code of its own, so the core
    // matches the message text. This fails once a distinct code exists; update isNotFound then.
    it('reports a missing file as FILESYSTEM_ERROR with "entry not found", not a distinct code', async () => {
      await expect(sandbox.sdk.fs.readFile('/workspace/missing.txt')).rejects.toSatisfy(
        (error) =>
          WasmerError.is(error, 'FILESYSTEM_ERROR') &&
          /entry not found/.test((error as Error).message),
      );
    });

    // Not filed. SandboxFileSystem wraps each call as `rethrow(this.#core.x(...))`, but stat, readDir,
    // mkdir and remove are synchronous in the core, so they throw before rethrow can convert the
    // error. Callers get a plain Error named WasmerError that WasmerError.is() rejects.
    it('rejects sync filesystem calls with a plain Error that WasmerError.is() misses', async () => {
      const fs = sandbox.sdk.fs;
      const failures = [
        fs.stat('/workspace/missing.txt'),
        fs.readDir('/workspace/missing'),
        fs.mkdir('/workspace/missing/child'),
        fs.remove('/workspace/missing.txt'),
      ];
      for (const failure of failures) {
        const error = await failure.then(
          () => undefined,
          (rejected: unknown) => rejected,
        );
        expect(error).toMatchObject({ name: 'WasmerError', code: 'FILESYSTEM_ERROR' });
        expect(WasmerError.is(error)).toBe(false);
      }
      // Control: async core calls go through the conversion.
      await expect(fs.readFile('/workspace/missing.txt')).rejects.toBeInstanceOf(WasmerError);
    });

    it('rejects reading a directory as a file instead of returning null', async () => {
      await expect(sandbox.readFile('/workspace')).rejects.toSatisfy((error) =>
        WasmerError.is(error, 'FILESYSTEM_ERROR'),
      );
    });

    it('rejects SDK file paths outside /workspace with INVALID_PATH', async () => {
      await expect(sandbox.sdk.fs.writeFile('/tmp/x', 'x')).rejects.toSatisfy((error) =>
        WasmerError.is(error, 'INVALID_PATH'),
      );
    });

    it('creates missing parent directories in SDK writeFile', async () => {
      await sandbox.sdk.fs.writeFile('/workspace/sdk/a/b.txt', 'nested');

      expect((await sandbox.exec('cat /workspace/sdk/a/b.txt')).stdout).toBe('nested');
    });
  });

  // spikes/2026-09-25-sdk-0.18-timeout. The core's host-side backstop hides this from its callers
  // (sandbox.wasmer.test.ts); this pins the SDK's own deadline so the backstop can go once it's fixed.
  it('lets a new client’s first command overrun timeoutMs while it sleeps (wasmerio/wasmer-sdk#539)', async () => {
    const fresh = new Wasmer();
    try {
      const first = await WasmerSandbox.create({ wasmer: fresh });
      const started = performance.now();
      await first.sdk.shell('sleep 3').run({ check: false, timeoutMs: 500 });
      const elapsed = performance.now() - started;
      await first.close();

      // On time would be ~600 ms. The deadline lands only when `sleep 3` returns.
      expect(elapsed).toBeGreaterThan(2_500);
    } finally {
      await fresh.close();
    }
  });
});

// spikes/2026-09-24-sdk-0.18-process. A loopback listener owned by the test shows what bash's
// /dev/tcp actually does under each network policy.
describe('conformance: bash /dev/tcp', () => {
  const wasmer = new Wasmer();
  // bash leaves its socket half used, so the guest side can reset it (ECONNRESET in stress run
  // 37558335759). That's the guest's business, not a test failure.
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.end('pong\n');
  });
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

  const probe = () => `exec 3<>/dev/tcp/127.0.0.1/${port} && head -n 1 <&3 || echo failed`;

  it('refuses to connect when networking is disabled', async () => {
    const sandbox = await WasmerSandbox.create({ wasmer });
    const before = connections;
    try {
      const result = await sandbox.exec(probe());

      expect(result.stdout).toBe('failed\n');
      expect(result.stderr).toContain('connect: Not supported');
      expect(connections).toBe(before);
    } finally {
      await sandbox.close();
    }
  });

  // Not filed. In host mode the connection reaches the host, but bash can't use the socket, so
  // /dev/tcp is no use to agents in either mode. Python sockets work (sandbox.wasmer.test.ts).
  it('connects in host mode but cannot read or write the socket', async () => {
    const sandbox = await WasmerSandbox.create({ wasmer, network: { mode: 'host' } });
    const before = connections;
    try {
      const result = await sandbox.exec(probe());

      expect(result.stdout).toBe('failed\n');
      expect(result.stderr).toContain(`/dev/tcp/127.0.0.1/${port}: Not supported`);
      await vi.waitFor(() => expect(connections).toBe(before + 1));
    } finally {
      await sandbox.close();
    }
  });
});
