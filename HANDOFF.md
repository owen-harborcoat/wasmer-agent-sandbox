# Handoff

State as of 2026-10-13, upstream tracker refreshed 2026-11-07, for the next working session. Read this, then [CLAUDE.md](CLAUDE.md)
(working rules), then [PLAN.md](PLAN.md) (decisions, verified facts, milestones).

Repo: https://github.com/owen-harborcoat/wasmer-agent-sandbox (public, `main`). The local
checkout sits next to the hackathon project (MCP Sentinel) at `../wasmer-hackathon`, which is a
read-only reference.

## What this is

Local Wasmer SDK sandboxes as an execution backend for agent frameworks, plus a conformance lab
that records where the alpha SDK works and where it breaks. Upstream-first: MIT, written so Wasmer
could absorb it, with findings reported to Wasmer as issues and PRs. First framework: Vercel AI SDK.
Target ~2026-11-07 (see PLAN.md for the four milestones).

## Where things stand

- **LangChain Deep Agents backend** (2026-10-13, started without Wasmer's framework answer, as planned):
  `packages/deepagents` `WasmerDeepAgentsSandbox` passes `@langchain/sandbox-standard-tests` 93/93, plus
  11 tests of our own and a real `createDeepAgent` loop with a scripted model. `ls`/`read`/`grep`/`glob`
  run on the host because the guest has no `find`/`stat`/`awk`/`grep`. 201 real-Wasmer + 9 unit tests.
- **Working:** `packages/core` (`WasmerSandbox`), `packages/ai-sdk` (AI SDK `HarnessV1SandboxProvider`),
  and `examples/agent-demo`, which runs a live Fireworks model (Kimi K3) end to end: right in 4 of 4
  runs, ~30 s each.
- **M1 is done and on `main`** (2026-10-07): conformance v0 (33 tests in
  `packages/core/test/conformance.wasmer.test.ts`), the provenance recorder (resolved packages incl.
  dependencies, cache state, OS release), and `@wasmer/sdk` **0.19.1**. 82 real-Wasmer tests + 9 unit
  tests. Before merging: suite stress 39 of 40 clean (1 #542-shape stall, same as the 0.18.0 baseline),
  CI green on all four legs. Comparison of 0.18.0 / 0.19.0 / 0.19.1 in PLAN.md.
- **Correction worth remembering:** on 2026-10-06 a `RefCell already borrowed` panic looked like a 0.19.0
  regression. It wasn't: splitting the TTY test into two commands set it off, on 0.18.0 too (A/B in
  `spikes/2026-10-06-sdk-refcell-panic/`). The TTY test stays one command. Change one thing per stress run.
- **Waiting on Wasmer** (asked 2026-10-06): which agent framework they'd want an adapter for first, and how the
  local SDK and StackMachine fit together. M2's framework order and M3's hosting depend on the answer.
  Nothing back on GitHub as of 2026-11-07.
- **Wasmer fixed two of our issues on 2026-11-07** (#542, #556, both via wasmer-sdk#578) and the #547
  memory leak we measured, all on SDK `main` (ddbd6cd), not released: npm `latest` is still 0.19.1 and
  `wasmer/edgejs-quickjs` is still 0.2.5. SDK CI uploads each `main` build as artifact
  `wasmer-sdk-js-<sha>` (`js/dist` + `js/pkg`, no `package.json`) with **1-day retention**.
- **We tested that build the same day** on Windows and Linux (branch `sdk-main-artifact`,
  `spikes/2026-11-07-sdk-main-ddbd6cd/findings.md`): suite clean (0 of 50 stress jobs), #542 fixed (0 of 35
  kill-close jobs, 0.19.1 hung or crashed in 11 of 35 comparable ones), #547 fixed for both Edge.js
  packages. **#556 is only half fixed:** a loop stopped by a timeout keeps its core and wedges `close()`
  if the next sandbox's command starts within a few ms, because the scheduler keys killed threads by
  `(pid, tid)` and every sandbox's first guest is `wasm-1.1`. The guest self-signal crash is unchanged.
  Posted on #556 (the follow-up) and #547 (the numbers) on 2026-11-07, with the user's go-ahead.
- **Node guests via Edge.js** (2026-10-11, the user wants to contribute to wasmerio/edgejs):
  `NODE_PACKAGE` (`wasmer/edgejs-quickjs@=0.2.5`) in core, 13 tests in `node.wasmer.test.ts`, and a Node
  warning in `session.description`. 96 real-Wasmer + 9 unit tests. Evidence and the Edge.js picture
  (roadmap is edgejs#8, no Windows CI, host-JS mode not a security boundary) in
  `spikes/2026-10-11-edgejs-in-sdk/findings.md` and PLAN.md.

## Upstream tracker

Check these for replies first thing. Match the repo's tone in any reply: short first-person prose, a
repro and raw output, no templated sections (see the saved memory on public tone).

| Where | What | Status 2026-11-07 |
|---|---|---|
| wasmerio/wasmer-sdk#539 | `timeoutMs` fires late while the guest sleeps | open, no reply. Still broken on 0.19.1 (all four CI legs, 3.1–3.4 s for a 500 ms limit) |
| wasmerio/wasmer-sdk#540 | SIGPIPE leaves noise in stderr | open. Fixed in 0.19.x (0 of 30 per shape on all legs). We commented 2026-10-07 with the numbers and said it's fine to close |
| wasmerio/wasmer-sdk#541 | Python guests need exnref (Node ≥ 22.19), `engines` says `>=20` | open, no reply. **We commented 2026-10-11**: `wasmer/edgejs` needs JSPI and panics the SDK on Node 22 |
| wasmerio/wasmer-sdk#542 | `kill()` can terminate a worker holding the allocator lock; process hangs | **closed 2026-11-07** by syrusakbary via #578. **Verified on main ddbd6cd** (2026-11-07): kill-close 0 of 20 ubuntu jobs and 0 of 5 windows jobs hung (0.19.1: 4 of 20, 4 of 5), and 0 of 10 V8 CHECKs on Node 24 (0.19.1: 3 of 10). Not released. When it ships, try dropping `keep-client-open.ts` (one stress run for that change alone) |
| wasmerio/wasmer-sdk#554 | **Our PR** (2026-10-07): sync fs calls (`stat`, `readDir`, `mkdir`, `remove`) return a plain Error that `WasmerError.is()` misses; switch them to `rethrowSync` | open, unreviewed. **Rebased onto main ddbd6cd 2026-11-08** (fork branch head 1a230d6, same diff; mergeable, waiting on review and workflow approval). Still needed: core fs calls are still sync on main. When it ships, flip the pinned conformance test |
| wasmerio/wasmer-sdk#547 | Not ours (tobowers): closed Edge.js sandboxes keep ~50 MB each | open. Fixed on SDK `main` (#579, #581–#584, #578) plus edgejs#180. syrusakbary remeasured on macOS only. **We measured main on ubuntu/windows runners and Windows 11** (2026-11-07): edgejs ~580–665 MB median after 60 sandboxes (0.19.1 ~1.9 GB), edgejs-quickjs ~445–514 MB (0.19.1 ~830–930), memory back on `close()`. **We commented 2026-11-07** with the numbers (issuecomment-6717003176; `upstream-drafts/09`) |
| wasmerio/wasmer-sdk#555 | **Ours** (2026-10-11): captured top-level stdio still reports a tty, the rest of wasmer#6425 | open. syrusakbary 2026-11-07: a Wasmer/WASIX issue, "big plans" for a proper fix. Nothing for us to do |
| wasmerio/wasmer-sdk#556 | **Ours** (2026-10-11): `timeoutMs` and `kill()` don't stop a guest that never blocks; it keeps a core and `Wasmer.close()` hangs | **closed 2026-11-07** by #578. **Half fixed on main ddbd6cd**: a lone loop stops (~0.18 cores for the 500 ms grace, `close()` in ms), but a timed-out loop followed within a few ms by a command in another sandbox keeps its core and `close()` hangs, on all three hosts. Cause: scheduler `wasm_workers` keyed by `(pid, tid)`, every sandbox's first guest is `wasm-1.1`. Repro `spikes/2026-11-07-sdk-main-ddbd6cd/stop-then-run.mjs`. **We commented 2026-11-07** with the repro and scheduler logs (issuecomment-6717002985; `upstream-drafts/08`). Native SDKs: #580 + wasmerio/wasmer#7146 (open, Unix only) |
| wasmerio/wasmer-sdk#586 | **Ours** (2026-11-08): a guest that dies of its own SIGTERM (`kill -TERM $$`, or a child doing it) crashes or hangs the host process | open. Filed with the user's go-ahead after confirming it on main ddbd6cd (16 of 16 CI jobs, 8 of 8 local runs). Cites #558 (host `kill()` of an Edge.js guest, closed as an Edge.js bug) as related. Evidence `spikes/2026-10-06-sdk-0.18-guest-signals/`, `spikes/2026-11-07-sdk-main-ddbd6cd/` |
| wasmerio/wasmer#7092 | **Ours** (2026-10-11): WASIX pipes have no file type, `fstat()` gives `st_mode 0` | open. Root cause of edgejs#166 |
| wasmerio/edgejs#166 | **Ours** (2026-10-11): stdout/stdin are no-op streams when they're pipes | open. We offered a stopgap PR (`GuessHandleType`: unknown on fds 0–2 → `UV_FILE` under WASI). Wait for a maintainer to say yes before building it |
| wasmerio/wasmer#6425 | guest stdio reports as a TTY (not ours) | **closed 2026-10-08** by its author after our comment. The remainder is wasmer-sdk#555 |
| nodejs/node#66366 | Node 24 V8 CHECK/SIGSEGV, fixed upstream in V8 `9b8ca54d5a`, missing from 24.x | open. ThatKJ took it. Another repro 2026-10-23 (ngl68: PGlite under Vitest on Windows, Node 24.18.1, 3 of 30; `--no-wasm-code-gc` → 0 of 30) |
| nodejs/node#66376 | ThatKJ's backport PR (V8 `68210d500a` + `9b8ca54d5a`) | open, CI green, still no review as of 2026-11-07. Our test result is posted there |

The evidence for #542 and the Node crash, with run ids, is in
`spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. `upstream-drafts/` (local only, excluded via
`.git/info/exclude`) holds the filed drafts 01–03 and 06–07, plus unfiled `04` (missing-file error code)
and `05` (docs on per-command overlays).

## SDK findings from 2026-10-06/07 (the self-signal crash is now #586)

All in PLAN.md, with evidence in `spikes/`:

- **Filed 2026-11-08 as wasmerio/wasmer-sdk#586.** **A guest that SIGTERMs itself crashes or hangs the host process** (`memory access out of bounds`, `table
  index is out of bounds`, `unaligned accesses`, "Scheduler is dead", or a silent hang). 0.18.0: the
  command's own process doing it; from 0.19.0 a child doing it is enough too (4 of 4 on 0.19.0 and
  0.19.1). Host `terminate()`/`kill()` and SIGPIPE were clean. Kept out of the suite. Repro and tallies:
  `spikes/2026-10-06-sdk-0.18-guest-signals/`. Probably the same class as the Windows panics below.
  The strongest candidate for the next issue: the repro is short and deterministic on Windows.
- **`RefCell already borrowed` panic** at `wasix/src/state/handles/thread_local.rs:126`, set off by the
  order of short commands in `sandbox.wasmer.test.ts`, mostly on Node 22, on every SDK version. Needs a
  minimal repro before filing. `spikes/2026-10-06-sdk-refcell-panic/`.
- `terminate()` runs a guest's SIGTERM trap but reports 143 rather than the trap's exit status. bash
  `/dev/tcp` in host mode does reach the host but can't use the socket. Both pinned in conformance.

## Known problems in the SDK we work around

- **Stall and V8 crash after a kill without a long-lived client.**
  `packages/core/test/keep-client-open.ts` keeps one client open per test file. It makes stalls rarer
  (1 in 40 stress jobs) but doesn't prevent them. It's a workaround: remove it when #542 is fixed.
  A client only helps if it has live instances, which keep V8's shared import wrappers alive. Details in
  findings.md.
- **Guest stdio reports as a TTY** (wasmer#6425). Since 0.19.0 pipes and redirects *inside* the guest
  report correctly (`echo ... | python -` works), but the command's own stdio still says tty, and host-fed
  stdin to `python -` still opens the REPL. One test in `sandbox.wasmer.test.ts` pins both halves (keep it
  one command; see the panic above). `session.description` says programs may print prompts or colour
  codes, and to run scripts from a file or with `-c`.
- **Intermittent Windows SDK panics** (3 of 15 CI runs up to 2026-09-29, each passed on rerun): `RefCell
  already borrowed` at `wasix/src/state/handles/thread_local.rs:126` (36331465337, hung the suite),
  `RuntimeError: memory access out of bounds` (36333372121), and `RefCell already borrowed` at
  `lib/api/src/backend/js/jspi.rs:62` then "Scheduler is dead" (36518385645 attempt 1). The last two were in
  the SIGPIPE probe, where guests die mid-pipeline. Possibly the same class as #542; unproven, not filed.
- **Node 26 only:** `RangeError: Offset is outside the bounds of the DataView` in `__wbindgen_string_get`
  during `Wasmer.close()` (3 of 20 stress jobs, 36334739507). Not investigated.

## Run it

Python guests need Node 24 or ≥22.19 (wasm exnref; see PLAN.md). On this machine the system Node is
22.14, and Node 24.21.0 is installed through fnm. Prefix commands with it, and use `pnpm.cmd`: fnm can't
spawn the `pnpm` shim by that name, in Git Bash or PowerShell.

```bash
fnm exec --using=24 pnpm.cmd install
fnm exec --using=24 pnpm.cmd check                         # lint + typecheck + unit tests
fnm exec --using=24 pnpm.cmd test:wasmer                   # real sandboxes, ~55 s warm
fnm exec --using=24 pnpm.cmd build                         # the demo runs against dist/
fnm exec --using=24 pnpm.cmd --filter agent-demo demo      # live model; costs a few cents
```

The demo reads `FIREWORKS_API_KEY`, or the key alone in `fireworks.txt` at the repo root. That file
exists locally and is excluded in `.git/info/exclude`: never commit it, and check `git status` before
any `git add -A`. `DEMO_MODEL` picks another Fireworks model.

CI: `.github/workflows/ci.yml`. Every leg uploads `results-<os>-node<ver>` with the vitest JSON, the
timeout repro, the SIGPIPE probe and `provenance.json`. On a Linux hang it also uploads Node reports and
gdb stacks. Manual workflows:

```bash
gh workflow run ci.yml --ref main                                  # includes the sdk-latest job
gh workflow run stress.yml --ref main                              # suite ×10 on ubuntu, Node 22.23 + 24
gh workflow run stress.yml --ref main -f vitest_args='<file> -t "<name>"'   # narrowed suite
gh workflow run stress.yml --ref main -f job=worker-init-repro -f repro_mode=kill-close -f iterations=30 -f processes=10 -f node='["24.21.0"]' -f attempts='[1,…,20]'
gh workflow run node-backport.yml --ref main                       # Node v24.x-staging ± V8 cherry-picks, then the repro
gh workflow run node-matrix.yml --ref main                         # Python guest across Node releases
gh workflow run stress.yml --ref main -f job=node-script -f os='["ubuntu-24.04","windows-2025"]' -f node='["24.21.0"]' -f attempts='[1]' -f script_args='spikes/2026-10-11-edgejs-in-sdk/pipes.mjs wasmer/edgejs-quickjs'   # any node script
```

Any stress job can run against an unreleased SDK build: `-f sdk_run=<wasmer-sdk CI run id>` packs that
run's `wasmer-sdk-js-<sha>` artifact (kept one day by wasmer-sdk) as `<version>-main.<sha7>` and overrides
`@wasmer/sdk`. It only accepts successful pushes to wasmer-sdk `main`. Locally:
`bash .github/scripts/use-sdk-artifact.sh <run id> <results dir>`, then
`git checkout package.json pnpm-lock.yaml && pnpm install` to go back. Set
`WASMER_SCHEDULER_DIAGNOSTICS=1` for `stop-then-run.mjs` to log the SDK scheduler (main builds only).
On Windows runners `with-watchdog.sh` doesn't kill a hung process: it runs into the step timeout.

Repro modes: `basic`, `lifecycle`, `kill-close`, `kill-close-shared`, `kill-close-idle`,
`kill-close-module`. A scratch tally script for stress runs (classify each job as CHECK, SIGSEGV, stall
or other from its log) is easy to rebuild: fetch logs with `gh api repos/<repo>/actions/jobs/<id>/logs`,
since `gh run view --log` returns nothing until the whole run finishes.

## Next steps, in order

Updated 2026-11-07, after testing SDK main:

- Done 2026-11-07: evidence pushed on `sdk-main-artifact` (18513f0, which the posted links point at) and
  comments posted on #556 and #547. Watch #556 for a reply on the `(pid, tid)` race. Still open: the
  optional #542 confirmation (`upstream-drafts/10`, ask first), and whether `stress.yml`'s `sdk_run`
  option and `use-sdk-artifact.sh` go to `main`. Keep the branch: the posted links pin its commit.
- 2026-11-08: `sdk-main-artifact` fast-forwarded into `main` (b8dedd0, CI green). #554 rebased. The guest
  self-signal crash filed as wasmerio/wasmer-sdk#586 (`upstream-drafts/11`; snippet re-checked on 0.19.1:
  3 of 3 runs failed). Next: watch #554, #556, #586 for replies; then the M4 technical report.
- When the next `@wasmer/sdk` ships: bump, rerun the comparison (suite stress, kill-close on Node 22 and
  24, `busy-loop.mjs`, `stop-then-run.mjs`, `leak.mjs` for both Edge.js packages, guest signals), then try
  the suite without `keep-client-open.ts`.
- The guest self-signal crash is unchanged on main, on Linux runners too: filed as wasmerio/wasmer-sdk#586.

Older list, from 2026-10-13:

0. **Check the upstream tracker for replies**, especially #554 (our PR), the 2026-10-11 filings (wasmer#7092,
   edgejs#166, wasmer-sdk#555, #556) and comments (#547, #541). If Wasmer answers the framework question, it
   reorders M2. If a maintainer picks an option on #541, send that small PR first. Check
   `npm view @wasmer/sdk version`; on a new release, rerun the suite stress, the kill-close repro, the
   guest-signal tally, `busy-loop.mjs` and `pipes.mjs`, and update the comparison in PLAN.md.
1. **Edge.js contributions** (the user approved this direction on 2026-10-11):
   - If a maintainer wants the edgejs#166 stopgap, build it: fork wasmerio/edgejs, change `GuessHandleType`
     in `src/edge_util.cc` (under WASI, `UV_UNKNOWN_HANDLE` on fds 0–2 → `UV_FILE`, next to the
     `/dev/null` case), let the fork's CI build the WASIX package, and run `pipes.mjs` against that webc
     (the SDK takes WEBC bytes as a package source). It can't be built on this Windows machine.
   - Keep running agent-shaped Node workloads through `NODE_PACKAGE` and file what breaks. Edge.js's CI has
     no Windows leg and its Node test gate skips child_process, fs, net and worker_threads, so our
     Windows + Linux runs cover ground theirs doesn't. PLAN M3's "Node MCP via Edge.js" workload fits here.
   - Later, only if the user asks: a threat model and realm-escape tests for host-JS mode (their
     SECURITY-HOST-JS-NAPI.md lists both as open). Anything found there goes to Wasmer privately.
2. **Upstream items. Ask the user before filing new issues** (comments on threads we're already in are
   fine):
   - The guest self-signal crash (above) as a wasmer-sdk issue, with the tally and repro.
   - A minimal repro for the `RefCell` panic, then file it. Start from the first ~6 tests of
     `sandbox.wasmer.test.ts` with the TTY test split, as a plain script in a loop on Node 22.
   - File drafts `04` and `05` (re-check both on 0.19.1 first).
   - Safe to do without asking: a `stress.yml` mode that runs
     `spikes/2026-10-06-sdk-0.18-guest-signals/repro.mjs` on `windows-2025` and `ubuntu-24.04`, to see
     whether the self-signal crash is what the intermittent Windows CI panics have been.
3. **M2.** `packages/deepagents` is done (above). Next: the MCP Sentinel fixture as workload #1; a live-model
   deepagents run (like `examples/agent-demo`, a few cents on Fireworks); and the LangChain docs-listing PR
   in M4, which needs the npm scope settled and the user's go-ahead. If Wasmer answers the framework
   question, it may reorder this.
4. **M3 hosting is undecided.** The plan says a results dashboard on Wasmer Edge. Wasmer launched
   StackMachine on 2026-10-05 (stackmachine.com; SDKs at github.com/stackmachine/sdks): a hosted
   platform for agents to deploy apps, volumes, Postgres/MySQL/SQLite, email, cron and usage metrics, all
   through one GraphQL API. **It has no "run a command in a sandbox" API.** The user recalls Wasmer saying
   Edge continues as a separate product, and the Edge docs are still up. Don't assume either way; wait
   for Wasmer's reply. One candidate M3 demo: an agent builds in a local Wasmer sandbox, then deploys with
   StackMachine. Account creation and API keys are the user's to do.

## Open decisions (ask the user)

- Where harness state should live: `$HOME` is currently inside the working directory, and the AI
  SDK harness docs ask for it to be outside. Only `/workspace` persists, so moving it out loses state.
- The npm scope is `@owenota1337/*` but the GitHub owner is `owen-harborcoat`. Settle this before
  publishing (packages are `private: true` for now).
- M3 hosting: Wasmer Edge or StackMachine (see next steps, item 4).

## Branches

`claude/upbeat-germain-799099` was merged into `main` on 2026-10-07. The experiment branches from the
panic investigation (`…-sdk018-control`, `…-exp-no-onprogress`, `bump-sdk-0.19`, `exp-019-combined-tty`)
are deleted; their stress runs keep the logs. The fork `owen-harborcoat/wasmer-sdk` holds the #554 branch
`fix/fs-sync-errors`.

## Gotchas learned the hard way

- Never run a guest that loops without blocking in the suite (`for (;;) {}`, `while True: pass`): the
  timeout reports success, the guest keeps spinning, and the file's `Wasmer.close()` hangs teardown.
  Use a sleeping guest for timeout tests. Ad-hoc probes should end with `process.exit()`.
- Don't pipe or `$(...)` an Edge.js `node` inside the guest in tests or probes: the output is dropped
  (edgejs#166). Let it print directly, or have it write to a file.
- Use `wasmer/edgejs-quickjs` (`NODE_PACKAGE`), not `wasmer/edgejs`: the host-JS one needs JSPI and
  panics the SDK on Node 22, and isn't a security boundary.
- The SDK's per-command `env` goes in `sandbox.command(cmd, args, { env })`, not in `run()`.

- AI SDK docs lag the code: read types from the installed `@ai-sdk/provider-utils`, not the website.
- bash `/dev/tcp` says "Not supported" in every network mode, but in host mode the connection does reach
  the host first. Test networking with Python sockets. A test listener needs a socket `error` handler,
  or a guest-side reset becomes an unhandled `ECONNRESET` (stress run 37558335759).
- Change one thing per stress run. A test change that landed with an SDK bump once got blamed on the SDK.
- Don't run a guest that signals itself (`kill $$`, `kill -TERM $$`) in the suite: it crashes or hangs
  the whole vitest worker, and the test timeout doesn't fire.
- Vitest runs each test file in a fresh worker (`isolate: true`), so SDK state can't leak between files.
  Look inside the failing file first.
- Write test sources with an editor, not a shell heredoc: shell escaping once turned `printf` escapes
  into raw bytes, and a `\n` in a string into a real newline.
- A stream chunk can split mid-line (`'1'` then a newline). Read to a delimiter, not one chunk.
- `wasmer/bash` pulls in `wasmer/coreutils@1.0.27`; provenance's `resolvedPackages` lists it.
- Keep time limits away from commands that merely need to finish: a new client's first pipeline
  takes ~400 ms, and more under suite load. Timing-sensitive tests flaked until they were fixed.
- The export condition is `wasmer-agent-sandbox-source`. A generic `source` name collided with a
  third-party package's own condition.
- Vitest `wasmer` project runs files serially; each test file creates its own `Wasmer` client.
- Don't use `yes | head` (or anything that dies of SIGPIPE) in assertions on stderr: the runtime can
  add noise lines. Generate output with `printf` instead. This machine never shows it; CI runners do.
- The `.wasmer` cache key hashes the lockfile and package sources/tests, so most commits restore
  from a partial match (`wasmerCache: "partial"` in provenance).
- Vite 8 runs tests in its server environment, which reads `ssr.resolve.conditions`, not
  `resolve.conditions` (see `vitest.config.ts`). Before the fix, tests quietly imported `dist/`.
- Node's report-on-signal can't fire while a JS main thread is blocked or spinning in a builtin. The
  watchdog adds gdb native stacks for that case (Linux only).
- Two packages that both provide `bash` (e.g. `wasmer/bash` and `python/python`) make the raw SDK throw
  `COMMAND_AMBIGUOUS`. Core avoids it by setting `shell: shellPackage.command('bash')`; do the same in
  ad-hoc probes.
- Quote paths in shell commands. This checkout is under a directory with spaces, and an unquoted path
  once made a probe walk the user's whole Documents folder.
- `@wasmer/sdk` releases near-daily. Check `npm view @wasmer/sdk version` before assuming what's current.

## Rules that still apply

No host mounts or secrets in sandboxes; networking stays off unless a test is about networking.
Report failures as they are. Don't publish packages, file upstream issues, post upstream comments or
contact Wasmer without the user's go-ahead. Never use the `@wasmer` scope or imply endorsement. The repo
is public: no secrets, local paths or career/hiring context in commits.
