import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a result came from: attached to every conformance report. */
export interface Provenance {
  readonly sdk: { readonly name: '@wasmer/sdk'; readonly version: string };
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/**
 * Report the installed `@wasmer/sdk` version. The SDK exports no version
 * constant and does not export its package.json, so walk up from the
 * resolved entrypoint to the package root.
 */
export async function wasmerSdkVersion(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.resolve('@wasmer/sdk/node')));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@wasmer/sdk' && typeof pkg.version === 'string') return pkg.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the @wasmer/sdk package.json');
    dir = parent;
  }
}

export async function collectProvenance(): Promise<Provenance> {
  return {
    sdk: { name: '@wasmer/sdk', version: await wasmerSdkVersion() },
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}
