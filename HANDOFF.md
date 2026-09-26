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
| `e541ecc` | CI: `ubuntu-24.04` + `windows-2025` × Node 24.21.0 + 22.23.0, nightly `sdk-latest` job that reports |
| `0edb991` | timeout bug confirmed on Linux; SIGPIPE stderr-noise probe; truncation tests moved off `yes \| head` |

Verification (`@wasmer/sdk` 0.18.0): locally on Windows 11 / Node 24.21.0, 48 real-Wasmer tests +
7 unit tests, 11 consecutive clean full runs. CI run 36189376746 is green on all four legs
(Linux + Windows × Node 24.21.0 + 22.23.0). Mutation checks confirm that the abort, network-default
and timeout backstop tests fail when the behaviour is removed. **Not yet verified:** live models,
other SDK versions, and a scheduled nightly run (the manual `sdk-latest` dispatch works; it ran 0.18.0
because no newer SDK existed).

## Run it

Node 24 is required for Python guests (Python fails on Node 22 before ~22.23). On this machine the
system Node is 22.14, and Node 24.21.0 is installed through fnm. Prefix commands with it:

```bash
fnm exec --using=24 pnpm.cmd install
fnm exec --using=24 pnpm.cmd check        # lint + typecheck + unit tests
fnm exec --using=24 pnpm.cmd test:wasmer  # real sandboxes, ~15 s warm
```

CI: `.github/workflows/ci.yml`. Every leg uploads `results-<os>-node<ver>` with the vitest JSON,
the timeout repro, the SIGPIPE probe and `provenance.json`. Trigger the latest-SDK job by hand with
`gh workflow run ci.yml --ref main`.

In Git Bash, `pnpm` resolves to a shell shim that `fnm exec` can't spawn, so use `pnpm.cmd`. Don't pipe
`pnpm check` into `tail` when you need its exit code.

## Next steps, in order

1. **Check the first scheduled nightly** (05:23 UTC) ran and that its `sdk-latest` summary reads
   right. When a newer SDK ships, confirm the job goes yellow (warning), not red, on failures.
2. **Review and file the upstream drafts** in `upstream-drafts/` (uncommitted; filing needs the
   user's go-ahead). Each has a standalone repro that was run as written on 2026-09-25:
   `01` first-command timeout, `02` SIGPIPE stderr noise, `03` Python needs wasm exnref (Node
   ≥22.19; root cause found), `04` missing-file error code, `05` docs on per-command overlays
   (lower priority: the README already covers half of it).
3. **SDK version comparison**: run the suite against 0.11.0 (the hackathon pin) and 0.18.0, and
   record the differences.
4. **M2**: LangChain deepagentsjs provider tested with `@langchain/sandbox-standard-tests`; run a
   real port-less `HarnessAgent` harness on the Wasmer provider; explore ports in `network: host`
   mode (it would allow bridge-backed harnesses); port the MCP Sentinel fixture as workload #1.

## Open decisions (ask the user)

- Where harness state should live: `$HOME` is currently inside the working directory, and the AI
  SDK harness docs ask for it to be outside. Only `/workspace` persists, so moving it out loses state.
- Lower the Node floor to `^22.19.0 || >=24`? CI proves 22.19.0–22.23.0 run Python; the floor is
  still `^22.23.0`.
- Commit `upstream-drafts/` to the public repo, or keep the drafts local until they're filed?
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
- Don't use `yes | head` (or anything that dies of SIGPIPE) in assertions on stderr: the runtime can
  add noise lines. Generate output with `printf` instead. This machine never shows it; CI runners do.
- The `.wasmer` cache key hashes the lockfile and package sources/tests, so most commits restore
  from a partial match (`wasmerCache: "partial"` in provenance).
- `@wasmer/sdk` releases near-daily. Check `npm view @wasmer/sdk version` before assuming 0.18.0 is current.

## Rules that still apply

No host mounts or secrets in sandboxes; networking stays off unless a test is about networking.
Report failures as they are. Don't publish packages, file upstream issues or contact Wasmer without
the user's go-ahead. Never use the `@wasmer` scope or imply endorsement.
