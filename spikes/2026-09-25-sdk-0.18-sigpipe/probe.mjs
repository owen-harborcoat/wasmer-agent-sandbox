// Probe: when a pipeline member dies of SIGPIPE (`yes | head`), does the runtime write
// "Program recieved termination signal" lines into the command's own stderr? Seen on the
// GitHub Windows runners (2026-09-25), never in 11 local suite runs. Records how often it
// happens per command shape, with a printf control that never gets SIGPIPE.
//
// Run from the repo root with Node 24: node spikes/2026-09-25-sdk-0.18-sigpipe/probe.mjs [runs]
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

const runs = Number(process.argv[2] ?? 30);
const shapes = [
  'yes | head -c 1000',
  'yes o | head -c 5000; yes e | head -c 10 >&2',
  'yes | head -n 1',
  "printf 'y\\n%.0s' {1..500}",
];

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({ packages: ['wasmer/bash@=1.0.25'], shell: 'bash' });
const shapeResults = [];
for (const command of shapes) {
  const exitCodes = {};
  const noiseLines = {};
  let noisy = 0;
  let maxStderrBytes = 0;
  for (let i = 0; i < runs; i++) {
    const output = await sandbox.shell(command).run({ check: false, timeoutMs: 10_000 });
    const stderr = output.stderr.text();
    const noise = stderr.split('\n').filter((line) => line.startsWith('Program re'));
    exitCodes[output.exitCode] = (exitCodes[output.exitCode] ?? 0) + 1;
    maxStderrBytes = Math.max(maxStderrBytes, Buffer.byteLength(stderr));
    if (noise.length > 0) noisy++;
    for (const line of noise) noiseLines[line] = (noiseLines[line] ?? 0) + 1;
  }
  shapeResults.push({ command, runs, noisyRuns: noisy, exitCodes, maxStderrBytes, noiseLines });
}
await sandbox.close();
await wasmer.close();

const provenance = { sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache };
console.log(JSON.stringify({ ...provenance, results: shapeResults }, null, 2));
