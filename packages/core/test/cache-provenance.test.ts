import type { PackageLoadProgress } from '@wasmer/sdk/node';
import { describe, expect, it } from 'vitest';
import { cacheProvenance } from '../src/sandbox.js';

// The cold path downloads ~14 MB of packages, too much to exercise on every run, so the
// classification is checked against progress snapshots shaped like the SDK's own.
const progress = (
  packages: [id: string, cached: boolean, bytes: number][],
): PackageLoadProgress => {
  const total = packages.reduce((sum, [, , bytes]) => sum + bytes, 0);
  return {
    phase: 'ready',
    download: { downloadedBytes: total, totalBytes: total, percent: 100 },
    packages: packages.map(([id, cached, bytes]) => ({
      id,
      phase: 'ready',
      cached,
      download: { downloadedBytes: bytes, totalBytes: bytes, percent: 100 },
    })),
  };
};

describe('cacheProvenance', () => {
  it('lists dependencies and classifies the cache state', () => {
    expect(
      cacheProvenance(
        progress([
          ['wasmer/bash@1.0.25', false, 1_870_786],
          ['wasmer/coreutils@1.0.27', false, 12_703_522],
        ]),
      ),
    ).toEqual({
      resolvedPackages: ['wasmer/bash@1.0.25', 'wasmer/coreutils@1.0.27'],
      packageCache: 'cold',
      downloadedBytes: 14_574_308,
    });
    expect(cacheProvenance(progress([['a@1', true, 0]])).packageCache).toBe('warm');
    expect(
      cacheProvenance(
        progress([
          ['a@1', true, 0],
          ['b@1', false, 10],
        ]),
      ).packageCache,
    ).toBe('partial');
  });

  it('fails instead of guessing when the SDK reported no progress', () => {
    expect(() => cacheProvenance(undefined)).toThrow(/no package load progress/);
  });
});
