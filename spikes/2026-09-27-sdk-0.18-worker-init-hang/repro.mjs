// Repro attempt: SDK worker threads can deadlock while initializing (all parked in Atomics.wait
// inside wasm-bindgen's `__wbindgen_start`), so queued commands never run. Seen in 2 of 20 CI suite
// runs on ubuntu-24.04 (stress run 36293213824). The suite creates and closes a fresh `Wasmer`
// client per session while a shared client stays open, so this does the same in a loop.
//
// Mode `basic` only creates, runs and closes. Mode `lifecycle` (default) also does what the suite does
// around the stalls: a timed-out command, a killed spawn, a terminated spawn, and closing a sandbox
// while a command is still running.
//
// Exits 0 with a summary if every iteration finishes; on a stall it writes a Node diagnostic
// report (worker JS stacks included) next to the results and exits 2.
//
// Run from the repo root:
//   node spikes/2026-09-27-sdk-0.18-worker-init-hang/repro.mjs [iterations] [outDir] [basic|lifecycle]
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const { Wasmer } = await import(pathToFileURL(entry).href);

const iterations = Number(process.argv[2] ?? 100);
const outDir = resolve(process.argv[3] ?? '.');
const mode = process.argv[4] ?? 'lifecycle';
const STALL_MS = 30_000;
const PACKAGE = 'wasmer/bash@=1.0.25';

let step = 'start';
let iteration = 0;
const stall = () => {
  mkdirSync(outDir, { recursive: true });
  const report = process.report.writeReport(join(outDir, 'stall-report.json'));
  console.log(JSON.stringify({ result: 'stall', iteration, step, stallMs: STALL_MS, report }));
  process.exit(2);
};
let timer = setTimeout(stall, STALL_MS);
const progress = (label) => {
  step = label;
  clearTimeout(timer);
  timer = setTimeout(stall, STALL_MS);
};

const shared = new Wasmer();
const sharedSandbox = await shared.sandboxes.create({ packages: [PACKAGE], shell: 'bash' });
const started = performance.now();
const durations = [];
for (iteration = 1; iteration <= iterations; iteration++) {
  const t = performance.now();
  progress('new client');
  const wasmer = new Wasmer();
  progress('create sandbox');
  const sandbox = await wasmer.sandboxes.create({ packages: [PACKAGE], shell: 'bash' });
  progress('run on fresh client');
  const output = await sandbox.shell('echo fresh; printf x > /workspace/f; cat /workspace/f').run();
  if (output.stdout.text() !== 'fresh\nx') throw new Error(`unexpected output: ${output.stdout.text()}`);
  progress('run on shared client');
  await sharedSandbox.shell('echo shared').run();
  if (mode === 'lifecycle') {
    progress('timed-out command');
    await sandbox.shell('sleep 5').run({ check: false, timeoutMs: 200 });
    progress('killed spawn');
    const killed = await sandbox.shell('sleep 5').spawn();
    await killed.kill();
    await killed.wait();
    progress('terminated spawn');
    const terminated = await sandbox.shell('sleep 5').spawn();
    await terminated.terminate();
    await terminated.wait();
    progress('spawn left running at close');
    const running = await sandbox.shell('sleep 5').spawn();
    void running.wait().catch(() => {});
  }
  progress('close sandbox');
  await sandbox.close();
  progress('close client');
  await wasmer.close();
  durations.push(performance.now() - t);
}
clearTimeout(timer);
await sharedSandbox.close();
await shared.close();

durations.sort((a, b) => a - b);
const pick = (q) => Math.round(durations[Math.floor(q * (durations.length - 1))]);
console.log(
  JSON.stringify({
    result: 'ok',
    sdk,
    node: process.versions.node,
    platform: process.platform,
    osRelease: release(),
    arch: arch(),
    cpus: cpus().length,
    iterations,
    mode,
    totalMs: Math.round(performance.now() - started),
    iterationMs: { p50: pick(0.5), p95: pick(0.95), max: pick(1) },
  }),
);
