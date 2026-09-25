// Throwaway probe: does NetworkPolicy actually gate guest sockets? Uses Python sockets
// (bash /dev/tcp reports "Not supported" in every mode, so it cannot tell modes apart)
// against a loopback listener owned by this probe. No internet traffic.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { Wasmer } = await import(pathToFileURL(require.resolve('@wasmer/sdk/node')).href);

let connections = 0;
const server = createServer((s) => {
  connections++;
  s.end('pong\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const script = `import socket
try:
    s = socket.create_connection(("127.0.0.1", ${port}), timeout=3)
    print("connected:", s.recv(16).decode().strip())
except OSError as e:
    print("blocked:", type(e).__name__, e)
`;

const wasmer = new Wasmer();
const results = {};
for (const [name, network] of [
  ['disabled', { mode: 'disabled' }],
  ['omitted', undefined],
  ['host', { mode: 'host' }],
]) {
  const before = connections;
  const sandbox = await wasmer.sandboxes.create({
    packages: ['python/python@=3.13.20'],
    files: { 'probe.py': script },
    ...(network ? { network } : {}),
  });
  try {
    const o = await sandbox.command('python', ['/workspace/probe.py']).run({ check: false, timeoutMs: 20000 });
    results[name] = {
      exitCode: o.exitCode,
      reason: o.reason,
      stdout: o.stdout.text().trim(),
      stderr: o.stderr.text().trim().slice(0, 300),
      hostSawConnection: connections > before,
    };
  } finally {
    await sandbox.close();
  }
}
await wasmer.close();
server.close();
console.log(JSON.stringify({ sdk: '0.18.0', python: 'python/python@=3.13.20', node: process.versions.node, platform: process.platform, results }, null, 2));
