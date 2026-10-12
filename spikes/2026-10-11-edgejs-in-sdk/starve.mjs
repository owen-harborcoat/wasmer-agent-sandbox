// Do stopped-but-still-spinning guests starve other sandboxes? Stops busy guests one at a time on one
// client (timeoutMs 1000 each), and after each one times a fresh sandbox's `echo ok` on the same
// client, capped at 20 s. Then times the same on a second client in the same process.
//
// Run from the repo root: node spikes/2026-10-11-edgejs-in-sdk/starve.mjs [max guests] [shape]
//   shape: python (`while True: pass`, default) or quickjs (`node -e 'for (;;) {}'`)
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { availableParallelism, arch, release } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

const max = Number(process.argv[2] ?? 8);
const shape = process.argv[3] ?? 'python';
const busy = {
  python: ['python/python@=3.13.20', 'python', ['-c', 'while True: pass']],
  quickjs: ['wasmer/edgejs-quickjs@=0.2.5', 'node', ['-e', 'for (;;) {}']],
}[shape];
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, cpus: availableParallelism(), max, shape });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const capped = (promise, ms) =>
  Promise.race([promise, sleep(ms).then(() => ({ stalled: `no result after ${ms} ms` }))]);
const cpuShare = async (ms) => {
  const before = process.cpuUsage();
  await sleep(ms);
  const used = process.cpuUsage(before);
  return Math.round(((used.user + used.system) / 1000 / ms) * 100) / 100;
};
// A fresh sandbox running `echo ok`: what any other user of the client would do next.
const probe = async (client) => {
  const t = Date.now();
  const result = await capped(
    (async () => {
      const sandbox = await client.sandboxes.create({ packages: ['wasmer/bash@=1.0.25'] });
      const out = await sandbox.command('bash', ['-c', 'echo ok']).run({ check: false, timeoutMs: 15000 });
      const stdout = (await out.stdout.text()).trim();
      await sandbox.close();
      return { exit: out.exitCode, stdout };
    })(),
    20000,
  );
  return { ...result, ms: Date.now() - t };
};

const wasmer = new Wasmer();
log({ k: 0, probe: await probe(wasmer), cpuCores: await cpuShare(1000) });
for (let k = 1; k <= max; k++) {
  const sandbox = await capped(wasmer.sandboxes.create({ packages: [busy[0]] }), 20000);
  if (sandbox.stalled) {
    log({ k, busyCreate: sandbox });
    break;
  }
  const out = await capped(sandbox.command(busy[1], busy[2]).run({ check: false, timeoutMs: 1000 }), 20000);
  const row = { k, busy: out.stalled ? out : { exit: out.exitCode, reason: out.reason } };
  row.probe = await probe(wasmer);
  row.cpuCores = await cpuShare(1000);
  log(row);
  if (out.stalled || row.probe.stalled) break;
}
const other = new Wasmer();
log({ otherClient: await probe(other), cpuCores: await cpuShare(1000) });
process.exit(0);
