# Handoff

State as of 2026-10-06 (evening), for the next working session. Read this, then [CLAUDE.md](CLAUDE.md)
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
  runs, ~30 s each.
- **M1 work is on branch `claude/upbeat-germain-799099`, not on `main`** (pushed; `main` untouched).
  It adds conformance v0 (33 tests in `packages/core/test/conformance.wasmer.test.ts`), the
  provenance recorder (resolved packages incl. dependencies, cache state, OS release), and the bump to
  `@wasmer/sdk` 0.19.0. 83 real-Wasmer tests + 9 unit tests. Locally 83/83 on 0.19.0 four times.
- **The 0.19.0 bump is blocked by a regression**: a `RefCell already borrowed` panic
  (`wasix/src/state/handles/thread_local.rs:126`) kills the SDK in about half of the Node 22 runs on CI
  (22 of 40 stress jobs of `sandbox.wasmer.test.ts`; 0 of 20 on 0.18.0). Node 24 rarely hits it. Our floor
  is Node 22.19, so merging the branch as is would make CI fail about half the time. Evidence:
  `spikes/2026-10-06-sdk-0.19-refcell-panic/findings.md`. **Ask the user how to land it** (next steps, item 1).
- **Waiting on Wasmer** (asked 2026-10-06): which agent framework they'd want an adapter for first, and how the
  local SDK and StackMachine fit together. M2's framework order and M3's hosting depend on the answer.
- **M1 is done apart from landing it**: conformance v0, provenance and the 0.18.0 vs 0.19.0 comparison
  (PLAN.md, "Conformance v0: SDK 0.18.0 vs 0.19.0") are checked off. Only the bump is open.

## Upstream tracker

Check these for replies first thing. Match the repo's tone in any reply: short first-person prose, a
repro and raw output, no templated sections (see the saved memory on public tone).

| Where | What | Status 2026-10-06 |
|---|---|---|
| wasmerio/wasmer-sdk#539 | `timeoutMs` fires late while the guest sleeps | open, no reply. Still broken on 0.19.0 (all four CI legs, 3.1–3.3 s for a 500 ms limit) |
| wasmerio/wasmer-sdk#540 | SIGPIPE leaves noise in stderr | open, no reply. **Looks fixed in 0.19.0**: 0 of 30 per shape on all four CI legs (37557236811); was 9–18 on Windows. Worth a short comment (ask first) |
| wasmerio/wasmer-sdk#541 | Python guests need exnref (Node ≥ 22.19), `engines` says `>=20` | open, no reply. `engines` unchanged in 0.19.0 |
| wasmerio/wasmer-sdk#542 | `kill()` can terminate a worker holding the allocator lock; process hangs | open, no reply. Still there on 0.19.0: 9 of 20 kill-close jobs stalled on Node 22.23.0 (37557239245; 0.18.0: 6 of 20), same `xchg` spin, now at base + `0x17a574` |
| nodejs/node#66366 | Node 24 V8 CHECK/SIGSEGV, fixed upstream in V8 `9b8ca54d5a`, missing from 24.x | open. Contributor ThatKJ took it |
| nodejs/node#66376 | ThatKJ's backport PR (V8 `68210d500a` + `9b8ca54d5a`) | open, CI green, no review yet. Our test result is posted there |
| wasmerio/wasmer#6425 | guest stdio reports as a TTY (not ours, pre-existing) | open. We haven't commented yet (next steps, item 2) |

The evidence for #542 and the Node crash, with run ids, is in
`spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. `upstream-drafts/` (local only, excluded via
`.git/info/exclude`) holds the filed drafts 01–03 and 06–07, plus unfiled `04` (missing-file error code)
and `05` (docs on per-command overlays).

## New SDK findings from 2026-10-06 (not filed; ask before filing)

All in PLAN.md's comparison section, with evidence in `spikes/`:

- **0.19.0 `RefCell already borrowed` panic on Node 22** (above). Narrowing so far: not caused by our
  `onProgress` observer (9/20 without it), not by the conformance file (vitest isolates files), and no
  single test triggers it (the TTY tests plus neighbours were clean 80/80). It follows the TTY tests or the
  abort (`terminate()`) test. `spikes/2026-10-06-sdk-0.19-refcell-panic/`.
- **A guest that SIGTERMs itself crashes or hangs the host process** (`memory access out of bounds`, `table
  index is out of bounds`, `unaligned accesses`, "Scheduler is dead", or a silent hang). 0.18.0: the
  command's own process doing it (8 of 8 runs); 0.19.0: a child doing it is enough too (4 of 4). Host
  `terminate()`/`kill()` and SIGPIPE were clean. Kept out of the suite. Repro and tallies:
  `spikes/2026-10-06-sdk-0.18-guest-signals/`. Probably the same class as the Windows panics below.
- **`SandboxFileSystem.stat/readDir/mkdir/remove` reject with a plain `Error`** that `WasmerError.is()`
  rejects: the core calls are sync, so they throw before `rethrow()`'s `try`. Same in 0.19.0 (identical
  `dist/`). Small, clean upstream PR candidate. Pinned in conformance.
- `terminate()` runs a guest's SIGTERM trap but reports 143 rather than the trap's exit status. bash
  `/dev/tcp` in host mode does reach the host but can't use the socket. Both pinned.

## Known problems in the SDK we work around

- **Stall and V8 crash after a kill without a long-lived client.**
  `packages/core/test/keep-client-open.ts` keeps one client open per test file. It makes stalls rarer
  (1 in 40 stress jobs) but doesn't prevent them. It's a workaround: remove it when #542 is fixed.
  A client only helps if it has live instances, which keep V8's shared import wrappers alive. Details in
  findings.md.
- **Guest stdio reports as a TTY** (wasmer#6425). On 0.19.0 pipes and redirects *inside* the guest
  report correctly (`echo ... | python -` works), but the command's own stdio still says tty, and host-fed
  stdin to `python -` still opens the REPL. On the branch the test is split: the top-level case is pinned,
  the in-guest case is a regression test. `session.description` now says programs may print prompts or
  colour codes, and to run scripts from a file or with `-c`.
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
```

Repro modes: `basic`, `lifecycle`, `kill-close`, `kill-close-shared`, `kill-close-idle`,
`kill-close-module`. A scratch tally script for stress runs (classify each job as CHECK, SIGSEGV, stall
or other from its log) is easy to rebuild: fetch logs with `gh api repos/<repo>/actions/jobs/<id>/logs`,
since `gh run view --log` returns nothing until the whole run finishes.

## Next steps, in order

0. **Check the upstream tracker for replies.** If Wasmer answers the framework question, it reorders
   M2. If a maintainer picks an option on #541, send that small PR first. Also check
   `npm view @wasmer/sdk version`: a 0.20 may fix the panic.
1. **Land M1 (ask the user which way).** The old "finish M1" item is done on the branch. Options:
   (a) merge it as is and accept failing Node 22 legs until upstream fixes the panic; (b) land
   everything except the bump on `main` at 0.18.0 (the TTY test and the terminate-stderr test then go
   back to their 0.18.0 form, since both assert 0.19.0 behaviour); (c) wait for the next SDK release and
   rerun the stress arms. On any candidate, rerun
   `gh workflow run stress.yml --ref <branch> -f node='["22.23.0"]' -f attempts='[1,…,20]' -f vitest_args='packages/core/test/sandbox.wasmer.test.ts'`.
   The 0.18.0 baseline is 0 of 20 panics.
2. **After-launch upstream items** (the Oct 5 launch has passed). **Ask the user before posting or filing
   any of these:**
   - Comment on wasmerio/wasmer#6425: the top-level SDK command case vs the in-guest pipe case, before and
     after 0.19.0, with a short repro.
   - File drafts `04` and `05` (re-check both on the SDK version in use first).
   - Ask before filing the new 2026-10-06 findings above (0.19.0 panic, self-signal crash, fs error class).
     The fs one comes with an obvious one-line fix, so it may be the best first PR.
   - Safe to do without asking: a CI repro loop for the Windows panics. The guest-signal repro
     (`spikes/2026-10-06-sdk-0.18-guest-signals/repro.mjs`) is the best lead; a `stress.yml` mode running it
     on `windows-2025` and `ubuntu-24.04` would show whether the self-signal crash is what CI has been hitting.
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

## Remote branches made on 2026-10-06

- `claude/upbeat-germain-799099`: the M1 work (above).
- `claude/upbeat-germain-799099-sdk018-control`: commit `4752b5b` (0.18.0 + conformance), used for the control
  stress runs. Keep until the comparison isn't needed.
- `claude/upbeat-germain-799099-exp-no-onprogress`: an experiment (no `onProgress` observer). Not for `main`;
  delete when done.

## Gotchas learned the hard way

- AI SDK docs lag the code: read types from the installed `@ai-sdk/provider-utils`, not the website.
- bash `/dev/tcp` says "Not supported" in every network mode, but in host mode the connection does reach
  the host first. Test networking with Python sockets. A test listener needs a socket `error` handler,
  or a guest-side reset becomes an unhandled `ECONNRESET` (stress run 37558335759).
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
