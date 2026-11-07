// wasmer-sdk#547, adapted: host RSS after each closed sandbox that ran wasmer/edgejs.
// Stops early once RSS passes MAX_RSS_MB, so a leaking SDK can't take the machine down.
//
// Run from the repo root: node --expose-gc spikes/2026-10-11-edgejs-in-sdk/leak.mjs [cycles] [sdk dir] [package]
//   sdk dir: a directory with its own node_modules/@wasmer/sdk (for A/B runs); defaults to the
//            version pinned in packages/core, also when given as -
//   package: defaults to wasmer/edgejs, run as `edge`; any other package is run as `node`
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cycles = Number(process.argv[2] ?? 30);
const base = process.argv[3] && process.argv[3] !== '-'
  ? pathToFileURL(join(resolve(process.argv[3]), 'package.json'))
  : new URL('../../packages/core/package.json', import.meta.url);
const require = createRequire(base);
const entry = require.resolve('@wasmer/sdk/node');
const sdk = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
const cache = existsSync('.wasmer/cache-v1') ? 'warm' : 'cold';
const { Wasmer } = await import(pathToFileURL(entry).href);

const pkg = process.argv[4] ?? 'wasmer/edgejs';
const cmd = pkg === 'wasmer/edgejs' ? 'edge' : 'node';
const maxRss = Number(process.env.MAX_RSS_MB ?? 3000);
const mb = () => Math.round(process.memoryUsage().rss / 2 ** 20);
const log = (line) => writeSync(1, `${JSON.stringify(line)}\n`);
log({ sdk, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch(), cache, cycles, pkg, maxRss, gc: typeof globalThis.gc });

const wasmer = new Wasmer();
const t0 = Date.now();
for (let i = 1; i <= cycles; i++) {
  const sandbox = await wasmer.sandboxes.create({ packages: [pkg], files: { 'main.js': 'console.log(1 + 1)' } });
  const out = await sandbox.command(cmd, ['/workspace/main.js']).run({ check: false });
  const stdout = i === 1 ? (await out.stdout.text()).trim() : undefined;
  await sandbox.close();
  globalThis.gc?.();
  log({ i, rssMb: mb(), ms: Date.now() - t0, ...(i === 1 ? { exit: out.exitCode, stdout } : {}) });
  if (mb() > maxRss) {
    log({ stopped: `RSS over ${maxRss} MB` });
    break;
  }
}
await wasmer.close();
globalThis.gc?.();
log({ afterClientClose: mb() });
