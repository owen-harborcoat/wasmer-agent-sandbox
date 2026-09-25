// Throwaway feasibility spike: can @wasmer/sdk map onto AI SDK Experimental_SandboxSession.run()?
import { Wasmer } from '@wasmer/sdk/node';

const results = {};
const t = async (name, fn) => {
  const start = performance.now();
  try { results[name] = { ok: true, value: await fn() }; }
  catch (e) { results[name] = { ok: false, error: `${e?.name}: ${e?.message}`.slice(0, 400) }; }
  results[name].ms = Math.round(performance.now() - start);
};

const wasmer = new Wasmer();
let sandbox;
await t('create', async () => {
  sandbox = await wasmer.sandboxes.create({
    packages: ['wasmer/bash'],
    shell: 'bash',
    files: { 'sub/marker.txt': 'hi' },
    env: { BASE: 'base' },
    network: { mode: 'disabled' },
  });
  return 'created';
});

if (sandbox) {
  const out = (o) => ({ exitCode: o.exitCode, reason: o.reason, stdout: o.stdout.text().slice(0, 200), stdoutLen: o.stdout.bytes.length, stdoutTruncated: o.stdout.truncated, stderr: o.stderr.text().slice(0, 200) });
  await t('echo', async () => out(await sandbox.shell('echo hello && echo err 1>&2').run({ check: false })));
  await t('pipes+subshell', async () => out(await sandbox.shell('echo a b c | tr " " "\\n" | wc -l').run({ check: false })));
  await t('exit-code', async () => out(await sandbox.shell('exit 7').run({ check: false })));
  await t('cwd', async () => out(await sandbox.shell('pwd; ls', { cwd: '/workspace/sub' }).run({ check: false })));
  await t('env-merge', async () => out(await sandbox.shell('echo $BASE $EXTRA', { env: { EXTRA: 'extra' } }).run({ check: false })));
  await t('timeout', async () => out(await sandbox.shell('sleep 5').run({ check: false, timeoutMs: 500 })));
  await t('abort-via-terminate', async () => {
    const p = await sandbox.shell('sleep 10').spawn({ stdout: 'capture', stderr: 'capture' });
    setTimeout(() => p.terminate({ gracePeriodMs: 200 }), 300);
    return out(await p.wait());
  });
  await t('output-limit', async () => out(await sandbox.shell('yes x | head -c 100000').run({ check: false, outputBytes: 1000 })));
  await t('network-disabled', async () => out(await sandbox.shell('echo > /dev/tcp/1.1.1.1/80 && echo connected || echo blocked').run({ check: false, timeoutMs: 5000 })));
  await t('close', async () => { await sandbox.close(); return 'closed'; });
}
await wasmer.close();
console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, sdk: '0.18.0', results }, null, 2));
