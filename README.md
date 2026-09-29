# wasmer-agent-sandbox

Local [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) sandboxes as an execution backend for agent
frameworks, plus a conformance lab that records where the alpha SDK works and where it breaks.

Community project, not affiliated with or endorsed by Wasmer.

Status: M1 in progress. See [PLAN.md](PLAN.md).

## Found so far

Against `@wasmer/sdk` 0.18.0, mostly on Linux CI:

- **Node 24 crashes** with a V8 CHECK (`jit_page_->allocations_.erase(addr) == 1`) or a SIGSEGV in
  ~5% of processes that create and close clients with a kill in between. It's a V8 bug that's fixed
  upstream but not in 24.x: [nodejs/node#66366](https://github.com/nodejs/node/issues/66366), backport
  in [nodejs/node#66376](https://github.com/nodejs/node/pull/66376). Node 22 and 26 don't hit it, and
  `--no-wasm-code-gc` avoids it on 24.
- **`kill()` can hang the whole process** on any Node version: it can terminate a worker while that
  worker holds the SDK's allocator lock, and every thread then spins forever.
  [wasmerio/wasmer-sdk#542](https://github.com/wasmerio/wasmer-sdk/issues/542). The repro fails within
  minutes on CI, so a fix is easy to check.
- `timeoutMs` fires late while the guest sleeps ([#539](https://github.com/wasmerio/wasmer-sdk/issues/539)),
  SIGPIPE leaves noise in stderr ([#540](https://github.com/wasmerio/wasmer-sdk/issues/540)), and Python
  guests need Node ≥ 22.19 ([#541](https://github.com/wasmerio/wasmer-sdk/issues/541)).

Evidence and run ids: [findings.md](spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md).

## Development

Requires Node 24 (or 22.19+) and pnpm 10.

```bash
pnpm install
pnpm check         # lint, typecheck, unit tests
pnpm test:wasmer   # real Wasmer sandboxes; first run downloads packages into ./.wasmer
```
