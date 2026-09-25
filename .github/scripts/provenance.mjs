// Prints the provenance of a CI run as JSON: SDK, Node, pnpm, OS, runner image and
// Wasmer cache state. Run from the repo root after `pnpm install`.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const sdkPackage = join(dirname(require.resolve('@wasmer/sdk/node')), '..', 'package.json');
const { env } = process;

const provenance = {
  sdk: JSON.parse(readFileSync(sdkPackage, 'utf8')).version,
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
