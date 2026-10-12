// The top-level command's own stdio, as the guest sees it, when the host captures it.
// The host feeds stdin or leaves it closed and captures stdout/stderr, so no fd is a terminal.
//
// Run from the repo root: node spikes/2026-10-11-edgejs-in-sdk/top-level-tty.mjs
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache });

const wasmer = new Wasmer();
const run = async (name, packages, cmd, args, opts = {}) => {
  const sandbox = await wasmer.sandboxes.create({ packages, network: { mode: 'disabled' } });
  try {
    const out = await sandbox.command(cmd, args).run({ check: false, timeoutMs: 30000, ...opts });
    log({ name, exit: out.exitCode, stdout: (await out.stdout.text()).trim(), stderr: (await out.stderr.text()).trim().slice(0, 300) });
  } finally {
    await sandbox.close();
  }
};

await run('bash [ -t ] on 0 1 2', ['wasmer/bash@=1.0.25'], 'bash', ['-c', 'for fd in 0 1 2; do [ -t $fd ] && echo "$fd tty" || echo "$fd no"; done']);
await run('python isatty()', ['python/python@=3.13.20'], 'python', ['-c', 'import sys; print([f.isatty() for f in (sys.stdin, sys.stdout, sys.stderr)])']);
await run('python - with host stdin', ['python/python@=3.13.20'], 'python', ['-'], { stdin: 'print(6 * 7)\n' });
await run('python fstat modes', ['python/python@=3.13.20'], 'python', ['-c', 'import os; print([oct(os.fstat(fd).st_mode) for fd in (0, 1, 2)])']);
await run('edge process.stdout', ['wasmer/edgejs'], 'node', ['-e', 'console.log(JSON.stringify({ isTTY: process.stdout.isTTY, mode: require("fs").fstatSync(1).mode.toString(8) }))']);
await wasmer.close();
