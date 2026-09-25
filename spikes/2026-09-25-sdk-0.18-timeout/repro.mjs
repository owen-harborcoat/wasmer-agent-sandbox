// Minimal reproduction: the first command run by a new Wasmer client ignores
// timeoutMs while the guest is sleeping. Later commands on the same client, and
// CPU-bound first commands, are killed on time. terminate()/kill() still work.
//
// Run from the repo root with Node 24: node spikes/2026-09-25-sdk-0.18-timeout/repro.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
// The SDK caches registry packages in ./.wasmer; record whether this run started warm.
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

async function timed(wasmer, command) {
  const sandbox = await wasmer.sandboxes.create({ packages: ['wasmer/bash@=1.0.25'], shell: 'bash' });
  const started = performance.now();
  const output = await sandbox.shell(command).run({ check: false, timeoutMs: 500 });
  await sandbox.close();
  return { command, reason: output.reason, exitCode: output.exitCode, ms: Math.round(performance.now() - started) };
}

const results = [];
for (const label of ['client A', 'client B']) {
  const wasmer = new Wasmer();
  results.push({ client: label, run: 1, ...(await timed(wasmer, 'sleep 3')) });
  results.push({ client: label, run: 2, ...(await timed(wasmer, 'sleep 3')) });
  await wasmer.close();
}
const busy = new Wasmer();
results.push({ client: 'client C', run: 1, ...(await timed(busy, 'while true; do :; done')) });
await busy.close();

const provenance = { sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache };
console.log(JSON.stringify({ ...provenance, timeoutMs: 500, results }, null, 2));
