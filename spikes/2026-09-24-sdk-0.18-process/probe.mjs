// Throwaway probe of @wasmer/sdk process semantics that the core wrapper depends on.
// Run from the repo root: node spikes/2026-09-24-sdk-0.18-process/probe.mjs
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { Wasmer, WasmerError } = await import(pathToFileURL(require.resolve('@wasmer/sdk/node')).href);

const results = {};
const t = async (name, fn) => {
  const start = performance.now();
  try {
    results[name] = { ok: true, value: await fn() };
  } catch (e) {
    results[name] = { ok: false, error: `${e?.name}[${e?.code ?? ''}]: ${e?.message}`.slice(0, 300) };
  }
  results[name].ms = Math.round(performance.now() - start);
};
const out = (o) => ({
  exitCode: o.exitCode,
  reason: o.reason,
  stdout: o.stdout.text().slice(0, 120),
  stdoutBytes: o.stdout.bytes.length,
  stdoutTruncated: o.stdout.truncated,
  stderr: o.stderr.text().slice(0, 120),
  stderrBytes: o.stderr.bytes.length,
  stderrTruncated: o.stderr.truncated,
});

// Loopback listener owned by this probe: lets us observe egress without touching the internet.
let connections = 0;
const server = createServer((s) => {
  connections++;
  s.end('pong\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const wasmer = new Wasmer();
const base = { packages: ['wasmer/bash'], shell: 'bash' };
const off = await wasmer.sandboxes.create({ ...base, network: { mode: 'disabled' } });

await t('default-cwd', async () => out(await off.shell('pwd').run({ check: false })));
await t('spawn-capture-limits', async () => {
  const p = await off
    .shell('yes o | head -c 5000; yes e | head -c 5000 >&2')
    .spawn({ stdout: 'capture', stderr: 'capture', outputBytes: 1000 });
  return out(await p.wait());
});
await t('run-limit-per-stream', async () =>
  out(
    await off
      .shell('yes o | head -c 5000; yes e | head -c 5000 >&2')
      .run({ check: false, outputBytes: 1000 }),
  ),
);
await t('spawn-stdin-closed-cat', async () => {
  const p = await off.shell('cat; echo done').spawn({ stdin: 'closed', stdout: 'capture', stderr: 'capture', timeoutMs: 5000 });
  return out(await p.wait());
});
await t('spawn-default-stdin-cat', async () => {
  const p = await off.shell('cat; echo done').spawn({ stdout: 'capture', stderr: 'capture', timeoutMs: 3000 });
  return out(await p.wait());
});
await t('run-stdin-data', async () => out(await off.shell('tr a-z A-Z').run({ check: false, stdin: 'hello\n' })));
await t('command-not-found', async () => out(await off.shell('nosuchcmd').run({ check: false })));
await t('concurrent-4', async () => {
  const start = performance.now();
  const outs = await Promise.all(
    [1, 2, 3, 4].map((i) => off.shell(`sleep 1; echo ${i}`).run({ check: false })),
  );
  return { wallMs: Math.round(performance.now() - start), stdout: outs.map((o) => o.stdout.text().trim()) };
});
await t('binary-stdout', async () => {
  const o = await off.shell("printf '\\x00\\xff\\xfe'").run({ check: false });
  return { bytes: [...o.stdout.bytes], text: JSON.stringify(o.stdout.text()) };
});
await t('kill', async () => {
  const p = await off.shell('sleep 10').spawn({ stdout: 'capture', stderr: 'capture' });
  setTimeout(() => p.kill(), 200);
  return out(await p.wait());
});

const def = await wasmer.sandboxes.create(base);
await t('default-network-loopback', async () =>
  out(await def.shell(`exec 3<>/dev/tcp/127.0.0.1/${port} && head -n1 <&3 || echo blocked`).run({ check: false, timeoutMs: 5000 })),
);
await t('disabled-network-loopback', async () =>
  out(await off.shell(`exec 3<>/dev/tcp/127.0.0.1/${port} && head -n1 <&3 || echo blocked`).run({ check: false, timeoutMs: 5000 })),
);
await def.close();

await t('close-while-running', async () => {
  const sb = await wasmer.sandboxes.create({ ...base, network: { mode: 'disabled' } });
  const p = await sb.shell('sleep 10').spawn({ stdout: 'capture', stderr: 'capture' });
  const waited = p.wait().then(out, (e) => ({ rejected: `${e?.name}[${e?.code ?? ''}]: ${e?.message}` }));
  const closeStart = performance.now();
  await sb.close();
  const closeMs = Math.round(performance.now() - closeStart);
  const settled = await Promise.race([waited, new Promise((r) => setTimeout(() => r('wait() still pending after 3s'), 3000))]);
  return { closeMs, settled };
});
await t('shell-after-close', async () => out(await off.close().then(() => off.shell('echo hi').run({ check: false }))));
results['shell-after-close'].isWasmerError = results['shell-after-close'].error?.startsWith('WasmerError');

await wasmer.close();
server.close();
console.log(JSON.stringify({ sdk: '0.18.0', node: process.versions.node, platform: process.platform, loopbackConnections: connections, results }, null, 2));
void WasmerError;
