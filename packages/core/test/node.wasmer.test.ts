import { createServer } from 'node:net';
import { Wasmer } from '@wasmer/sdk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NODE_PACKAGE, WasmerSandbox } from '../src/index.js';

// Node guests through Edge.js (NODE_PACKAGE). Tests that pin a known bug assert today's behaviour
// and name the issue, so they fail once it's fixed. Evidence: spikes/2026-10-11-edgejs-in-sdk.

const files = {
  'esm/main.mjs': 'import { add } from "./lib.mjs"; console.log(add(2, 3));',
  'esm/lib.mjs': 'export const add = (a, b) => a + b;',
  'cjs/main.js': 'const { twice } = require("./lib"); console.log(twice(21));',
  'cjs/lib.js': 'exports.twice = (n) => n * 2;',
  'stdin.js':
    'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => console.log(JSON.stringify(d)));',
  'log.js': 'console.log(7)',
};

describe('Node guests (Edge.js)', () => {
  const wasmer = new Wasmer();
  let sandbox: WasmerSandbox;

  beforeAll(async () => {
    sandbox = await WasmerSandbox.create({ wasmer, packages: [NODE_PACKAGE], files });
  }, 120_000);

  afterAll(async () => {
    await sandbox.close();
    await wasmer.close();
  });

  it('runs node as Node 24 on WASI', async () => {
    const result = await sandbox.exec(`node -e 'console.log(process.version, process.platform)'`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v24\.\d+\.\d+ wasi\n$/);
    expect(sandbox.provenance.packages).toContain(NODE_PACKAGE.replace('@=', '@'));
  });

  it('loads ES modules and CommonJS from the workspace', async () => {
    const esm = await sandbox.exec('node esm/main.mjs');
    const cjs = await sandbox.exec('node cjs/main.js');

    expect(esm.stdout).toBe('5\n');
    expect(cjs.stdout).toBe('42\n');
  });

  it('keeps files node writes under /workspace for later commands', async () => {
    await sandbox.exec(
      `node -e 'require("fs").mkdirSync("out", { recursive: true }); require("fs").writeFileSync("out/n.json", JSON.stringify({ n: 1 }))'`,
    );

    expect(new TextDecoder().decode((await sandbox.readFile('out/n.json')) ?? undefined)).toBe(
      '{"n":1}',
    );
    expect((await sandbox.exec('cat out/n.json')).stdout).toBe('{"n":1}');
  });

  it('returns exit codes and uncaught errors as results', async () => {
    const exited = await sandbox.exec(`node -e 'process.exit(3)'`);
    const thrown = await sandbox.exec(`node -e 'throw new Error("boom")'`);

    expect(exited).toMatchObject({ exitCode: 3, reason: 'exited' });
    expect(thrown).toMatchObject({ exitCode: 1, reason: 'exited' });
    expect(thrown.stderr).toContain('Error: boom');
  });

  it('feeds host stdin to a node script', async () => {
    const result = await sandbox.exec('node stdin.js', { stdin: 'hello\n' });

    expect(result.stdout).toBe('"hello\\n"\n');
  });

  it('passes cwd and env to node', async () => {
    await sandbox.writeFile('sub/.keep', '');
    const result = await sandbox.exec(`node -e 'console.log(process.cwd(), process.env.FOO)'`, {
      cwd: 'sub',
      env: { FOO: 'bar' },
    });

    expect(result.stdout).toBe('/workspace/sub bar\n');
  });

  it('runs npm', async () => {
    const result = await sandbox.exec('npm --version', { timeoutMs: 60_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  // Not tested here: a busy loop (`for (;;) {}`, or one calling fs.statSync) reports `timeout` and
  // exit 137, but the guest keeps a core busy and `Wasmer.close()` never resolves, which would hang
  // this file. Same for Python. Only guests that block are stopped (spikes/2026-10-11-edgejs-in-sdk,
  // busy-loop.mjs). This one sleeps.
  it('stops a sleeping node process at the time limit', async () => {
    const result = await sandbox.exec(`node -e 'setTimeout(() => {}, 60000)'`, {
      timeoutMs: 1_000,
    });

    expect(result.reason).toBe('timeout');
    expect(result.durationMs).toBeLessThan(15_000);
  });

  it('terminates node on abort and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    setTimeout(() => controller.abort(reason), 1_000);

    await expect(
      sandbox.exec(`node -e 'setTimeout(() => {}, 60000)'`, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  // Known bug, pinned: inside the guest an Edge.js process whose stdout or stdin is a pipe gets
  // Node's no-op stream, because WASIX pipes stat as st_mode 0 (wasmerio/edgejs#166,
  // wasmerio/wasmer#7092). Output is dropped with exit 0. fs.writeSync(1) gets through.
  it('drops node output that goes into a pipe inside the guest (wasmerio/edgejs#166)', async () => {
    const result = await sandbox.exec(
      'node log.js | cat; x=$(node log.js); echo "captured=[$x]"; ' +
        'echo hi | node stdin.js; ' +
        `node -e 'require("fs").writeSync(1, "via-fd\\n")' | cat`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('captured=[]\n""\nvia-fd\n');
  });

  // Known bug, pinned: the command's own stdio says it's a terminal although the host captures it
  // (wasmerio/wasmer-sdk#555, the rest of wasmerio/wasmer#6425).
  it('reports its own stdout as a terminal (wasmerio/wasmer-sdk#555)', async () => {
    const result = await sandbox.exec(`node -e 'console.log(process.stdout.isTTY)'`);

    expect(result.stdout).toBe('true\n');
  });
});

describe('Node guest network policy', () => {
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

  const probe = () => `const socket = require("net").connect(${port}, "127.0.0.1");
socket.setTimeout(3000, () => { console.log("timeout"); socket.destroy(); });
socket.on("data", (d) => { console.log("connected", String(d).trim()); socket.destroy(); });
socket.on("error", (e) => console.log("blocked", e.code));
`;

  it('blocks node sockets unless networking is explicitly enabled', async () => {
    const sandbox = await WasmerSandbox.create({
      wasmer,
      packages: [NODE_PACKAGE],
      files: { 'probe.js': probe() },
    });
    const before = connections;
    try {
      const result = await sandbox.exec('node /workspace/probe.js', { timeoutMs: 30_000 });

      expect(result.stdout).toMatch(/^blocked /);
      expect(connections).toBe(before);
    } finally {
      await sandbox.close();
    }
  });

  it('control: the same probe connects in host mode', async () => {
    const sandbox = await WasmerSandbox.create({
      wasmer,
      packages: [NODE_PACKAGE],
      files: { 'probe.js': probe() },
      network: { mode: 'host' },
    });
    const before = connections;
    try {
      const result = await sandbox.exec('node /workspace/probe.js', { timeoutMs: 30_000 });

      expect(result.stdout).toBe('connected pong\n');
      expect(connections).toBe(before + 1);
    } finally {
      await sandbox.close();
    }
  });
});
