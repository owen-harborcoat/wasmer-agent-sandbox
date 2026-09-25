import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { collectProvenance } from '../src/index.js';

describe('collectProvenance', () => {
  it('reports the exact @wasmer/sdk version pinned by this package', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };

    const provenance = await collectProvenance();

    expect(provenance.sdk.version).toBe(manifest.dependencies['@wasmer/sdk']);
    expect(provenance.node).toBe(process.versions.node);
    expect(provenance.platform).toBe(process.platform);
  });
});
