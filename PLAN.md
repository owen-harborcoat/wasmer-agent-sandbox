# Build plan

Wasmer agent-sandbox provider + conformance lab. Solo project, started 2026-09-24.
Source research: `../wasmer-hackathon/wasmer project plan.txt` (exported Codex chat).
The hackathon repo (MCP Sentinel) stays frozen as the reference project.

## Goal

Make local Wasmer sandboxes a drop-in execution backend for agent frameworks, and
publish repeatable evidence of where the alpha SDK works and where it breaks.

`agent framework → adapter → @wasmer/sdk sandbox → conformance probes → report → Edge dashboard`

Target by ~2026-11-07: one installable package, 20+ deterministic tests,
6–10 workloads, Windows + Linux evidence, one live Wasmer Edge deployment,
at least two accepted upstream issues or PRs, one maintainer review.

## Decisions

| Decision | Choice |
|---|---|
| Repository | This sibling repo; hackathon repo untouched |
| First integration | Vercel AI SDK (`Experimental_SandboxSession`, then `HarnessV1SandboxProvider`) |
| Second integration | LangChain deepagentsjs `SandboxProvider`, validated by `@langchain/sandbox-standard-tests` |
| Later | OpenAI Agents SDK sandbox client (larger contract: resume, snapshots, serialized state) |
| Stack | TypeScript, pnpm workspaces, vitest, Node 22+ (SDK engines `>=20`) |
| npm scope | `@owenota1337/*` placeholder; never `@wasmer/*` or implied endorsement |
| Dependencies | Exact pins; lockfile committed; nightly job also runs `@wasmer/sdk@latest` |
| MCP Sentinel | Workload #1; model assessment stays out of pass/fail |
| License | MIT, so Wasmer can absorb any of it upstream without friction |
| Posture | Public, upstream-first: code written so it can move into `wasmer-sdk` (e.g. as an integration or example), and findings go to Wasmer as issues and PRs |

## Verified facts (2026-09-24)

- `@wasmer/sdk` latest is **0.18.0** (published 2026-09-24). Releases are near-daily
  (0.15 → 0.18 in three days). The SDK is self-described alpha. The hackathon pinned 0.11.0.
- AI SDK `Experimental_SandboxSession` = `description` + `run({command, workingDirectory?, env?, abortSignal?})`
  → `{exitCode, stdout, stderr}`. `command` is a shell string. Experimental: can change in patch releases.
- `HarnessV1SandboxProvider`: `specificationVersion: 'harness-sandbox-v1'`, `providerId`,
  `createSession({sessionId?, abortSignal?, identity?, onFirstCreate?})`, optional `resumeSession`.
  Wasmer resembles `@ai-sdk/sandbox-just-bash` (no resume, no exposed network port).
- LangChain no longer merges new sandbox providers into its monorepo; the path is a standalone
  package plus a docs-listing PR. `@langchain/sandbox-standard-tests` 2.0.1 exists.
- No existing Wasmer provider for AI SDK or LangChain found on npm.
- `@wasmer/sdk` is under a "Modified MIT" license: MIT, plus a requirement to display "Wasmer"
  in the UI of products with >1M MAU or >$1M monthly revenue. The Wasmer runtime is plain MIT.

## Feasibility spike (SDK 0.18.0, Node 22.14.0, Windows 11)

Evidence: `spikes/2026-09-24-sdk-0.18-shell/`. Sandbox with `packages: ['wasmer/bash']`,
`shell: 'bash'`, `network: {mode: 'disabled'}`.

| Probe | Result |
|---|---|
| create | 2062 ms cold (first package download), 134 ms warm cache |
| shell string, stdout/stderr split | pass |
| pipes (`echo \| tr \| wc`) | pass |
| exit code 7 | `exitCode: 7` with `check: false` |
| `cwd` option | pass |
| sandbox env merged with per-command env | pass |
| `timeoutMs` | `reason: 'timeout'`, exit 137 |
| abort via `spawn()` + `terminate()` | `reason: 'terminated'`, exit 143 |
| `outputBytes` limit | truncated at 1000 bytes, `truncated: true` |
| network disabled | `/dev/tcp` connect → "Not supported" |

API mapping for `run()`:

- `command` → `sandbox.shell(command, {cwd, env})` with a configured bash shell.
- `abortSignal` → `run()` takes no signal, so use `spawn()` and `terminate()`/`kill()` on abort.
- Non-zero exit → `check: false`. Never throw for a normal exit status.
- Output → `CapturedOutput.text()`; surface truncation instead of hiding it.

Candidate upstream issue: `terminate()` of `bash -c 'sleep 10'` writes repeated
`Program recieved fatal signal: Aborted` lines (with the "recieved" misspelling) to stderr.
Confirm it reproduces with a minimal case before filing it.

## Repository layout (target)

```
packages/core        WasmerSandbox: lifecycle, shell mapping, limits, abort, provenance
packages/ai-sdk      Experimental_SandboxSession + HarnessV1SandboxProvider
packages/deepagents  LangChain SandboxProvider
conformance/         contract | capability | failure | performance suites
workloads/           mcp-sentinel, python-exec, node-mcp, fastapi, pkg-install, long-running
reports/             JSON results with SDK, package, Node and OS provenance
spikes/              dated throwaway experiments with raw results
```

## Milestones

### M1: Sep 25 – Oct 1: core + AI SDK adapter
- [x] pnpm workspace, TS config, vitest, exact-pinned `@wasmer/sdk@0.18.0`, lint (2026-09-24).
  pnpm 10.10, TypeScript 7.0.2, vitest 5.0.1 (`unit` + `wasmer` projects), Biome 2.5.14.
  Real Wasmer smoke test passes on Windows/Node 22.14 through pnpm's symlinked layout.
  `bufferutil` (optional `ws` accelerator via the SDK's WISP client) is deliberately not built.
- `packages/core`: create/close lifecycle, shell mapping, abort, default time/output limits,
  network disabled by default, explicit file injection only (no host mounts).
- `packages/ai-sdk`: `createWasmerSandbox()` returning `Experimental_SandboxSession`.
  Include an example `generateText` shell tool.
- Conformance v0: every spike probe as a test, plus stdin, UTF-8/binary output,
  large stderr, rapid sequential runs and close-while-running.
- Provenance recorder (SDK version, package versions, Node, OS, cache state).
- CI on GitHub Actions: Windows + Linux, pinned SDK; nightly `@wasmer/sdk@latest`.
- Version comparison: run conformance v0 against SDK 0.11.0 and 0.18.0.

### M2: Oct 2 – 15: LangChain provider + workload #1
- `packages/deepagents`, run against `@langchain/sandbox-standard-tests`.
- `HarnessV1SandboxProvider` wrapper for AI SDK harnesses that don't need network.
- Conformance: files (`sandbox.fs`), streaming processes, ports, cleanup/leaks,
  cold vs warm cache, N concurrent sandboxes.
- Port the MCP Sentinel Helix fixture as workload #1 (MCP protocol + capability probes).
- File the first evidence-backed Wasmer issues. Ask a maintainer which framework to publish first.

### M3: Oct 16 – 30: Edge dashboard + workloads
- Results API + dashboard on Wasmer Edge, managed Postgres, scheduled runs.
  Credits start being spent here; cap below $250/month and log cost per run.
- Workloads to 6–10: Python code exec, Node MCP via Edge.js, FastAPI, package install,
  long-running service, Postgres.

### M4: Oct 31 – Nov 7: report + outreach
- Technical report: compatibility matrix, latency, concurrency, cost, security boundaries.
- Publish packages under `@owenota1337`. Open the LangChain docs-listing PR.
- Maintainer review, then one concise update to the Wasmer CEO.

## Out of scope

New MCP-security features, the OpenAI Agents SDK provider (until M4+), anything published
under the Wasmer name, host mounts or secrets passed into sandboxes.
