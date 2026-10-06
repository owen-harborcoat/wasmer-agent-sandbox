# Handoff

State as of 2026-10-06, for the next working session. Read this, then [CLAUDE.md](CLAUDE.md)
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

- **Working:** `packages/core` (`WasmerSandbox`), `packages/ai-sdk` (AI SDK `HarnessV1SandboxProvider`),
  and `examples/agent-demo`, which runs a live Fireworks model (Kimi K3) end to end: right in 4 of 4
  runs, ~30 s each. 49 real-Wasmer tests + 7 unit tests. CI is green on Linux + Windows × Node 24.21.0
  + 22.19.0, apart from intermittent Windows SDK panics (below).
- **Pinned to `@wasmer/sdk` 0.18.0.** 0.19.0 shipped 2026-09-28 and hasn't been adopted yet (next steps, item 1).
- **Waiting on Wasmer** (asked 2026-10-06): which agent framework they'd want an adapter for first, and how the
  local SDK and StackMachine fit together. M2's framework order and M3's hosting depend on the answer.
- **M1 is overdue** (due Oct 1): conformance v0 and the SDK bump are the remaining work, and neither
  depends on anyone else.

## Upstream tracker

Check these for replies first thing. Match the repo's tone in any reply: short first-person prose, a
repro and raw output, no templated sections (see the saved memory on public tone).

| Where | What | Status 2026-10-06 |
|---|---|---|
| wasmerio/wasmer-sdk#539 | `timeoutMs` fires late while the guest sleeps | open, no reply. Still broken on 0.19.0 |
| wasmerio/wasmer-sdk#540 | SIGPIPE leaves noise in stderr | open, no reply. Linux only, unchecked on 0.19.0 |
| wasmerio/wasmer-sdk#541 | Python guests need exnref (Node ≥ 22.19), `engines` says `>=20` | open, no reply. `engines` unchanged in 0.19.0 |
| wasmerio/wasmer-sdk#542 | `kill()` can terminate a worker holding the allocator lock; process hangs | open, no reply. Scheduler code unchanged in 0.19.0 |
| nodejs/node#66366 | Node 24 V8 CHECK/SIGSEGV, fixed upstream in V8 `9b8ca54d5a`, missing from 24.x | open. Contributor ThatKJ took it |
| nodejs/node#66376 | ThatKJ's backport PR (V8 `68210d500a` + `9b8ca54d5a`) | open, CI green, no review yet. Our test result is posted there |
| wasmerio/wasmer#6425 | guest stdio reports as a TTY (not ours, pre-existing) | open. We haven't commented yet (next steps, item 2) |

The evidence for #542 and the Node crash, with run ids, is in
`spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. `upstream-drafts/` (local only, excluded via
`.git/info/exclude`) holds the filed drafts 01–03 and 06–07, plus unfiled `04` (missing-file error code)
and `05` (docs on per-command overlays).

## Known problems in the SDK we work around

- **Stall and V8 crash after a kill without a long-lived client.**
  `packages/core/test/keep-client-open.ts` keeps one client open per test file. It makes stalls rarer
  (1 in 40 stress jobs) but doesn't prevent them. It's a workaround: remove it when #542 is fixed.
  A client only helps if it has live instances, which keep V8's shared import wrappers alive. Details in
  findings.md.
- **Guest stdio reports as a TTY** (wasmer#6425). `sandbox.wasmer.test.ts` pins it, and
  `session.description` tells the model to run scripts from a file or with `-c`. On 0.19.0 (checked on
  Windows in a scratch install), pipes and redirects *inside* the guest report correctly, but the
  top-level command's own stdio still says tty (`python -c` with host-captured output:
  `[True, True, True]`).
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
fnm exec --using=24 pnpm.cmd test:wasmer                   # real sandboxes, ~15 s warm
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
```

Repro modes: `basic`, `lifecycle`, `kill-close`, `kill-close-shared`, `kill-close-idle`,
`kill-close-module`. A scratch tally script for stress runs (classify each job as CHECK, SIGSEGV, stall
or other from its log) is easy to rebuild: fetch logs with `gh api repos/<repo>/actions/jobs/<id>/logs`,
since `gh run view --log` returns nothing until the whole run finishes.

## Next steps, in order

0. **Check the upstream tracker for replies.** If Wasmer answers the framework question, it reorders
   M2. If a maintainer picks an option on #541, send that small PR first.
1. **Finish M1. Nothing here waits on anyone.**
   - **Conformance v0** in `packages/core/test/`: stdin (large, binary, never read), UTF-8 and binary
     stdout/stderr, large stderr, rapid sequential runs, close-while-running, and the remaining spike
     probes as tests. Pin known upstream bugs the way the TTY test does: assert today's behaviour and name
     the issue, so the test fails once it's fixed. Never write a test that passes on an error.
   - **Bump `@wasmer/sdk` to 0.19.0** (check `npm view @wasmer/sdk version` first; it may have moved).
     Update the lockfile and PLAN.md provenance together, as CLAUDE.md requires. Expect the TTY test's
     pipe and redirect lines to flip: split it into "top-level stdio still reports a tty" (pinned bug) and
     "pipes inside the guest report correctly" (regression test). Run a stress job on the bump before
     calling it done, and re-check #539, #540 (Linux CI) and #542 on 0.19.0.
   - **Version comparison: 0.18.0 vs 0.19.0**, replacing the planned 0.11.0 vs 0.18.0 (0.11 is stale,
     0.19 is what people run). Record it in PLAN.md.
   - **Provenance recorder:** `packages/core/src/provenance.ts` exists, but PLAN.md's M1 item is unchecked.
     Check what's missing against the PLAN item (SDK version, package versions, Node, OS, cache state)
     and close it out.
2. **After-launch upstream items** (the Oct 5 launch has passed). **Ask the user before posting or filing
   any of these:**
   - Comment on wasmerio/wasmer#6425: the top-level SDK command case vs the in-guest pipe case, before and
     after 0.19.0, with a short repro.
   - File drafts `04` and `05` (re-check both on the SDK version in use first).
   - Safe to do without asking: a CI repro loop for the Windows panics (a `stress.yml` mode running
     the SIGPIPE probe on `windows-2025`), to find out whether they're one bug and how often they happen.
3. **M2, gated on Wasmer's framework answer.** By default: `packages/deepagents` (LangChain deepagentsjs)
   against `@langchain/sandbox-standard-tests`, and the MCP Sentinel fixture as workload #1. If there's no
   answer by ~2026-10-13, start the LangChain provider anyway.
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

## Gotchas learned the hard way

- AI SDK docs lag the code: read types from the installed `@ai-sdk/provider-utils`, not the website.
- bash `/dev/tcp` reports "Not supported" in every network mode. Test networking with Python sockets.
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
