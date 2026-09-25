// Throwaway probe of @wasmer/sdk filesystem semantics needed by the AI SDK session contract.
// Run from the repo root with Node 24: node spikes/2026-09-25-sdk-0.18-fs/probe.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { Wasmer } = await import(pathToFileURL(require.resolve('@wasmer/sdk/node')).href);

const results = {};
const t = async (name, fn) => {
  try {
    results[name] = { ok: true, value: await fn() };
  } catch (e) {
    results[name] = { ok: false, error: `${e?.name}[${e?.code ?? ''}]: ${e?.message}`.slice(0, 200) };
  }
};

const wasmer = new Wasmer();
const sb = await wasmer.sandboxes.create({
  packages: ['wasmer/bash@=1.0.25'],
  shell: 'bash',
  network: { mode: 'disabled' },
  files: { 'seed.txt': 'seed' },
});
const sh = async (s) => {
  const o = await sb.shell(s).run({ check: false });
  return { exitCode: o.exitCode, stdout: o.stdout.text(), stderr: o.stderr.text() };
};

await t('read-missing', () => sb.fs.readFile('/workspace/missing.txt'));
await t('read-dir-as-file', () => sb.fs.readFile('/workspace'));
await t('read-relative', async () => new TextDecoder().decode(await sb.fs.readFile('seed.txt')));
await t('write-nested-no-parent', () => sb.fs.writeFile('/workspace/a/b/c.txt', 'x'));
await t('mkdir-recursive-then-write', async () => {
  await sb.fs.mkdir('/workspace/a/b', { recursive: true });
  await sb.fs.writeFile('/workspace/a/b/c.txt', 'nested');
  return (await sh('cat /workspace/a/b/c.txt')).stdout;
});
await t('mkdir-recursive-existing', () => sb.fs.mkdir('/workspace/a/b', { recursive: true }));
await t('write-outside-workspace', async () => {
  await sb.fs.mkdir('/tmp/probe', { recursive: true });
  await sb.fs.writeFile('/tmp/probe/x.txt', 'tmp');
  return (await sh('cat /tmp/probe/x.txt')).stdout;
});
await t('fs-sees-shell-writes', async () => {
  await sh('echo from-shell > /workspace/shell.txt');
  return new TextDecoder().decode(await sb.fs.readFile('/workspace/shell.txt'));
});
await t('binary-roundtrip', async () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  await sb.fs.writeFile('/workspace/bin.dat', bytes);
  const back = await sb.fs.readFile('/workspace/bin.dat');
  return { length: back.length, equal: back.every((b, i) => b === i), sha: (await sh('sha256sum /workspace/bin.dat')).stdout.slice(0, 16) };
});
await t('stat-missing', () => sb.fs.stat('/workspace/missing.txt'));
await t('env-HOME-etc', () => sh('echo "HOME=[$HOME] USER=[$USER] PATH=[$PATH] SHELL=[$SHELL]"; id 2>&1; ls -la / ; ls -la /home 2>&1'));
await t('realpath', () => sh('command -v realpath; realpath ./../workspace/seed.txt; which env sh 2>&1'));
await t('sh-exists', () => sh('ls /bin | head -50 | tr "\\n" " "'));
await t('sh-dash-c', () => sh('sh -c "echo via sh"'));
await t('git-node-python', () => sh('command -v git node python python3 curl || true'));

await sb.close();
await wasmer.close();
console.log(JSON.stringify({ sdk: '0.18.0', node: process.versions.node, platform: process.platform, results }, null, 2));
