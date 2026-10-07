// Prints the provenance of a CI run as JSON: SDK, the Wasmer packages the suite pins, Node,
// pnpm, OS, runner image and Wasmer cache state. Run from the repo root after `pnpm install`.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const sdkPackage = join(dirname(require.resolve('@wasmer/sdk/node')), '..', 'package.json');
const { env } = process;

// The registry packages the suite pins (DEFAULT_SHELL_PACKAGE in packages/core, PYTHON in its
// tests), resolved to exact ids, dependencies included. Loading only; no guest runs.
const { Wasmer } = await import(pathToFileURL(require.resolve('@wasmer/sdk/node')).href);
const wasmer = new Wasmer();
let wasmerPackages;
try {
  await wasmer.packages.loadMany(['wasmer/bash@=1.0.25', 'python/python@=3.13.20'], {
    onProgress: (progress) => {
      wasmerPackages = progress.packages.map((pkg) => pkg.id);
    },
  });
} catch (error) {
  wasmerPackages = { error: String(error) };
} finally {
  await wasmer.close();
}

const provenance = {
  sdk: JSON.parse(readFileSync(sdkPackage, 'utf8')).version,
  wasmerPackages,
  node: process.versions.node,
  pnpm: execSync('pnpm --version', { encoding: 'utf8' }).trim(),
  platform: process.platform,
  osRelease: release(),
  arch: arch(),
  runnerImage: env.ImageOS ? `${env.ImageOS} ${env.ImageVersion ?? ''}`.trim() : null,
  // actions/cache `cache-hit`: 'true' exact key, 'false' restore-key match, empty on a miss.
  wasmerCache: { true: 'warm', false: 'partial' }[env.CACHE_HIT] ?? 'cold',
  commit: env.GITHUB_SHA ?? null,
  recordedAt: new Date().toISOString(),
};

console.log(JSON.stringify(provenance, null, 2));
