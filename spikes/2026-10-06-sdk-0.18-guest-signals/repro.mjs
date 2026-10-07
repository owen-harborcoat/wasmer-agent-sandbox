// Do guests that die of a signal corrupt the SDK? Runs one shape repeatedly in one sandbox and
// logs each step synchronously, so a crash or hang shows where it happened.
//
// Run from the repo root: node spikes/2026-10-06-sdk-0.18-guest-signals/repro.mjs <shape> [iterations] [scope]
//   shapes: self-term (`kill -TERM $$`), child-self-term (`sh -c 'kill -TERM $$'`),
//           host-terminate (terminate() of `sleep 30`), host-kill (kill() of `sleep 30`),
//           sigpipe (`yes | head -c 1000`), control (`true`)
//   scope:  same (default, one sandbox), sandbox (new sandbox per iteration)
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

const shape = process.argv[2] ?? 'self-term';
const iterations = Number(process.argv[3] ?? 20);
const scope = process.argv[4] ?? 'same';
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, shape, iterations, scope });

const shell = {
  'self-term': 'kill -TERM $$; echo after',
  'child-self-term': `sh -c 'kill -TERM $$'; echo after`,
  sigpipe: 'yes | head -c 1000 > /dev/null',
  control: 'true',
};

const wasmer = new Wasmer();
const create = () => wasmer.sandboxes.create({ packages: ['wasmer/bash@=1.0.25'], shell: 'bash' });
let sandbox = await create();
for (let i = 0; i < iterations; i++) {
  if (i > 0 && scope === 'sandbox') {
    await sandbox.close();
    sandbox = await create();
  }
  const started = performance.now();
  let output;
  if (shape === 'host-terminate' || shape === 'host-kill') {
    const process = await sandbox.shell('sleep 30').spawn({ stdout: 'capture', stderr: 'capture' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (shape === 'host-kill') await process.kill();
    else await process.terminate({ gracePeriodMs: 5_000 });
    output = await process.wait();
  } else {
    output = await sandbox.shell(shell[shape]).run({ check: false, timeoutMs: 10_000 });
  }
  const followUp = await sandbox.shell('echo ok').run({ check: false, timeoutMs: 10_000 });
  log({
    i,
    exitCode: output.exitCode,
    reason: output.reason,
    stderr: output.stderr.text().split('\n')[0],
    followUp: followUp.stdout.text().trim(),
    ms: Math.round(performance.now() - started),
  });
}
await sandbox.close();
await wasmer.close();
log({ done: true });
process.exit(0);
