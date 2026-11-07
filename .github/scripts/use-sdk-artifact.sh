#!/usr/bin/env bash
# Switches the workspace to an unreleased @wasmer/sdk built by wasmer-sdk's own CI, to test fixes
# that are merged but not published.
#
# Usage: .github/scripts/use-sdk-artifact.sh <wasmer-sdk run id> <results dir>
#
# Downloads the run's `wasmer-sdk-js-<sha>` artifact (js/dist + js/pkg; wasmer-sdk keeps it for one
# day), adds js/package.json and LICENSE from that commit with the version set to
# `<version>-<branch>.<sha7>` so provenance can't mistake it for a release, packs it into
# .sdk-artifact/, and points every workspace package at it through a pnpm override. Writes
# sdk-artifact.json (run, commit, version, tarball sha256) to the results dir.
#
# Needs gh with a token (GH_TOKEN in CI). Leaves package.json and pnpm-lock.yaml modified: meant for
# CI. Locally, undo with `git checkout package.json pnpm-lock.yaml && pnpm install`.
set -euo pipefail

run_id=${1:?wasmer-sdk run id}
results=${2:?results dir}
repo=wasmerio/wasmer-sdk
mkdir -p "$results" .sdk-artifact

read -r sha branch head_repo event workflow conclusion < <(gh api "repos/$repo/actions/runs/$run_id" \
  --jq '"\(.head_sha) \(.head_branch) \(.head_repository.full_name) \(.event) \(.path) \(.conclusion)"')
# Only builds of wasmer-sdk's own main: a pull_request run from a fork also uploads this artifact,
# built from code nobody reviewed.
expected="$repo main push .github/workflows/ci.yml success"
if [[ "$head_repo $branch $event $workflow $conclusion" != "$expected" ]]; then
  echo "::error::run $run_id is $head_repo $branch $event $workflow $conclusion, expected $expected"
  exit 1
fi
artifact="wasmer-sdk-js-$sha"
work=".sdk-artifact/$sha"
rm -rf "$work"
gh run download "$run_id" --repo "$repo" --name "$artifact" --dir "$work"
raw() { gh api -H 'Accept: application/vnd.github.raw' "repos/$repo/contents/$1?ref=$sha"; }
raw js/package.json > "$work/package.json"
raw js/LICENSE > "$work/LICENSE"

short=${sha:0:7}
# A semver prerelease identifier can't be all digits with a leading zero.
[[ $short =~ ^[0-9]+$ ]] && short="g$short"
version=$(node -e '
  const fs = require("node:fs");
  const [file, branch, short] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = `${pkg.version}-${branch.replace(/[^0-9A-Za-z-]/g, "-")}.${short}`;
  delete pkg.scripts;
  delete pkg.devDependencies;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(pkg.version);
' "$work/package.json" "$branch" "$short")

tarball=$(cd "$work" && npm pack --ignore-scripts --silent --pack-destination ..)
tarball=".sdk-artifact/$tarball"

node -e '
  const fs = require("node:fs");
  const [tarball, run, sha, branch, artifact, version, out] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.pnpm = { ...pkg.pnpm, overrides: { ...pkg.pnpm?.overrides, "@wasmer/sdk": `file:${tarball}` } };
  fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  const sha256 = require("node:crypto").createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const record = { repo: "wasmerio/wasmer-sdk", run: Number(run), sha, branch, artifact, version, tarball, sha256 };
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
' "$tarball" "$run_id" "$sha" "$branch" "$artifact" "$version" "$results/sdk-artifact.json"

pnpm install --no-frozen-lockfile --ignore-scripts

# Every workspace package that depends on the SDK must now resolve the tarball.
for dir in packages/*/ examples/*/; do
  grep -q '"@wasmer/sdk"' "$dir/package.json" || continue
  got=$(cd "$dir" && node -p 'require(require("node:path").join(require.resolve("@wasmer/sdk/node"), "..", "..", "package.json")).version')
  echo "$dir @wasmer/sdk $got"
  [[ $got == "$version" ]] || { echo "::error::$dir resolves @wasmer/sdk $got, not $version"; exit 1; }
done
