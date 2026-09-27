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

That's 2 of 20 stress jobs, and 18 passed in 30–45 s. The other legs, and all Windows runs so far,
have not stalled.

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

## Repro attempts (no stall yet)

`repro.mjs` cycles fresh clients next to a long-lived one, as the suite does:

| Mode | Runs | Result |
|---|---|---|
| `basic` (create, run, close) | 20 jobs × 300 iterations, ubuntu-24.04 + windows-2025 (36293657915) | 6,000 / 6,000 ok |
| `lifecycle` (+ timeout, kill, terminate, close while running) | 20 jobs × 60 iterations (36294051258) | 1,200 / 1,200 ok |

So far only the full suite triggers it. Not filed upstream yet: it needs a repro, or at least a
narrower trigger.
