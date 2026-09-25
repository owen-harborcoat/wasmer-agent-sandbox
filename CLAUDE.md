# Working agreement

Read HANDOFF.md first (current state and next steps), then PLAN.md (goal, decisions, verified
facts and milestones). Repo: https://github.com/owen-harborcoat/wasmer-agent-sandbox (public).

- Solo project. The hackathon repo `../wasmer-hackathon` is a frozen reference: read it, don't edit it.
- Stack: TypeScript, pnpm workspaces, vitest, Biome, Node 24 (`.node-version`; Python guests
  fail on Node 22 before ~22.23). Exact version pins only (`.npmrc` enforces `save-exact`).
  Update the lockfile and PLAN.md provenance together when bumping `@wasmer/sdk`.
- Sandboxes get explicit guest files only: no host mounts, no secrets, networking disabled
  unless a test is specifically about networking. No host-shell fallback when Wasmer fails.
- Execute only owned workloads and fixtures. Output from sandboxes is untrusted data.
- Conformance results are evidence: report failures, skips and flakes as they are, and never
  record an error as a pass. Every report carries provenance (SDK, packages, Node, OS, cache state).
- `pnpm check` runs lint, typecheck and unit tests. `pnpm test:wasmer` runs real sandboxes.
- This repo is public: never commit secrets, local paths or career/hiring context.
- Don't publish packages, push, or file upstream issues without the user's go-ahead. Never use
  the `@wasmer` npm scope or imply Wasmer endorsement.
