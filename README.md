# wasmer-agent-sandbox

Local [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) sandboxes as an execution backend for agent
frameworks, plus a conformance lab that records where the alpha SDK works and where it breaks.

Community project, not affiliated with or endorsed by Wasmer.

Status: M1 done (core, AI SDK adapter, conformance v0). See [PLAN.md](PLAN.md).

## Found so far

Against `@wasmer/sdk` 0.18 and 0.19, mostly on Linux CI:

- **Node 24 crashes** with a V8 CHECK (`jit_page_->allocations_.erase(addr) == 1`) or a SIGSEGV in
  ~5% of processes that create and close clients with a kill in between. It's a V8 bug that's fixed
  upstream but not in 24.x: [nodejs/node#66366](https://github.com/nodejs/node/issues/66366), backport
  in [nodejs/node#66376](https://github.com/nodejs/node/pull/66376). Node 22 and 26 don't hit it, and
  `--no-wasm-code-gc` avoids it on 24.
- **`kill()` can hang the whole process** on any Node version: it can terminate a worker while that
  worker holds the SDK's allocator lock, and every thread then spins forever.
  [wasmerio/wasmer-sdk#542](https://github.com/wasmerio/wasmer-sdk/issues/542). The repro fails within
  minutes on CI, so a fix is easy to check. Evidence for this and the Node 24 crash:
  [findings](spikes/2026-09-27-sdk-0.18-worker-init-hang/findings.md).
- `timeoutMs` fires late while the guest sleeps ([#539](https://github.com/wasmerio/wasmer-sdk/issues/539)),
  SIGPIPE leaves noise in stderr ([#540](https://github.com/wasmerio/wasmer-sdk/issues/540)), and Python
  guests need Node ≥ 22.19 ([#541](https://github.com/wasmerio/wasmer-sdk/issues/541)).
- A guest that sends itself SIGTERM (`kill -TERM $$`) crashes or hangs the host process within a
  few repeats. On 0.19.0 a child process doing it is enough.
  [findings](spikes/2026-10-06-sdk-0.18-guest-signals/findings.md)
- A `RefCell already borrowed` panic kills the SDK partway through a test file, mostly on Node 22. Which
  short commands run in which order decides it: one test split into two commands takes a file from 0 to
  about half of CI runs, on 0.18 and 0.19 alike.
  [findings](spikes/2026-10-06-sdk-refcell-panic/findings.md)
- `fs.stat`, `readDir`, `mkdir` and `remove` reject with an error `WasmerError.is()` doesn't recognise.
  Fix: [wasmerio/wasmer-sdk#554](https://github.com/wasmerio/wasmer-sdk/pull/554).

We're on 0.19.1 now. 0.19 fixes the SIGPIPE noise (#540) and the TTY report for pipes inside a guest.
Comparison with 0.18.0 in [PLAN.md](PLAN.md).

## Development

Requires Node 24 (or 22.19+) and pnpm 10.

```bash
pnpm install
pnpm check         # lint, typecheck, unit tests
pnpm test:wasmer   # real Wasmer sandboxes; first run downloads packages into ./.wasmer
```
