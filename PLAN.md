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
| Stack | TypeScript, pnpm workspaces, vitest, Node 24 (floor `^22.19.0`; SDK claims `>=20`) |
| npm scope | `@owenota1337/*` placeholder; never `@wasmer/*` or implied endorsement |
| Dependencies | Exact pins; lockfile committed; nightly job also runs `@wasmer/sdk@latest` |
| MCP Sentinel | Workload #1; model assessment stays out of pass/fail |
| License | MIT, so Wasmer can absorb any of it upstream without friction |
| Posture | Public, upstream-first: code written so it can move into `wasmer-sdk` (e.g. as an integration or example), and findings go to Wasmer as issues and PRs |

## Verified facts (2026-09-24)

- `@wasmer/sdk` latest is **0.18.0** (published 2026-09-24). Releases are near-daily
  (0.15 → 0.18 in three days). The SDK is self-described alpha. The hackathon pinned 0.11.0.
  Update 2026-10-06: **0.19.0** (published 2026-09-28) is still latest. Its JS wrapper (`dist/`) is
  byte-identical to 0.18.0; only the wasm core, its bindings and the napi snippet changed. The repo
  stays pinned to 0.18.0 because of a Node 22 regression in 0.19.0 (M1).
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
  connection; `host` connects. So the SDK default is disabled. bash `/dev/tcp` says "Not
  supported" in both modes, but (corrected 2026-10-06) in `host` mode the connection does reach
  the host first; bash just can't use the socket. `disabled` fails at `connect`.
- **Python needs wasm `exnref`, which Node enables by default from 22.19.0.** `python/python@=3.13.20`
  fails to start with `EXECUTION_ERROR: compile error: Validate("Unknown validation error")` on
  Node 20.20.2 and on 22.12.0–22.18.0, and works on 22.19.0–22.23.0 and 24.21.0. The results are
  the same on `ubuntu-24.04` and `windows-2025` (CI runs 36207380077, 36207655545; evidence
  `spikes/2026-09-25-node22-python/results-ci.json`). Cause: Node 22.19.0 (nodejs/node#59020,
  backport #59179) adds `--experimental-wasm-exnref` to its default V8 flags. On 22.12–22.18,
  `node --experimental-wasm-exnref` fixes it, and so does `v8.setFlagsFromString` before the SDK
  loads. `NODE_OPTIONS` rejects the flag. Node 20 (V8 11.3) doesn't know the flag at all. The
  `memory64` and `imported-strings` flags don't help. `@wasmer/sdk` declares `node >=20`, and bash
  works everywhere. Project floor: `^22.19.0 || >=24` (lowered from 22.23.0 on 2026-09-26),
  developed on Node 24. CI tests the floor itself (22.19.0) on Linux and Windows.
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
  Corrected 2026-10-06 (0.18.0 and 0.19.0): `uname` is present (`wasi localhost 0.0.0 0.0.0 wasm32
  WASI`), and `base64` on a directory exits 1 with "Is a directory"; `which` and `git` are absent.
- **Bug: the first command of a new `Wasmer` client ignores `timeoutMs` while it sleeps.** It is
  deterministic and happens per client, not per process: `sleep 3` with `timeoutMs: 500` ran 3238 ms and 3361 ms as each
  new client's first command, and ~700 ms afterwards. CPU-bound first commands are killed on time, and
  `terminate()`/`kill()` still work. The core adds a host-side backstop (kill at `timeoutMs` + 250 ms)
  and reports `timeout`. Minimal repro ready to file. **Confirmed on Linux** (2026-09-25, CI run
  36189376746, GitHub `ubuntu-24.04`, kernel 6.17 Azure, Node 22.23.0 and 24.21.0): first commands
  ran 3143–3313 ms, second commands 580–628 ms, CPU-bound 643–686 ms. The `windows-2025` runners
  match. Evidence: `results-linux.json` next to `results-win32.json`.
- A new client's first two-process pipeline takes ~400 ms; later ones take 110–240 ms. Killed and
  timed-out guests leave no host CPU behind.

## Signal noise in guest stderr (SDK 0.18.0, CI runners, 2026-09-25)

Evidence: `spikes/2026-09-25-sdk-0.18-sigpipe/` (probe runs in every CI leg; raw results in the
CI artifacts `sigpipe-probe.json`).

- When a pipeline member dies of SIGPIPE (`yes | head`), the runtime sometimes writes
  `Program recieved termination signal: Broken pipe` plus repeated `Program recieved fatal signal:
  Aborted` lines (with the "recieved" misspelling) into the **command's own stderr**. The exit code
  stays 0. One noisy run added up to ~10 KB of stderr.
- Frequency per 30 runs (CI run 36189376746): `windows-2025` 9–18 for each `yes | head` shape,
  `ubuntu-24.04` 1–2 for `yes | head -c 1000` and 0 for the other shapes, local Windows 11 machine
  0/90. A `printf` control never shows it. It looks timing-dependent (slower hosts show more).
- It broke both truncation tests on the Windows runners; they now use `printf`. Agents pipe into
  `head` constantly, so the noise reaches models as fake errors. Upstream issue candidate, together
  with the earlier sighting: `terminate()` of `bash -c 'sleep 10'` writes the same `fatal signal:
  Aborted` lines.

## Timeout: second trigger, and where the deadline lives (2026-09-26)

- A command that isn't the client's first also misses its deadline if a command on a *different*
  `Wasmer` client ran just before it: `sleep 3` with `timeoutMs: 200` stops at ~3.1 s instead of
  ~0.3 s. This is deterministic on Windows 11, and the same on the `ubuntu-24.04` and `windows-2025`
  runners (all 1,200 iterations of the lifecycle repro). The deadline lands when the guest's
  in-flight sleep returns (`sleep 1; sleep 1; sleep 1` stops at 1.2 s).
- A host-side `kill()` at 750 ms stops the same guest on time, and `kill()` and the timeout share
  `force_exit()`, so the SDK's deadline is what fires late. The deadline is
  `Process::kill_on_timeout` → `ThreadPool::sleep_now` → a lazily started timer worker. In
  `js/src/node-worker.ts`, messages that arrive before a worker has initialized are drained one at
  a time, and each timer is awaited in full. Patching that alone didn't fix the stop time.
  Reported upstream in wasmerio/wasmer-sdk#539 and its first comment.

## Suite stalls on CI runners (2026-09-26)

Evidence: `spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. About 1 in 10 suite runs on
`ubuntu-24.04` stall: one scheduled run (Node 22.23.0) and 2 of 20 stress runs (Node 24.21.0).
None have stalled on Windows or locally so far. One stall was a deadlock: all six SDK worker threads
were parked in `Atomics.wait` inside wasm-bindgen's `__wbindgen_start` during initialization, and
queued commands never ran. The other was a busy main thread rehashing a JS `Set`, with no SDK
workers (cause unknown). A standalone loop of client create/run/close, with or without timeouts,
kills, terminates and close-while-running, didn't stall in 7,200 iterations. Not filed until the
trigger is narrower. The CI watchdog (`.github/scripts/with-watchdog.sh`) bounds and documents it.

## Test harness fix (2026-09-26)

Vite 8 runs vitest in its server environment, which reads `ssr.resolve.conditions`. The
`wasmer-agent-sandbox-source` condition sat in `resolve.conditions` only, so the ai-sdk tests
imported `packages/core/dist`, which `pnpm check` happened to rebuild first. Fixed in
`vitest.config.ts` and verified with a poisoned `dist/index.js`. CI results since `e541ecc`
stand, because every CI leg rebuilt `dist` from the same sources. A local `test:wasmer` run after
editing sources without `pnpm check` could have tested stale code.

## Conformance v0: SDK 0.18.0 vs 0.19.0 (2026-10-06)

Local: Windows 11 10.0.26200, Node 24.21.0, warm cache, 4 full suite runs on 0.18.0 (82/82 each) and
4 on 0.19.0 (83/83 after a wording fix in one test). CI: run 37557236811 (both OSes × Node 24.21.0
and 22.19.0) plus the stress runs listed. 0.19.0's JS wrapper is byte-identical to 0.18.0, so every
difference comes from the wasm core.

| Behaviour | 0.18.0 | 0.19.0 |
|---|---|---|
| Pipes and redirects inside a guest (`echo \| [ -t 0 ]`) | report a tty | **fixed**: not a tty, so `echo ... \| python -` works |
| The command's own stdio (wasmer#6425) | tty | still tty (host-fed `python -` still opens the REPL) |
| SIGPIPE noise in stderr (wasmer-sdk#540), CI probe, 30 runs per shape | Windows 9–18, Linux 0–2 | **0 on all four legs** |
| `Program recieved ...` lines in stderr after host `terminate()` (local) | 15 of 15 | **0 of 15** |
| First-command `timeoutMs` (wasmer-sdk#539), `sleep 3` vs 500 ms | 3.1–3.3 s | 3.1–3.3 s, unchanged (Node 22 reports `exited`, Node 24 `timeout`) |
| Allocator-lock stall after kill + close (wasmer-sdk#542), kill-close repro, Node 22.23.0, 20 jobs | 6 stalled (36331476279) | 9 stalled (37557239245), main thread spinning on `xchg` at base + `0x17a574` |
| `RefCell already borrowed` panic, `sandbox.wasmer.test.ts` alone, Node 22.23.0 | 0 of 20 | **22 of 40 (regression)** |
| Guest that SIGTERMs itself, 4 × 20 iterations (local) | crash or hang 8 of 8 | crash or hang 6 of 8 |
| Child that SIGTERMs itself (`sh -c 'kill -TERM $$'`) (local) | clean 4 of 4 | **crash or hang 4 of 4 (regression)** |
| Sync fs calls (`stat`, `readDir`, `mkdir`, `remove`) reject with a plain Error that `WasmerError.is()` misses | yes | yes (same `dist/`) |
| Missing file has no error code of its own | yes | yes |
| `terminate()` runs the guest's SIGTERM trap, then reports 143 instead of its status | yes | yes |
| bash `/dev/tcp` in `host` mode connects but can't use the socket | yes | yes |
| Suite time (local, sum of test durations) | 26.5 s | 27.4 s |

New findings from writing conformance v0 (not filed; ask before filing):

- **SandboxFileSystem's sync calls skip error conversion.** `stat`, `readDir`, `mkdir` and `remove` call
  synchronous core methods inside `rethrow(this.#core.x(...))`, so they throw before `rethrow`'s
  `try` and reject with a plain `Error` named `WasmerError`. A one-line fix upstream (`rethrow(async () => ...)`
  or a sync wrapper). Pinned in conformance.
- **A guest that signals itself crashes or hangs the host process** (`memory access out of bounds`,
  `table index is out of bounds`, `unaligned accesses`, "Scheduler is dead", or a silent hang).
  On 0.19.0 a child process doing it is enough. Likely the same class as the intermittent Windows
  CI panics. Evidence: `spikes/2026-10-06-sdk-0.18-guest-signals/`.
- **0.19.0's `RefCell already borrowed` regression on Node 22**: `spikes/2026-10-06-sdk-0.19-refcell-panic/`.
- **bash `/dev/tcp`**: in `host` mode the connection reaches the host but bash can't use it. This corrects
  the earlier "cannot tell the modes apart".

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
  a model-requested command runs in Wasmer, and its output is fed back. README with usage. Live model run
  (2026-09-28): `examples/agent-demo` on Fireworks Kimi K3, right in 4 of 4 runs, ~30 s each. That run found
  that every guest stdio fd reports as a terminal (wasmerio/wasmer#6425), so `session.description` now
  tells the model to avoid piping scripts into interpreters, and a core test pins the bug.
  Suite: 48 real-Wasmer tests + 7 unit tests, 11 consecutive clean full runs. Two flakes found
  and fixed along the way (a 500 ms limit on a cold pipeline; stream chunks merging under load).
  Mutation check: removing the backstop fails both first-command timeout tests.
- Bump the pinned SDK to `@wasmer/sdk@0.19.0`: **held back** (decided 2026-10-07). The bump works
  (83/83 locally on Node 24.21.0, Windows 11), but on CI runners a `RefCell already borrowed` panic
  kills the SDK in about half the Node 22 runs (0 of 20 on 0.18.0); see the comparison section above
  and `spikes/2026-10-06-sdk-0.19-refcell-panic/`. `main` stays on 0.18.0. Branch `bump-sdk-0.19` has
  the bump with its test and description changes; two tests here are marked to flip on the bump
  (the in-guest TTY test and the terminate-stderr test). Retry on the next SDK release.
- [x] Conformance v0 (2026-10-06): `packages/core/test/conformance.wasmer.test.ts`, 33 tests. Stdin
  (4 MiB intact by hash, binary, UTF-8, partial reader, never read, empty), UTF-8 and binary
  output (lossy decode, byte-count truncation mid-character, all 256 byte values), large stderr
  (kept whole, truncated at 1 MiB, 3 MB on both streams at once, interleaved order), rapid sequential
  runs (100 commands, 20 sandboxes, 5 timeouts in a row), close while running (streaming, several
  commands, stdin still being written), and the remaining spike probes (kill and terminate exit
  codes, SIGTERM traps, env, tool set, filesystem errors, `/dev/tcp`, #539's raw SDK deadline).
  Known bugs are pinned to today's behaviour. Left out on purpose: a guest that signals itself, which
  crashes or hangs the SDK (`spikes/2026-10-06-sdk-0.18-guest-signals/`).
- [x] Provenance recorder (2026-10-06): `collectProvenance()` gives SDK version, Node, platform,
  OS release and arch; each `WasmerSandbox.provenance` gives requested and resolved package ids
  (dependencies such as `wasmer/coreutils@1.0.27` included), cache state (`warm`/`cold`/`partial`,
  from the SDK's own load progress) and bytes downloaded. CI's `provenance.json` adds pnpm,
  runner image, the CI cache hit and the resolved packages the suite pins.
- [x] CI on GitHub Actions (2026-09-25): `.github/workflows/ci.yml`, `ubuntu-24.04` + `windows-2025`
  × Node 24.21.0 + the declared floor (22.23.0, now 22.19.0), pinned SDK, actions pinned by SHA, `./.wasmer`
  cached, results + provenance uploaded as artifacts. `sdk-latest` job (nightly + manual) reports
  instead of failing. First green run: 36189376746 (48/48 real-Wasmer tests on all four legs).
- [x] Version comparison (2026-10-06): conformance v0 on SDK 0.18.0 vs 0.19.0, in place of the
  planned 0.11.0 vs 0.18.0 (0.11 is stale). See "Conformance v0: SDK 0.18.0 vs 0.19.0" above.

### M2: Oct 2 – 15: LangChain provider + workload #1
- `packages/deepagents`, run against `@langchain/sandbox-standard-tests`.
- Run a real `HarnessAgent` harness that doesn't need ports on the Wasmer provider; decide where
  harness state lives (`$HOME` is inside the working directory today).
- Explore ports in `network: host` mode (guest listeners via `node:net`). Ports would allow
  bridge-backed harnesses (Claude Code, Codex) to run on Wasmer.
- Conformance: files (`sandbox.fs`), streaming processes, ports, cleanup/leaks,
  cold vs warm cache, N concurrent sandboxes.
- Port the MCP Sentinel Helix fixture as workload #1 (MCP protocol + capability probes).
- [x] File the first evidence-backed Wasmer issues (2026-09-26, done early): wasmerio/wasmer-sdk
  #539 (timeout), #540 (SIGPIPE stderr noise), #541 (Python needs exnref / `engines`). Drafts for the
  missing-file error code and the overlay docs are kept local.
- Ask a maintainer which framework to publish first.

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
