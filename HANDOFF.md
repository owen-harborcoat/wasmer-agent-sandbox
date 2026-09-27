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
| `5129a92`, `25bcce2`, `1886aff` | repro mode `kill-close` (SDK only) reproduces **both** the stall and a V8 crash; watchdog on the repro, pc/register dumps, core-dump summaries, `processes` / `close_delay_ms` inputs |

Upstream (filed 2026-09-26 with the user's go-ahead): wasmerio/wasmer-sdk
[#539](https://github.com/wasmerio/wasmer-sdk/issues/539) timeout fires late (plus a comment: a
command on *another* client in between triggers it too, on Windows and Linux),
[#540](https://github.com/wasmerio/wasmer-sdk/issues/540) SIGPIPE stderr noise,
[#541](https://github.com/wasmerio/wasmer-sdk/issues/541) Python needs exnref / `engines`. Check them
for replies first thing.

Verification (`@wasmer/sdk` 0.18.0): locally on Windows 11 / Node 24.21.0, 48 real-Wasmer tests +
7 unit tests. CI is green on all four legs (Linux + Windows × Node 24.21.0 + 22.19.0). Mutation checks
confirm that the abort, network-default and timeout backstop tests fail when the behaviour is
removed, and a poisoned `dist/index.js` confirms tests use the sources. **Known problem:** the suite
stalls on Linux runners about 1 run in 10, and the SDK-only repro also crashes node (V8). Both are
diagnosed in `spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md` (next steps, item 1). The
watchdog kills and documents a stall within 10 minutes. **Not yet verified:** live models, other SDK versions, a nightly against a newer
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

0. **Check #539–#541 for replies** before anything else. If a maintainer picks an option on #541,
   send that PR first (small, and turnaround matters). Match the repo's tone: short first-person
   prose, a repro and raw output, no templated sections (see the saved memory on public tone).
1. **Suite stall and V8 crash (current task).** Details and run ids in
   `spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md`. Where it stands:
   - Trigger: fresh `Wasmer` clients with **no long-lived client open**, where the first command
     times out and is killed from the host (`limits` tests in `session.wasmer.test.ts`, and
     `repro.mjs` mode `kill-close`). Modes with a long-lived client never failed (7,200 iterations).
   - **Stall:** the main thread and one SDK worker spin forever on a wasm atomic `xchg` at linear-memory
     offset `0x17a2b4`, the same offset in the suite and in the repro: a static spin lock whose
     holder is gone. Rate: ~1 in 20 suite jobs, 1 in ~150 repro processes.
   - **Crash:** ~5% of fresh repro processes on ubuntu die at iteration 10–11: V8
     `Check failed: jit_page_->allocations_.erase(addr) == 1` (SIGTRAP) or a SIGSEGV in
     `NativeModule::FreeCode`, both from `Runtime_TierUpWasmToJSWrapper` → `FreeDeadCode`. Matches
     nodejs/node#64500. Waiting 1000 ms between the kill and the close made no difference.
   - **Local commits not pushed:** the findings and HANDOFF updates from this session. Push them
     when the user OKs it.
   - Next, in order:
     1. Find what's at `0x17a2b4` in the SDK's wasm (`pkg/*.wasm`): the data section plus any name
        section, or the SDK's Rust source / `wasm-objdump -x`. If it's the Rust allocator lock or a
        wasm-bindgen static, the stall issue gets much sharper.
     2. Confirm the co-factor: kill-close with a long-lived client open the whole time. Needs a
        small repro change (for example `KEEP_CLIENT=1`).
     3. Crash controls, 20 jobs × 10 processes × 30 iterations each: Node 22.23.0,
        `node --no-memory-protection-keys` (a V8 flag, **not** allowed in `NODE_OPTIONS`: add it to the
        repro command line), and `--no-wasm-code-gc` if V8 13.x still has it. Those settle whether this
        is PKU/code-GC in V8 or something the SDK can avoid (e.g. awaiting `worker.terminate()`: the
        adapter does `void this.#worker.terminate()`).
     4. Then drafts in `upstream-drafts/`: a wasmer-sdk issue (the stall, repro, the lock offset, and
        the fire-and-forget `terminate()`), and a comment on nodejs/node#64500 with our CHECK stack and
        crash rate. Ask the user before filing either.
     5. Our own workaround meanwhile: keep one long-lived client per process in the test setup,
        if (2) confirms it helps. Record it as a workaround, not a fix.
   - Artifacts: repro jobs upload `repro.jsonl`, `p<N>/progress.txt` (last step reached before a
     crash), `p<N>/watchdog/` on a stall, and `gdb-core.<pid>.txt` on a crash. Raw cores stay on the
     runner. Node reports contain the runner env: don't commit them.
2. **Remaining drafts** (`upstream-drafts/`, local only, excluded via `.git/info/exclude`): `04`
   missing-file error code, `05` docs on per-command overlays. Both rewritten in the short tone and
   re-checked on 0.18.0 (2026-09-26). Ready for the user to review before filing.
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
