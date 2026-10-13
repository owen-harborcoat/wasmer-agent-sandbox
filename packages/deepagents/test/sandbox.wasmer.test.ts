import { SandboxPathError } from '@owenota1337/wasmer-sandbox-core';
import { Wasmer } from '@wasmer/sdk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WasmerDeepAgentsSandbox } from '../src/index.js';

// What the standard suite doesn't cover: error codes, paths outside /workspace, searches from /,
// timeouts, binary reads and read pagination.
const encode = (text: string) => new TextEncoder().encode(text);

describe('WasmerDeepAgentsSandbox', () => {
  const wasmer = new Wasmer();
  let sandbox: WasmerDeepAgentsSandbox;

  beforeAll(async () => {
    sandbox = await WasmerDeepAgentsSandbox.create({
      wasmer,
      limits: { timeoutMs: 1_000 },
      initialFiles: {
        '/workspace/src/a.txt': 'alpha\nneedle one\n',
        'src/deep/b.md': 'needle two\n',
        'pic.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    });
  });

  afterAll(async () => {
    await sandbox.close();
    await wasmer.close();
  });

  it('reports a timeout in the output', async () => {
    const result = await sandbox.execute('echo started; sleep 30');

    expect(result.output).toContain('started');
    expect(result.output).toContain('[wasmer-sandbox] command timed out and was killed');
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects paths outside /workspace with invalid_path', async () => {
    expect(await sandbox.uploadFiles([['/tmp/x.txt', encode('x')]])).toEqual([
      { path: '/tmp/x.txt', error: 'invalid_path' },
    ]);
    expect(await sandbox.downloadFiles(['/etc/passwd'])).toEqual([
      { path: '/etc/passwd', content: null, error: 'invalid_path' },
    ]);
    expect((await sandbox.write('/tmp/y.txt', 'y')).error).toContain('invalid_path');
  });

  it('reports directories and paths through files', async () => {
    expect(await sandbox.uploadFiles([['/workspace/src', encode('x')]])).toEqual([
      { path: '/workspace/src', error: 'is_directory' },
    ]);
    expect(await sandbox.uploadFiles([['/workspace/src/a.txt/inner', encode('x')]])).toEqual([
      { path: '/workspace/src/a.txt/inner', error: 'invalid_path' },
    ]);
    expect(await sandbox.downloadFiles(['/workspace/src'])).toEqual([
      { path: '/workspace/src', content: null, error: 'is_directory' },
    ]);
  });

  it('refuses initial files outside /workspace', async () => {
    await expect(
      WasmerDeepAgentsSandbox.create({ wasmer, initialFiles: { '/etc/x': 'x' } }),
    ).rejects.toBeInstanceOf(SandboxPathError);
  });

  it('searches /workspace when the search starts at /', async () => {
    const grep = await sandbox.grep('needle', '/');
    const glob = await sandbox.glob('**/*.md', '/');
    const ls = await sandbox.ls('/');

    expect(grep.matches).toEqual([
      { path: '/workspace/src/a.txt', line: 2, text: 'needle one' },
      { path: '/workspace/src/deep/b.md', line: 1, text: 'needle two' },
    ]);
    expect(glob.files?.map((f) => f.path)).toEqual(['workspace/src/deep/b.md']);
    expect(ls.files).toEqual([{ path: '/workspace/', is_dir: true }]);
  });

  it('finds nothing outside /workspace, where nothing persists', async () => {
    expect((await sandbox.ls('/usr')).files).toEqual([]);
    expect((await sandbox.grep('root', '/etc')).matches).toEqual([]);
  });

  it('greps a single file and caps matches', async () => {
    const result = await sandbox.grep('l', '/workspace/src/a.txt', null, 1);

    expect(result).toEqual({
      matches: [{ path: '/workspace/src/a.txt', line: 1, text: 'alpha' }],
      truncated: true,
    });
  });

  it('returns binary files as bytes', async () => {
    const result = await sandbox.read('/workspace/pic.png');

    expect(result.content).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(result.mimeType).toBe('image/png');
  });

  it('pages text reads the way BaseSandbox does', async () => {
    await sandbox.write('/workspace/rows.txt', 'r1\nr2\nr3\nr4\nr5\n');

    expect(await sandbox.read('/workspace/rows.txt', 1, 2)).toEqual({
      content: '     2\tr2\n     3\tr3\n',
      totalLines: 5,
      startLine: 2,
      endLine: 3,
      nextOffset: 3,
      mimeType: 'text/plain',
    });
    expect(await sandbox.read('/workspace/rows.txt', 3)).toMatchObject({
      endLine: 5,
      totalLines: 5,
    });
    expect((await sandbox.read('/workspace/rows.txt', 3)).nextOffset).toBeUndefined();
  });

  it('deletes with the inherited shell rm', async () => {
    await sandbox.write('/workspace/gone/file.txt', 'x');

    expect((await sandbox.delete('/workspace/gone')).error).toBeUndefined();
    expect(await sandbox.downloadFiles(['/workspace/gone/file.txt'])).toEqual([
      { path: '/workspace/gone/file.txt', content: null, error: 'file_not_found' },
    ]);
    expect((await sandbox.delete('/workspace/never-was')).error).toBeDefined();
  });

  it('is not running before initialize or after close, and close is idempotent', async () => {
    const lazy = new WasmerDeepAgentsSandbox({ wasmer });
    expect(lazy.isRunning).toBe(false);
    expect(() => lazy.sandbox).toThrow('not initialized');

    await lazy.initialize();
    expect(lazy.isRunning).toBe(true);
    await lazy.close();
    await lazy.close();
    expect(lazy.isRunning).toBe(false);
    await expect(lazy.execute('true')).rejects.toThrow('closed');
  });
});
