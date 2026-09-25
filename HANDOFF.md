# Handoff

State as of 2026-09-25, for the next working session. Read this, then [CLAUDE.md](CLAUDE.md)
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

Verification (Windows 11, Node 24.21.0, `@wasmer/sdk` 0.18.0): 48 real-Wasmer tests + 7 unit tests,
11 consecutive clean full runs. Mutation checks confirm that the abort, network-default and timeout
backstop tests fail when the behaviour is removed. **Not yet verified:** Linux, CI, live models,
other SDK versions.

## Run it

Node 24 is required for Python guests (Python fails on Node 22 before ~22.23). On this machine the
system Node is 22.14, and Node 24.21.0 is installed through fnm. Prefix commands with it:

```bash
fnm exec --using=24 pnpm.cmd install
fnm exec --using=24 pnpm.cmd check        # lint + typecheck + unit tests
fnm exec --using=24 pnpm.cmd test:wasmer  # real sandboxes, ~15 s warm
```

In Git Bash, `pnpm` resolves to a shell shim that `fnm exec` can't spawn, so use `pnpm.cmd`. Don't pipe
`pnpm check` into `tail` when you need its exit code.

## Next steps, in order

1. **CI** (`.github/workflows/ci.yml`): Windows + Ubuntu, Node 24 (and 22.23+), pinned SDK. Run
   `pnpm check` and `pnpm test:wasmer`, and cache `.wasmer/`. Add a nightly job against
   `@wasmer/sdk@latest` that reports rather than fails the build. The repo now exists, so this can be
   verified for real.
2. **Confirm the timeout bug on Linux**: run `spikes/2026-09-25-sdk-0.18-timeout/repro.mjs` in CI
   and save the output next to `results-win32.json`.
3. **Draft upstream issues** for `wasmerio/wasmer-sdk` (draft only; filing needs the user's go-ahead):
   - First command of a new client ignores `timeoutMs` while sleeping (repro ready).
   - Python guest fails on Node 22.14/22.15 with `Validate("Unknown validation error")` while
     `engines` says `>=20`. Bisect the Node 22 release first.
   - Missing file → generic `FILESYSTEM_ERROR` ("entry not found"); ask for a distinct code.
   - Docs: only `/workspace` persists between commands; other paths are per-process.
   - `terminate()` stderr noise ("Program recieved fatal signal"); confirm with a minimal case.
4. **SDK version comparison**: run the suite against 0.11.0 (the hackathon pin) and 0.18.0, and
   record the differences.
5. **M2**: LangChain deepagentsjs provider tested with `@langchain/sandbox-standard-tests`; run a
   real port-less `HarnessAgent` harness on the Wasmer provider; explore ports in `network: host`
   mode (it would allow bridge-backed harnesses); port the MCP Sentinel fixture as workload #1.

## Open decisions (ask the user)

- Where harness state should live: `$HOME` is currently inside the working directory, and the AI
  SDK harness docs ask for it to be outside. Only `/workspace` persists, so moving it out loses state.
- The npm scope is `@owenota1337/*` but the GitHub owner is `owen-harborcoat`. Settle this before
  publishing (packages are `private: true` for now).
- When to file the upstream issues, and whether to contact a Wasmer maintainer first about which
  framework adapter they'd want.

## Gotchas learned the hard way

- AI SDK docs lag the code: read types from the installed `@ai-sdk/provider-utils`, not the website.
- bash `/dev/tcp` reports "Not supported" in every network mode. Test networking with Python sockets.
- Keep time limits away from commands that merely need to finish: a new client's first pipeline
  takes ~400 ms, and more under suite load. Timing-sensitive tests flaked until they were fixed.
- The export condition is `wasmer-agent-sandbox-source`. A generic `source` name collided with a
  third-party package's own condition.
- Vitest `wasmer` project runs files serially; each test file creates its own `Wasmer` client.
- `@wasmer/sdk` releases near-daily. Check `npm view @wasmer/sdk version` before assuming 0.18.0 is current.

## Rules that still apply

No host mounts or secrets in sandboxes; networking stays off unless a test is about networking.
Report failures as they are. Don't publish packages, file upstream issues or contact Wasmer without
the user's go-ahead. Never use the `@wasmer` scope or imply endorsement.
