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
| Stack | TypeScript, pnpm workspaces, vitest, Node 24 (floor `^22.23.0`; SDK claims `>=20`) |
| npm scope | `@owenota1337/*` placeholder; never `@wasmer/*` or implied endorsement |
| Dependencies | Exact pins; lockfile committed; nightly job also runs `@wasmer/sdk@latest` |
| MCP Sentinel | Workload #1; model assessment stays out of pass/fail |
| License | MIT, so Wasmer can absorb any of it upstream without friction |
| Posture | Public, upstream-first: code written so it can move into `wasmer-sdk` (e.g. as an integration or example), and findings go to Wasmer as issues and PRs |

## Verified facts (2026-09-24)

- `@wasmer/sdk` latest is **0.18.0** (published 2026-09-24). Releases are near-daily
  (0.15 → 0.18 in three days). The SDK is self-described alpha. The hackathon pinned 0.11.0.
- AI SDK `Experimental_SandboxSession` (`ai` 7.0.114 / `@ai-sdk/provider-utils` 5.0.47, checked
  2026-09-25) is **larger than the docs page**: `description`, `run`, `spawn` (process with
  `pid`, byte streams, `wait`, `kill`), `readFile`/`readBinaryFile`/`readTextFile` (line ranges,
  encodings, `null` for missing) and `writeFile`/`writeBinaryFile`/`writeTextFile` (create
  parents). `command` is a shell string. Experimental: can change in patch releases.
- `HarnessV1SandboxProvider`: `specificationVersion: 'harness-sandbox-v1'`, `providerId`,
  `createSession({sessionId?, abortSignal?, identity?, onFirstCreate?})`, optional `resumeSession`.
  Wasmer resembles `@ai-sdk/sandbox-just-bash` (no resume, no exposed network port). The
  pattern: `createSession()` returns a `HarnessV1NetworkSandboxSession`, and its `restricted()` is
  the plain session for AI SDK tools. The harness expects an absolute `$HOME`.
- Other AI SDK sandbox providers on npm (2026-09-25): E2B, Coder, microsandbox, Apple Container,
  local-machine, Vercel and just-bash. None for Wasmer.
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
| network disabled | inconclusive: bash `/dev/tcp` says "Not supported" in every mode (see below) |

API mapping for `run()`:

- `command` → `sandbox.shell(command, {cwd, env})` with a configured bash shell.
- `abortSignal` → `run()` takes no signal, so use `spawn()` and `terminate()`/`kill()` on abort.
- Non-zero exit → `check: false`. Never throw for a normal exit status.
- Output → `CapturedOutput.text()`; surface truncation instead of hiding it.

## Process and network probes (SDK 0.18.0, Windows 11)

Evidence: `spikes/2026-09-24-sdk-0.18-process/`.

- Default cwd is `/workspace`. `outputBytes` applies per stream, in both `run()` and `spawn()`.
- `spawn()` stdin defaults to closed (`cat` returns at once). `run({stdin})` feeds data.
- Commands in one sandbox run concurrently (4 × `sleep 1` in ~1.3 s).
- `kill()` gives exit 137 with `reason: 'terminated'`. `sandbox.close()` during a command
  returns at once, and the pending `wait()` resolves as `terminated`. Later commands throw
  `WasmerError` `SANDBOX_CLOSED`. Double `close()` is safe on sandbox and client.
- Binary stdout keeps its bytes; `text()` decodes lossily and doesn't throw.
- **Network policy is enforced** (Python sockets against a loopback listener owned by the probe):
  `disabled` and omitted both give `OSError [Errno 58] Not supported` and the host sees no
  connection; `host` connects. So the SDK default is disabled. bash `/dev/tcp` cannot tell
  the modes apart.
- **Python needs a recent Node 22.** `python/python@=3.13.20` fails to start on Node 22.14.0 and
  22.15.0 with `EXECUTION_ERROR: compile error: Validate("Unknown validation error")`, and works
  on 22.23.2 and 24.21.0. All three Node 22 builds report V8 12.4.254.21, so a Node 22 minor
  (flag or patch) is the cutoff, not V8 itself. `@wasmer/sdk` declares `node >=20`, and bash
  works on 22.14. Bisect the exact Node release before filing. Project floor: `^22.23.0 || >=24`,
  developed on Node 24.
- `wasmer/bash` resolves to `wasmer/bash@1.0.25`, with bash plus 101 coreutils-style commands.
  `python/python@3.13.20` bundles bash and coreutils too.

## Filesystem, timeout and latency probes (SDK 0.18.0, Node 24.21.0, Windows 11)

Evidence: `spikes/2026-09-25-sdk-0.18-fs/`, `spikes/2026-09-25-sdk-0.18-timeout/`.

- **Only `/workspace` persists between commands.** A file written to `/tmp`, `/var`, `/opt`,
  `/usr/local` or an unset `$HOME` is gone in the next command. `sandbox.fs` rejects any path
  outside `/workspace` with `INVALID_PATH`. There are no mounts in the 0.18 JS API. Agents that
  install tools or keep state outside the workspace will lose it: document this and flag it upstream.
- `HOME` and `USER` are unset; `PATH` ends with `.`. `ls -la /` shows `----------` modes.
- A missing file gives `FILESYSTEM_ERROR` with "entry not found" in the message, not a distinct
  code. `sandbox.fs.writeFile` creates parent directories.
- `wasmer/bash@1.0.25` coreutils is uutils 0.0.7 (multi-call binary): `realpath`, `base64` present;
  `uname`, `which`, `git` absent. `base64` on a directory panics (exit 27) instead of erroring.
- **Bug: the first command of a new `Wasmer` client ignores `timeoutMs` while it sleeps.** It is
  deterministic and happens per client, not per process: `sleep 3` with `timeoutMs: 500` ran 3238 ms and 3361 ms as each
  new client's first command, and ~700 ms afterwards. CPU-bound first commands are killed on time, and
  `terminate()`/`kill()` still work. The core adds a host-side backstop (kill at `timeoutMs` + 250 ms)
  and reports `timeout`. Minimal repro ready to file.
- A new client's first two-process pipeline takes ~400 ms; later ones take 110–240 ms. Killed and
  timed-out guests leave no host CPU behind.

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
  Real Wasmer test passes through pnpm's symlinked layout.
  `bufferutil` (optional `ws` accelerator via the SDK's WISP client) is deliberately not built.
- [x] `packages/core` `WasmerSandbox` (2026-09-25): create/close lifecycle (shared or owned
  client), shell strings via pinned `wasmer/bash@=1.0.25`, abort via `spawn()` + `terminate()`
  (rejects with `signal.reason` after the guest has stopped), default limits of 60 s and 1 MiB
  per stream, truncation reported, network disabled by default, host env never inherited,
  explicit files only, resolved package ids recorded. 18 real-Wasmer tests and 7 unit tests,
  stable across 3 consecutive runs on Node 24.21.0/Windows. Mutation checks confirmed: disabling
  abort, or defaulting network to host, fails the tests.
- [x] `packages/core` file I/O + streaming (2026-09-25): `readFile` (`null` if missing),
  `writeFile` (creates parents), `SandboxPathError` outside `/workspace`, streaming `spawn` with
  abort and idempotent kill, `HOME=/workspace/.home`, host-side timeout backstop.
- [x] `packages/ai-sdk` (2026-09-25): `createWasmerSandbox()` → `HarnessV1SandboxProvider`, with
  sessions implementing the full `Experimental_SandboxSession`. It mirrors `@ai-sdk/sandbox-just-bash`:
  ports throw `HarnessCapabilityUnsupportedError`, no `setNetworkPolicy`, no resume. Timeouts and
  truncation are reported on stderr. It works with the harness's own `resolveSandboxHomeDir` and
  `resolveSandboxDefaultWorkingDirectory`. End-to-end `generateText` test with `MockLanguageModelV4`:
  a model-requested command runs in Wasmer, and its output is fed back. README with usage. Not yet run
  against a live model.
  Suite: 48 real-Wasmer tests + 7 unit tests, 11 consecutive clean full runs. Two flakes found
  and fixed along the way (a 500 ms limit on a cold pipeline; stream chunks merging under load).
  Mutation check: removing the backstop fails both first-command timeout tests.
- Conformance v0: every spike probe as a test, plus stdin, UTF-8/binary output,
  large stderr, rapid sequential runs and close-while-running.
- Provenance recorder (SDK version, package versions, Node, OS, cache state).
- CI on GitHub Actions: Windows + Linux, pinned SDK; nightly `@wasmer/sdk@latest`.
- Version comparison: run conformance v0 against SDK 0.11.0 and 0.18.0.

### M2: Oct 2 – 15: LangChain provider + workload #1
- `packages/deepagents`, run against `@langchain/sandbox-standard-tests`.
- Run a real `HarnessAgent` harness that doesn't need ports on the Wasmer provider; decide where
  harness state lives (`$HOME` is inside the working directory today).
- Explore ports in `network: host` mode (guest listeners via `node:net`). Ports would allow
  bridge-backed harnesses (Claude Code, Codex) to run on Wasmer.
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
- Maintainer review; share the report with the Wasmer team.

## Out of scope

New MCP-security features, the OpenAI Agents SDK provider (until M4+), anything published
under the Wasmer name, host mounts or secrets passed into sandboxes.
