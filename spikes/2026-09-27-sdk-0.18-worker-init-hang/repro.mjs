// Repro attempt: SDK worker threads can deadlock while initializing (all parked in Atomics.wait
// inside wasm-bindgen's `__wbindgen_start`), so queued commands never run. Seen in 2 of 20 CI suite
// runs on ubuntu-24.04 (stress run 36293213824). The suite creates and closes a fresh `Wasmer`
// client per session while a shared client stays open, so this does the same in a loop.
//
// Mode `basic` only creates, runs and closes. Mode `lifecycle` (default) also does what the suite does
// around the stalls: a timed-out command, a killed spawn, a terminated spawn, and closing a sandbox
// while a command is still running.
//
// Mode `kill-close` copies the `WasmerSandboxSession limits` tests, where stress run 36294840179 stalled
// (main thread and the only SDK worker both busy): the *first* command on a fresh client times out, the
// SDK's timeout fires late (wasmerio/wasmer-sdk#539), so a host-side kill() stops it at 750 ms, and the
// client is closed right after. Then another fresh client runs a command with an output limit. There's
// no long-lived client in this mode. A busy main thread can't fire the stall timer below: run it under
// .github/scripts/with-watchdog.sh to get native stacks. KILL_CLOSE_DELAY_MS (default 0) waits that long
// between the kill and the close, to tell whether the kill or the close leaves the lock held.
// Mode `kill-close-shared` is the same, plus one long-lived client that ran one command before the loop
// and stays open throughout, to test whether an open client prevents the failures.
// Two more arms ask why it does. `kill-close-idle` keeps a client open that never creates a sandbox or runs
// anything. `kill-close-module` keeps no client open, but holds on to every wasm module the SDK compiles on
// the main thread (each fresh client compiles bash there with `new WebAssembly.Module`), so V8 can reuse
// the native module for identical bytes instead of freeing it.
//
// Exits 0 with a summary if every iteration finishes; on a stall it writes a Node diagnostic
// report (worker JS stacks included) next to the results and exits 2.
//
// Run from the repo root:
//   node spikes/2026-09-27-sdk-0.18-worker-init-hang/repro.mjs [iterations] [outDir] [basic|lifecycle|kill-close|kill-close-shared|kill-close-idle|kill-close-module]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;

const iterations = Number(process.argv[2] ?? 100);
const outDir = resolve(process.argv[3] ?? '.');
const mode = process.argv[4] ?? 'lifecycle';

// The glue looks up WebAssembly.Module at call time, so this has to be in place before the SDK runs.
const retained = [];
if (mode === 'kill-close-module') {
  WebAssembly.Module = new Proxy(WebAssembly.Module, {
    construct(target, args) {
      const module = new target(...args);
      retained.push(module);
      return module;
    },
  });
}
const { Wasmer } = await import(pathToFileURL(entry).href);
const closeDelayMs = Number(process.env.KILL_CLOSE_DELAY_MS ?? 0);
const STALL_MS = 30_000;
const PACKAGE = 'wasmer/bash@=1.0.25';

let step = 'start';
let iteration = 0;
mkdirSync(outDir, { recursive: true });
// Written synchronously on every step, so it survives a crash (seen: SIGSEGV in kill-close).
const progressFile = join(outDir, 'progress.txt');
const stall = () => {
  const report = process.report.writeReport(join(outDir, 'stall-report.json'));
  console.log(JSON.stringify({ result: 'stall', iteration, step, stallMs: STALL_MS, report }));
  process.exit(2);
};
let timer = setTimeout(stall, STALL_MS);
const progress = (label) => {
  step = label;
  writeFileSync(progressFile, `${iteration} ${label}\n`);
  clearTimeout(timer);
  timer = setTimeout(stall, STALL_MS);
};

const SANDBOX = { packages: [PACKAGE], shell: 'bash' };

// One iteration of `kill-close`, mirroring core's exec(): SDK timeout plus a host backstop kill.
async function killThenClose() {
  progress('new client (timeout)');
  const wasmer = new Wasmer();
  const sandbox = await wasmer.sandboxes.create(SANDBOX);
  progress('first command times out');
  const guest = await sandbox
    .shell('echo partial >&2; sleep 30')
    .spawn({ stdin: 'closed', stdout: 'capture', stderr: 'capture', timeoutMs: 500 });
  let killed = false;
  const backstop = setTimeout(() => {
    killed = true;
    guest.kill().catch(() => {});
  }, 750);
  const out = await guest.wait();
  clearTimeout(backstop);
  if (out.stderr.text() !== 'partial\n') throw new Error(`unexpected stderr: ${out.stderr.text()}`);
  if (closeDelayMs > 0) await new Promise((done) => setTimeout(done, closeDelayMs));
  progress('close right after the kill');
  await sandbox.close();
  await wasmer.close();

  progress('new client (truncation)');
  const next = new Wasmer();
  const nextSandbox = await next.sandboxes.create(SANDBOX);
  progress('run with output limit');
  const truncated = await nextSandbox
    .shell("printf 'y\\n%.0s' {1..500}")
    .spawn({ stdin: 'closed', stdout: 'capture', stderr: 'capture', outputBytes: 100 });
  const result = await truncated.wait();
  if (result.stdout.text() !== 'y\n'.repeat(50)) throw new Error('unexpected truncated stdout');
  progress('close (truncation)');
  await nextSandbox.close();
  await next.close();
  return { killed, reason: out.reason };
}

const killClose = mode.startsWith('kill-close');
let keptOpen;
if (mode === 'kill-close-shared') {
  progress('long-lived client');
  keptOpen = new Wasmer();
  const keptSandbox = await keptOpen.sandboxes.create(SANDBOX);
  await keptSandbox.shell('echo kept').run();
} else if (mode === 'kill-close-idle') {
  keptOpen = new Wasmer();
}

const started = performance.now();
const durations = [];
const outcomes = {};
if (killClose) {
  for (iteration = 1; iteration <= iterations; iteration++) {
    const t = performance.now();
    const { killed, reason } = await killThenClose();
    const key = `${killed ? 'host kill' : 'sdk timeout'}/${reason}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    durations.push(performance.now() - t);
  }
}

await keptOpen?.close();
const shared = killClose ? undefined : new Wasmer();
const sharedSandbox = await shared?.sandboxes.create(SANDBOX);
for (iteration = 1; !killClose && iteration <= iterations; iteration++) {
  const t = performance.now();
  progress('new client');
  const wasmer = new Wasmer();
  progress('create sandbox');
  const sandbox = await wasmer.sandboxes.create(SANDBOX);
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
await sharedSandbox?.close();
await shared?.close();

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
    execArgv: process.execArgv,
    ...(killClose ? { closeDelayMs, outcomes } : {}),
    ...(mode === 'kill-close-module' ? { retainedModules: retained.length } : {}),
    totalMs: Math.round(performance.now() - started),
    iterationMs: { p50: pick(0.5), p95: pick(0.95), max: pick(1) },
  }),
);
