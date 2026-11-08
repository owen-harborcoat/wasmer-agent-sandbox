// starve.mjs on SDK main still showed one busy core per timed-out loop, while busy-loop.mjs showed a
// single loop stopping. What differs: starve.mjs runs a new command right after each timeout and never
// closes the timed-out sandbox. This stops `guests` loops one after another (timeoutMs 1000) and, after
// each, does `next`, then measures host CPU over 1 s twice (0–1 s and 2–3 s after `next`).
//
// Run from the repo root: node spikes/2026-11-07-sdk-main-ddbd6cd/stop-then-run.mjs <next> [guests] [shape] [stop]
//   next:  nothing, echo-new (fresh sandbox runs `echo ok`, as starve.mjs does), echo-new-after-<ms>
//          (the same after a delay, e.g. echo-new-after-1000),
//          echo-same (prints ok with the loop's own interpreter in the timed-out sandbox),
//          close (close the timed-out sandbox),
//          close-then-echo-new
//   shape: python (`while True: pass`, default) or quickjs (`node -e 'for (;;) {}'`)
//   stop:  timeout (default, timeoutMs 1000) or kill (spawn, kill() after 1 s)
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { availableParallelism, arch, release } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
// SDK main's scheduler logs worker assignment and kills to stderr when this global is set.
if (process.env.WASMER_SCHEDULER_DIAGNOSTICS) globalThis.__wasmerSchedulerDiagnostics = true;
const { Wasmer } = await import(pathToFileURL(entry).href);

const next = process.argv[2] ?? 'echo-new';
const guests = Number(process.argv[3] ?? 3);
const shape = process.argv[4] ?? 'python';
const stop = process.argv[5] ?? 'timeout';
const busy = {
  python: ['python/python@=3.13.20', 'python', ['-c', 'while True: pass'], ['-c', 'print("ok")']],
  quickjs: ['wasmer/edgejs-quickjs@=0.2.5', 'node', ['-e', 'for (;;) {}'], ['-e', 'console.log("ok")']],
}[shape];
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, cpus: availableParallelism(), next, guests, shape, stop });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const capped = (promise, ms) =>
  Promise.race([promise, sleep(ms).then(() => ({ stalled: `no result after ${ms} ms` }))]);
const cpuShare = async (ms) => {
  const before = process.cpuUsage();
  await sleep(ms);
  const used = process.cpuUsage(before);
  return Math.round(((used.user + used.system) / 1000 / ms) * 100) / 100;
};
const echo = async (sandbox, [cmd, args] = ['bash', ['-c', 'echo ok']]) => {
  const out = await sandbox.command(cmd, args).run({ check: false, timeoutMs: 15000 });
  return { exit: out.exitCode, stdout: (await out.stdout.text()).trim() };
};
const echoNew = async (client) => {
  const sandbox = await client.sandboxes.create({ packages: ['wasmer/bash@=1.0.25'] });
  const result = await echo(sandbox);
  await sandbox.close();
  return result;
};

const wasmer = new Wasmer();
log({ k: 0, echo: await capped(echoNew(wasmer), 20000), cpuCores: await cpuShare(1000) });
for (let k = 1; k <= guests; k++) {
  const sandbox = await wasmer.sandboxes.create({ packages: [busy[0]] });
  let stopped;
  if (stop === 'timeout') {
    const out = await capped(sandbox.command(busy[1], busy[2]).run({ check: false, timeoutMs: 1000 }), 20000);
    stopped = out.stalled ? out : { exit: out.exitCode, reason: out.reason };
  } else {
    const proc = await sandbox.command(busy[1], busy[2]).spawn();
    await sleep(1000);
    await proc.kill();
    stopped = await capped(proc.wait().then(() => 'done'), 10000);
  }
  const row = { k, stopped };
  const t = Date.now();
  if (next === 'echo-new') row.echo = await capped(echoNew(wasmer), 20000);
  const delay = /^echo-new-after-(\d+)$/.exec(next);
  if (delay) row.echo = await sleep(Number(delay[1])).then(() => capped(echoNew(wasmer), 20000));
  if (next === 'echo-same') row.echo = await capped(echo(sandbox, [busy[1], busy[3]]), 20000);
  if (next === 'close' || next === 'close-then-echo-new') row.close = await capped(sandbox.close().then(() => 'done'), 15000);
  if (next === 'close-then-echo-new') row.echo = await capped(echoNew(wasmer), 20000);
  row.nextMs = Date.now() - t;
  row.cpu0to1s = await cpuShare(1000);
  await sleep(1000);
  row.cpu2to3s = await cpuShare(1000);
  log(row);
}
const t = Date.now();
log({ wasmerClose: await capped(wasmer.close().then(() => 'done'), 15000), ms: Date.now() - t, cpuAfterClose: await cpuShare(1000) });
process.exit(0);
