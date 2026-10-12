// Does a timed-out or killed CPU-bound guest actually stop? Measures host CPU for 3 s after the
// command returns, then how long sandbox.close() and wasmer.close() take (capped).
//
// Run from the repo root: node spikes/2026-10-11-edgejs-in-sdk/busy-loop.mjs <shape> [stop] [sdk dir]
//   shape: quickjs (`node -e 'for (;;) {}'` on wasmer/edgejs-quickjs), hostjs (same on wasmer/edgejs),
//          python (`while True: pass`), bash (`while :; do :; done`),
//          quickjs-sleep (`setTimeout` for 60 s, control: not CPU-bound)
//   stop:  timeout (default, timeoutMs 1000) or kill (spawn, kill() after 1 s)
//   sdk dir: a directory with its own node_modules/@wasmer/sdk; defaults to the pinned version
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(
  process.argv[4]
    ? pathToFileURL(join(resolve(process.argv[4]), 'package.json'))
    : new URL('../../packages/core/package.json', import.meta.url),
);
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

const shapes = {
  quickjs: ['wasmer/edgejs-quickjs@=0.2.5', 'node', ['-e', 'for (;;) {}']],
  hostjs: ['wasmer/edgejs@=0.2.5', 'node', ['-e', 'for (;;) {}']],
  python: ['python/python@=3.13.20', 'python', ['-c', 'while True: pass']],
  bash: ['wasmer/bash@=1.0.25', 'bash', ['-c', 'while :; do :; done']],
  'quickjs-sleep': ['wasmer/edgejs-quickjs@=0.2.5', 'node', ['-e', 'setTimeout(() => {}, 60000)']],
};
const shape = process.argv[2] ?? 'quickjs';
const stop = process.argv[3] ?? 'timeout';
const [pkg, cmd, args] = shapes[shape];
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, shape, stop, pkg });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const capped = (promise, ms) =>
  Promise.race([promise.then(() => 'done'), sleep(ms).then(() => `still pending after ${ms} ms`)]);
// Share of one core used by the whole host process (all threads) over `ms`.
const cpuShare = async (ms) => {
  const before = process.cpuUsage();
  await sleep(ms);
  const used = process.cpuUsage(before);
  return Math.round(((used.user + used.system) / 1000 / ms) * 100) / 100;
};

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
log({ idleCpuCores: await cpuShare(1000) });
let t = Date.now();
if (stop === 'timeout') {
  const out = await sandbox.command(cmd, args).run({ check: false, timeoutMs: 1000 });
  log({ returnedMs: Date.now() - t, exit: out.exitCode, reason: out.reason });
} else {
  const proc = await sandbox.command(cmd, args).spawn();
  await sleep(1000);
  await proc.kill();
  const done = await capped(proc.wait(), 10000);
  log({ killReturnedMs: Date.now() - t, wait: done });
}
log({ cpuCoresAfter: await cpuShare(3000) });
t = Date.now();
log({ sandboxClose: await capped(sandbox.close(), 15000), ms: Date.now() - t });
t = Date.now();
log({ wasmerClose: await capped(wasmer.close(), 15000), ms: Date.now() - t });
log({ cpuCoresAfterClose: await cpuShare(2000) });
process.exit(0);
