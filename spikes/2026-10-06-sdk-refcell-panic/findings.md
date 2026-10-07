# `RefCell already borrowed` panic, triggered by how a test file is split into commands

Found 2026-10-06 in the stress runs for the SDK bump. Not filed. First blamed on 0.19.0; the A/B on
2026-10-07 showed that was wrong (below).

## What happens

Partway through `packages/core/test/sandbox.wasmer.test.ts`, an SDK worker panics:

```
panicked at .../wasmer-3a90f166c3ea3f2f/<rev>/lib/wasix/src/state/handles/thread_local.rs:126:31:
RefCell already borrowed
```

The stack is all wasm, entered from a wasm-bindgen closure run as a microtask. The next command
gets `Wasmer SDK worker error: Error [RuntimeError]: unreachable`, and every command after that fails
with `EXECUTION_ERROR ... the thread pool is shut down: Scheduler is dead`. The rest of the file fails.

It shows up right after the TTY checks (`[ -t fd ]`) or the abort test (host `terminate()`). The
same panic site was seen once before any of this, on Windows CI (36331465337, 0.18.0, Node 22.19.0).

## The trigger is the test split, not the SDK version

On 2026-10-06 the TTY test was split in two: one command checking the command's own fds 0/1/2, and
one checking a pipe and a redirect inside the guest. That change went in with the 0.19.0 bump, which
is why the panic was first blamed on 0.19.0. All runs below are `ubuntu-24.04`, Node 22.23.0,
`sandbox.wasmer.test.ts` alone, 20 jobs:

| Run | SDK | TTY test | Panics | Other failures |
|---|---|---|---|---|
| 37559277682 | 0.18.0 | one command | **0** | |
| 37678783265 | 0.18.0 | split in two | **11** | 1 hook timeout |
| 37558583262 | 0.19.0 | split in two | 13 | |
| 37558585703 | 0.19.0, no `onProgress` observer | split in two | 9 | |
| 37678225815 | 0.19.1 | split in two | 15 | |
| 37678778273 | 0.19.1 | one command | **0** | 2 allocator-lock stalls (#542 shape) |

Other runs with the split test: full suite on 0.19.0 (37557234148) panicked in 5 of 10 Node 22.23.0 jobs
and 0 of 10 Node 24.21.0 jobs; full suite on 0.18.0 (37677752451) in 2 of 10 Node 22.23.0 jobs; CI legs on
Node 22.19.0 (Linux and Windows) as well. With only the TTY tests and their three neighbours selected
(`-t`), the split was clean 80 of 80 (37557426352, 37557429631), so it needs the earlier tests in the
file too. Locally (Windows 11, Node 24.21.0) it never panicked.

## What this says

- It's an SDK bug that a particular sequence of short commands on one client sets off, mostly on Node 22.
  Nothing in the guest commands is unusual: `[ -t 0 ]` and friends, a pipe, a redirect, `pwd`.
- Not caused by 0.19.0, by our `onProgress` observer, or by the conformance file (vitest isolates files).
- Not narrowed to a minimal repro yet. Starting point: the first ~6 tests of `sandbox.wasmer.test.ts`
  with the split TTY test, run as a plain script in a loop on Node 22.

## Consequences here

The suite keeps the TTY checks in one command, which avoids the trigger (0 of 20 on both versions).
That's a workaround, not a fix: an agent's commands can hit the same sequence.
