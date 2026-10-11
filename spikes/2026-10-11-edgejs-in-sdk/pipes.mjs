// What happens to an Edge.js guest's stdio when it's a pipe inside the sandbox.
// Prints one JSON line per probe. Network stays disabled; guest files are the ones below.
//
// Run from the repo root: node spikes/2026-10-11-edgejs-in-sdk/pipes.mjs [package]
//   package: wasmer/edgejs (default, host JS engine via N-API) or wasmer/edgejs-quickjs
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

const pkg = process.argv[2] ?? 'wasmer/edgejs';
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, pkg });

const files = {
  'log.js': 'console.log(7)',
  'writesync.js': 'require("fs").writeSync(1, "7\\n")',
  'linger.js': 'console.log(7); setTimeout(() => {}, 300)',
  'big.js': 'process.stdout.write("y".repeat(200000))',
  'kind.js': `const fs = require("fs"); const s = fs.fstatSync(1);
console.error(JSON.stringify({ ctor: process.stdout.constructor.name, isTTY: process.stdout.isTTY ?? null,
  isatty: require("tty").isatty(1), mode: s.mode.toString(8), fifo: s.isFIFO(), sock: s.isSocket(), chr: s.isCharacterDevice() }))`,
  'stdin-stream.js': 'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => console.log(JSON.stringify(d)))',
  'stdin-fs.js': 'console.log(JSON.stringify(require("fs").readFileSync(0, "utf8")))',
  'stdin-kind.js': 'console.log(JSON.stringify({ ctor: process.stdin.constructor.name, mode: require("fs").fstatSync(0).mode.toString(8) }))',
  'child-sync.js': `const r = require("child_process").spawnSync("node", ["/workspace/log.js"], { encoding: "utf8" });
console.log(JSON.stringify({ status: r.status, stdout: r.stdout }))`,
  'child-async.js': `const c = require("child_process").spawn("node", ["/workspace/log.js"]); let o = "";
c.stdout.on("data", (d) => { o += d; }); c.on("close", (status) => console.log(JSON.stringify({ status, stdout: o })))`,
  'exec-sync.js': 'console.log(JSON.stringify(require("child_process").execSync("node /workspace/log.js").toString()))',
};

const probes = [
  // stdout is a pipe
  ['top-level stdout (control)', 'node /workspace/log.js'],
  ['console.log | cat', 'node /workspace/log.js | cat'],
  ['$(console.log)', 'x=$(node /workspace/log.js); echo "captured=[$x]"'],
  ['console.log + 300ms linger | cat', 'node /workspace/linger.js | cat'],
  ['200 KB stdout.write | wc -c', 'node /workspace/big.js | wc -c'],
  ['fs.writeSync(1) | cat', 'node /workspace/writesync.js | cat'],
  ['console.log > file', 'node /workspace/log.js > /workspace/out.txt; cat /workspace/out.txt'],
  ['printf | cat (control)', 'printf "7\\n" | cat'],
  ['stdout kind: top-level', 'node /workspace/kind.js'],
  ['stdout kind: pipe', 'node /workspace/kind.js | cat'],
  ['bash [ -p ] on a pipe', 'echo x | { [ -p /dev/stdin ] && echo fifo || echo not-fifo; }'],
  // stdin is a pipe
  ['echo | process.stdin', 'echo hi | node /workspace/stdin-stream.js'],
  ['echo | fs.readFileSync(0)', 'echo hi | node /workspace/stdin-fs.js'],
  ['stdin kind: pipe', 'echo hi | node /workspace/stdin-kind.js'],
  // node spawning node
  ['spawnSync node', 'node /workspace/child-sync.js'],
  ['spawn node (async)', 'node /workspace/child-async.js'],
  ['execSync node', 'node /workspace/exec-sync.js'],
];

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({ packages: [pkg], files, network: { mode: 'disabled' } });
for (const [name, script] of probes) {
  try {
    const out = await sandbox.command('bash', ['-c', script]).run({ check: false, timeoutMs: 30000 });
    const stdout = (await out.stdout.text()).trim();
    log({ name, script, exit: out.exitCode, reason: out.reason, stdout: stdout.slice(0, 200), stderr: (await out.stderr.text()).trim().slice(0, 400) });
  } catch (e) {
    log({ name, script, threw: `${e.code ?? e.name}: ${e.message}` });
  }
}
await sandbox.close();
await wasmer.close();
