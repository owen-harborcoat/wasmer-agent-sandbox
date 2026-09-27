# Suite stalls on CI runners (SDK 0.18.0)

The real-Wasmer suite occasionally stops making progress on GitHub runners. It has never happened
locally. Raw Node reports and gdb dumps are in the stress-run artifacts. They aren't committed
here because Node reports include the runner's environment.

## Occurrences

| Run | Leg | What happened |
|---|---|---|
| CI 36234294973 (scheduled) | ubuntu-24.04 / Node 22.23.0 | core file passed in 11 s, then no output until the 30 min job limit |
| Stress 36293213824, attempt 3 | ubuntu-24.04 / Node 24.21.0 | deadlock (below) |
| Stress 36293213824, attempt 5 | ubuntu-24.04 / Node 24.21.0 | busy main thread (below) |
| Stress 36294840179, attempt 15 | ubuntu-24.04 / Node 24.21.0 | busy main thread and SDK worker, session file alone (below) |

That's 2 of 20 full-suite stress jobs, and 18 passed in 30–45 s. The other legs, and all Windows runs
so far, have not stalled.

Round 1 ran one test file per job (ubuntu-24.04, Node 24.21.0):

| Run | File | Stalled |
|---|---|---|
| 36294840179 | `ai-sdk/test/session.wasmer.test.ts` | 1 of 20 (attempt 15) |
| 36294844376 | `core/test/sandbox.wasmer.test.ts` | 0 of 10 |
| 36294848396 | `ai-sdk/test/generate-text.wasmer.test.ts` | 0 of 10 |

So the session file stalls without any help from other files.

## Attempt 3: SDK workers deadlocked during initialization

- The `ai-sdk` session tests' `run` cases returned `exitCode: 137` with empty output after 60 s (the
  core's default `timeoutMs`), 60 s and 120 s after starting. Commands were queued but never ran.
- The vitest fork's main thread was idle (`ep_poll`), and its timers still fired.
- All six SDK worker threads had the same JS stack, inside wasm-bindgen module initialization:
  `__wbg_init` → `__wbg_finalize_init` → `$__wbindgen_start`. Natively they were parked in
  `v8::internal::FutexEmulation::WaitSync` (`Atomics.wait`). None of them finished initializing,
  so the SDK's per-worker message queue (`pendingMessages` in `node-worker.ts`) was never drained.

## Attempt 5: main thread spinning

- It stalled after `files > shares one filesystem between file operations and commands`. Not even
  the 180 s test timeout was reported.
- The fork's state was `R` (running). Its main thread was in JIT code, repeatedly in
  `v8::internal::HashTable<ObjectHashSet>::Rehash` (a growing JS `Set`), and there were no SDK
  worker threads. Node's report-on-signal couldn't run, so there's no JS stack. The cause is
  unknown, and it could be in the SDK, vitest or our code.

## Stress 36294840179, attempt 15: main thread and worker both busy

- The last test to finish was `limits > tells the model on stderr when a command times out` (831 ms).
  The next one, `limits > ... output is truncated`, never finished. No other client was open by then:
  the earlier `describe` blocks close theirs in `afterAll`.
- The timeout test runs `echo partial >&2; sleep 30` as the *first* command on a fresh client with
  `timeoutMs: 500`. The SDK's timeout fires late there (wasmerio/wasmer-sdk#539), so core's host-side
  backstop calls `kill()` at 750 ms, and `session.destroy()` then closes the sandbox and the client
  right away. The truncation test then starts another fresh client.
- The vitest fork was `R` (running). It had two busy threads: the main thread, and a single SDK
  worker thread (`worker-15`). Both were in JIT or wasm code with no symbols. Both stacks hold the
  same two values, `0x7fcdac000000` and `0x7fcdac17a2b4`, which look like a wasm shared-memory base
  and a word at offset `0x17a2b4` in it. All the other threads were idle. Node couldn't write a
  report for the fork.

Hypothesis, not confirmed: two threads spinning on one shared-memory word points at a spin lock
whose holder is gone. A worker that `close()` terminated while it was still tearing down the
killed process could leave it held. Rust's wasm allocator, for example, spins instead of blocking
when built with atomics. The attempt 3 deadlock (workers parked in `Atomics.wait` inside
`__wbindgen_start`) would fit the same idea with a blocking lock. Attempt 5 (spinning in
`HashTable::Rehash`) doesn't obviously fit.

## Repro attempts

`repro.mjs` cycles fresh clients next to a long-lived one, as the suite does:

| Mode | Runs | Result |
|---|---|---|
| `basic` (create, run, close) | 20 jobs × 300 iterations, ubuntu-24.04 + windows-2025 (36293657915) | 6,000 / 6,000 ok |
| `lifecycle` (+ timeout, kill, terminate, close while running) | 20 jobs × 60 iterations (36294051258) | 1,200 / 1,200 ok |

In `lifecycle` the timed-out command isn't the client's first, so the SDK's own timeout stops it and
nothing is killed from the host right before `close()`. Mode `kill-close` copies the limits tests
instead: locally (Windows) every iteration took the host-kill path (`host kill/terminated`, 10 of 10).
The stress job now runs the repro under the watchdog, because a busy main thread can't fire the
repro's own stall timer, and the gdb dump includes the instructions at each thread's pc.

So far only the suite triggers it. Not filed upstream yet: it needs a repro, or at least a
narrower trigger.
