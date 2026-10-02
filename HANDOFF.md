# Handoff

State as of 2026-09-27, for the next working session. Read this, then [CLAUDE.md](CLAUDE.md)
(working rules), then [PLAN.md](PLAN.md) (decisions, verified facts, milestones).

Repo: https://github.com/owen-harborcoat/wasmer-agent-sandbox (public, `main`). The local
checkout sits next to the hackathon project (MCP Sentinel) at `../wasmer-hackathon`, which is a
read-only reference.

## What this is

Local Wasmer SDK sandboxes as an execution backend for agent frameworks, plus a conformance lab
that records where the alpha SDK works and where it breaks. Upstream-first: MIT, written so Wasmer
could absorb it, with findings reported to Wasmer as issues and PRs. First framework: Vercel AI SDK.
Next: LangChain deepagentsjs. Target ~2026-11-07 (see PLAN.md for the four milestones).

## Done

| Commit | What |
|---|---|
| `8028507` | pnpm workspace, TypeScript 7, vitest 5 (`unit` + `wasmer` projects), Biome, MIT |
| `b3e87d3` | `packages/core` `WasmerSandbox`: shell strings via pinned `wasmer/bash@=1.0.25`, abort, limits, network off by default, no host env |
| `a54ac29` | core file I/O (`/workspace` only), streaming `spawn`, `HOME=/workspace/.home` |
| `c700a79` | `packages/ai-sdk`: `createWasmerSandbox()` → `HarnessV1SandboxProvider`, full `Experimental_SandboxSession`; host-side timeout backstop |
| `1730442` | redacted local paths in a saved stack trace |
| `e541ecc` | CI: `ubuntu-24.04` + `windows-2025` × Node 24.21.0 + 22.23.0, nightly `sdk-latest` job that reports |
| `0edb991` | timeout bug confirmed on Linux; SIGPIPE stderr-noise probe; truncation tests moved off `yes \| head` |
| `b99c737` | Python-on-old-Node traced to wasm exnref (Node ≥22.19); manual `node-matrix.yml` probe |
| `e3128cc` | Node floor lowered to `^22.19.0`; CI floor leg is 22.19.0; watchdog + 12 min limit on the wasmer step |
| `2857cfc` | **tests now resolve workspace packages from source** (they silently used `dist/` before); gdb stacks on hangs |
| `21cefe2`, `39c2ee1` | worker-init deadlock repro + `stress.yml` (suite or repro, many parallel runs) |
| `5129a92` … `5363179` | repro mode `kill-close` (SDK only) reproduces **both** the stall and a V8 crash; watchdog on the repro, pc/register dumps, core-dump summaries, `processes` / `close_delay_ms` inputs |

Upstream (filed 2026-09-26/27 with the user's go-ahead; also wasmerio/wasmer-sdk#542 and nodejs/node#66366, see next steps item 1): wasmerio/wasmer-sdk
[#539](https://github.com/wasmerio/wasmer-sdk/issues/539) timeout fires late (plus a comment: a
command on *another* client in between triggers it too, on Windows and Linux),
[#540](https://github.com/wasmerio/wasmer-sdk/issues/540) SIGPIPE stderr noise,
[#541](https://github.com/wasmerio/wasmer-sdk/issues/541) Python needs exnref / `engines`. Check them
for replies first thing.

Verification (`@wasmer/sdk` 0.18.0): locally on Windows 11 / Node 24.21.0, 48 real-Wasmer tests +
7 unit tests. CI is green on all four legs (Linux + Windows × Node 24.21.0 + 22.19.0). Mutation checks
confirm that the abort, network-default and timeout backstop tests fail when the behaviour is
removed, and a poisoned `dist/index.js` confirms tests use the sources. **Known problem:** without a
long-lived client, the SDK can hang the process after a kill, and Node 24 can crash in V8's wasm code
GC. Both are diagnosed in `spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md` (next steps, item 1), and keeping a
client open in the suite makes them rarer but doesn't prevent them (1 stall in 40 stress jobs). The watchdog kills and documents a stall within 10 minutes. Live model: `examples/agent-demo` (Fireworks Kimi K3) ran correctly 4 of 4 times on 2026-09-28. **Not yet verified:** other SDK versions, a nightly against a newer
SDK (the first scheduled nightly ran 2026-09-26 on 0.18.0 and hit the stall).

## Run it

Python guests need Node 24 or ≥22.19 (wasm exnref; see PLAN.md). On this machine the
system Node is 22.14, and Node 24.21.0 is installed through fnm. Prefix commands with it:

```bash
fnm exec --using=24 pnpm.cmd install
fnm exec --using=24 pnpm.cmd check        # lint + typecheck + unit tests
fnm exec --using=24 pnpm.cmd test:wasmer  # real sandboxes, ~15 s warm
```

CI: `.github/workflows/ci.yml`. Every leg uploads `results-<os>-node<ver>` with the vitest JSON,
the timeout repro, the SIGPIPE probe and `provenance.json`. On a Linux hang, it also uploads Node
reports and gdb stacks. Scheduled runs start hours late (05:23 UTC cron, started ~09:56). Manual
workflows:

```bash
gh workflow run ci.yml --ref main                                  # includes the sdk-latest job
gh workflow run stress.yml --ref main                              # suite ×20 on ubuntu, Node 22.23 + 24
gh workflow run stress.yml --ref main -f vitest_args='<file> -t "<name>"'   # narrowed suite
gh workflow run stress.yml --ref main -f job=worker-init-repro     # the deadlock repro instead
gh workflow run stress.yml --ref main -f job=worker-init-repro -f repro_mode=kill-close -f iterations=30 -f processes=10 -f node='["24.21.0"]' -f attempts='[1,…,20]'
gh workflow run node-matrix.yml --ref main                         # Python guest across Node releases
```

In Git Bash, `pnpm` resolves to a shell shim that `fnm exec` can't spawn, so use `pnpm.cmd`. Don't pipe
`pnpm check` into `tail` when you need its exit code.

## Next steps, in order

0. **Check #539–#542, nodejs/node#66366 and PR #66376 for replies** before anything else. If a maintainer picks an option on #541,
   send that PR first (small, and turnaround matters). Match the repo's tone: short first-person
   prose, a repro and raw output, no templated sections (see the saved memory on public tone).
1. **Suite stall and V8 crash: diagnosed and filed.** Details and run ids in
   `spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. Two separate bugs, both triggered by
   fresh clients with a host `kill()` and **no long-lived client open**:
   - **SDK stall:** a kill (or close) `Worker::terminate()`s a thread that can be inside malloc/free.
     The global allocator's spin lock at wasm offset `0x17a2b4` stays held, and every thread spins.
     Node 22, 24 and 26, any V8 flags. Draft: `upstream-drafts/06`.
   - **V8 crash:** Node 24 only, and it's a known V8 bug that 24.x lacks the fix for. 24.21.0's V8 13.6
     frees a dying import wrapper twice (`WasmImportWrapperCache::MaybeGet` refs it before checking
     `is_dying()`). Fixed upstream in V8 `9b8ca54d5a` (crbug 409379692), not in `v24.x` or
     `v24.x-staging`. `68210d500a` then `9b8ca54d5a` apply cleanly there (not built). Node 26.10.0: 0
     crashes in 185 processes. Draft for a **new** nodejs/node issue (a backport request):
     `upstream-drafts/07-node-wasm-code-gc-check.md`. #64500 is the wrong target: its reporter traced
     their SIGSEGV to faulty hardware and asked for the CHECK to get its own issue.
   - **Workaround in the suite:** `packages/core/test/keep-client-open.ts` (a vitest setup file) keeps
     one client open per test file, since the `kill-close-shared` arm had 0 failures in 6,000
     iterations. In the suite it only makes stalls rarer: stress 36333372198 still stalled 1 of 40
     jobs (same lock, main thread spinning alone). It's a workaround: remove it when the SDK is fixed,
     and don't count it as a fix.
   - **Why an open client helps (runs 36334735882–36334739507):** it isn't the client object (an idle
     one doesn't help) or the compiled module (holding every module alive doesn't help). It needs
     live instances, which keep the shared import wrappers from dying. That explains the V8 crash. It
     doesn't explain the SDK stall, which still happens on Node 22, 24 and 26 at the same `0x17a2b4`.
   - **New, Node 26 only:** `RangeError: Offset is outside the bounds of the DataView` in
     `__wbindgen_string_get` during `Wasmer.close()` (3 of 20 jobs). Not investigated. See findings.md.
   - **Filed 2026-09-27:** 06 as wasmerio/wasmer-sdk#542. 07 as nodejs/node#66366, with a from-source
     proof (`node-backport.yml` run 36353991873: v24.x-staging as is 8 V8 crashes in 149 processes, with
     the two V8 commits 0 in 191). Cross-linked on #64500. A contributor (ThatKJ) opened the backport
     PR nodejs/node#66376 on 2026-09-28. Its deps/v8 diff is line-for-line identical to what the proof run
     built, and we commented with the result. Next: watch #542 and #66376 (needs a collaborator review and
     CI start).
   - **Guest stdio always reports as a TTY** (found by the live demo, 2026-09-28): `[ -t 0/1/2 ]` is
     true with stdin closed, output captured, or through a pipe or redirect, so `python -` fed a script
     opens the REPL. Already open upstream as wasmerio/wasmer#6425 (child processes only). Pinned in
     `sandbox.wasmer.test.ts`, and `session.description` warns the model. **SDK 0.19.0 (2026-09-28)
     partly fixes it** (checked on Windows in a scratch install, repo still pinned to 0.18.0): pipes and
     redirects inside the guest now report correctly (`echo ... | python -` sees stdin as not a tty, no
     REPL), but the top-level command's own stdio still reports as a tty (`python -c` with host-captured
     output says `[True, True, True]`). After Oct 5, comment on #6425 with that split. The pinned test
     will fail on its pipe/redirect lines when we bump, as intended.
   - **SDK 0.19.0 vs our issues** (same scratch check): #539 still fires late (500 ms timeout ended at
     5,204 ms, when `sleep 5` finished), #541 `engines` still `>=20`, #540 not checkable on Windows. The
     release only touched `browser_http.rs` and `host_filesystem.rs` in bindgen, so #542's scheduler and
     worker code is unchanged. Bump after Oct 5, with a stress run, not before the demo.
   - **Windows-only SDK crashes, intermittent** (3 of the last 15 CI runs, each passed on rerun): a
     `RefCell already borrowed` panic at `wasix/src/state/handles/thread_local.rs:126` that hung the suite
     (36331465337, Node 22.19.0), `RuntimeError: memory access out of bounds` in the SIGPIPE probe
     (36333372121, Node 24.21.0), and `RefCell already borrowed` at `lib/api/src/backend/js/jspi.rs:62`,
     then "Scheduler is dead", in the SIGPIPE probe (36518385645 attempt 1, Node 24.21.0). Guests there
     die mid-pipeline. It might be the same class as #542 (state left inconsistent by a thread
     stopped partway), but that's unproven. Not filed. Worth a repro loop after Oct 5.
2. **Remaining drafts** (`upstream-drafts/`, local only, excluded via `.git/info/exclude`): `04`
   missing-file error code, `05` docs on per-command overlays. Both rewritten in the short tone and
   re-checked on 0.18.0 (2026-09-26). Ready for the user to review before filing, along with 06 and 07.
3. **Finish M1** (due Oct 1): conformance v0 (the remaining spike probes as tests, plus stdin,
   UTF-8/binary, large stderr, close-while-running), a provenance recorder in the package, and the
   SDK 0.11.0 vs 0.18.0 comparison.
4. **M2**: LangChain deepagentsjs provider tested with `@langchain/sandbox-standard-tests`; run a
   real port-less `HarnessAgent` harness on the Wasmer provider; explore ports in `network: host`
   mode (it would allow bridge-backed harnesses); port the MCP Sentinel fixture as workload #1.

## Open decisions (ask the user)

- Where harness state should live: `$HOME` is currently inside the working directory, and the AI
  SDK harness docs ask for it to be outside. Only `/workspace` persists, so moving it out loses state.
- The npm scope is `@owenota1337/*` but the GitHub owner is `owen-harborcoat`. Settle this before
  publishing (packages are `private: true` for now).
- Whether to contact a Wasmer maintainer about which framework adapter they'd want, now that three
  issues are open.

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
- `@wasmer/sdk` releases near-daily. The last one was 0.18.0 (2026-09-24), and nothing new had shipped by 2026-09-26.
  Check `npm view @wasmer/sdk version` before assuming 0.18.0 is current.

## Rules that still apply

No host mounts or secrets in sandboxes; networking stays off unless a test is about networking.
Report failures as they are. Don't publish packages, file upstream issues or contact Wasmer without
the user's go-ahead. Never use the `@wasmer` scope or imply endorsement.
