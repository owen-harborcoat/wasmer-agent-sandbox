// Probe: which Node releases can start a Python guest? python/python@=3.13.20 fails on Node
// 22.14.0 and 22.15.0 with `compile error: Validate("Unknown validation error")` and works on
// 22.23.2 and 24.21.0, while @wasmer/sdk declares node >=20. bash is the control.
// CI runs this across Node releases (.github/workflows/node-matrix.yml). Always exits 0.
//
// Run from the repo root: node spikes/2026-09-25-node22-python/probe.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

async function probe(wasmer, pkg, program, args) {
  const started = performance.now();
  let sandbox;
  try {
    sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
    const output = await sandbox.command(program, args).run({ check: false, timeoutMs: 60_000 });
    return {
      pkg,
      ok: output.exitCode === 0,
      exitCode: output.exitCode,
      stdout: output.stdout.text().trim(),
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { pkg, ok: false, code: error.code ?? null, error: String(error.message).split('\n')[0] };
  } finally {
    await sandbox?.close();
  }
}

const wasmer = new Wasmer();
const results = [
  await probe(wasmer, 'wasmer/bash@=1.0.25', 'bash', ['-c', 'echo bash-ok']),
  await probe(wasmer, 'python/python@=3.13.20', 'python', ['-c', 'print("python-ok")']),
];
await wasmer.close();

const { node, v8, uv, modules } = process.versions;
const provenance = { sdk, node, v8, uv, modules, execArgv: process.execArgv, platform: process.platform, osRelease: release(), arch: arch(), cache };
console.log(JSON.stringify({ ...provenance, results }, null, 2));
