# SDK 0.19.0: `RefCell already borrowed` panic on Node 22

Found 2026-10-06 in the stress run for the 0.19.0 bump. Not filed.

## What happens

Partway through `packages/core/test/sandbox.wasmer.test.ts`, an SDK worker panics:

```
panicked at .../wasmer-3a90f166c3ea3f2f/5bd2b7d/lib/wasix/src/state/handles/thread_local.rs:126:31:
RefCell already borrowed
```

The stack is all wasm, entered from a wasm-bindgen closure run as a microtask. The next command
gets `Wasmer SDK worker error: Error [RuntimeError]: unreachable`, and every command after that fails
with `EXECUTION_ERROR ... the thread pool is shut down: Scheduler is dead`. The rest of the file fails.

It shows up right after one of three tests: the two TTY tests (`[ -t fd ]` on the command's own
fds, and inside a pipe/redirect), or the abort test (host `terminate()` of `sleep 30`).

The same panic site was seen once on 0.18.0, on Windows CI (36331465337, Node 22.19.0, where it hung the
suite), and once in the 0.18.0 control below (Node 24).

## Runs (all GitHub `ubuntu-24.04` unless noted)

| Run | SDK | What ran | Node | Jobs | Panic | Other failures |
|---|---|---|---|---|---|---|
| 37557234148 | 0.19.0 | full suite | 22.23.0 | 10 | **5** | 1 allocator-lock stall after an abort test (#542 shape) |
| 37557234148 | 0.19.0 | full suite | 24.21.0 | 10 | 0 | 1 stream chunk split (test fixed in `10c3557`) |
| 37557236811 (CI) | 0.19.0 | full suite | 22.19.0, Linux + Windows | 2 | **2** | |
| 37557236811 (CI) | 0.19.0 | full suite | 24.21.0, Linux + Windows | 2 | 0 | Linux: a file's `afterAll` close hung 60 s |
| 37558583262 | 0.19.0 | `sandbox.wasmer.test.ts` only | 22.23.0 | 20 | **13** | 1 of them also stalled |
| 37558585703 | 0.19.0, no `onProgress` observer | `sandbox.wasmer.test.ts` only | 22.23.0 | 20 | **9** | provenance test fails by design on this branch |
| 37557426352 | 0.19.0 | 4 tests: pipe/redirect TTY + the next three | 22.23.0, 24.21.0 | 40 | 0 | |
| 37557429631 | 0.19.0 | 4 tests: own-stdio TTY + the same three | 22.23.0, 24.21.0 | 40 | 0 | |
| 37559277682 | 0.18.0 | `sandbox.wasmer.test.ts` only | 22.23.0 | 20 | **0** | |
| 37558335759 | 0.18.0 | full suite incl. conformance | 22.23.0, 24.21.0 | 20 | 1 (Node 24) | 1 unhandled `ECONNRESET` on a test listener (test fixed in `c7f10c1`) |

Locally (Windows 11, Node 24.21.0) none of 8 full runs on either version panicked.

## What this says

- **It's a 0.19.0 regression, on Node 22.** The same test file panics in 22 of 40 jobs on 0.19.0 and
  0 of 20 on 0.18.0. On 0.19.0, Node 24 panicked in 0 of 12 full-suite jobs.
- The `onProgress` observer added to `WasmerSandbox.create` the same day isn't the cause (9/20 without it).
- The conformance file isn't the cause: vitest runs each file in its own worker (`isolate: true`), and the file
  alone panics.
- No single test triggers it. The TTY tests with their neighbours were clean 80 of 80, so it needs the
  earlier tests in the file too (several sandboxes and commands on one client). Not narrowed further.

## Consequences here

The repo's floor is Node `^22.19.0`, and CI runs it on both OSes. With 0.19.0 pinned, about half of the
Node 22 legs would fail. So 0.19.0 isn't ready to pin on `main` as it stands.
