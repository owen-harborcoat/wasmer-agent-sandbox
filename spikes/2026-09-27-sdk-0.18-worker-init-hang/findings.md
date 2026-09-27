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
| Stress 36297367277, attempt 17 | ubuntu-24.04 / Node 24.21.0 | same, with only the two `limits` tests selected (below) |

That's 2 of 20 full-suite stress jobs, and 18 passed in 30–45 s. The other legs, and all Windows runs
so far, have not stalled.

Round 1 ran one test file per job (ubuntu-24.04, Node 24.21.0):

| Run | File | Stalled |
|---|---|---|
| 36294840179 | `ai-sdk/test/session.wasmer.test.ts` | 1 of 20 (attempt 15) |
| 36294844376 | `core/test/sandbox.wasmer.test.ts` | 0 of 10 |
| 36294848396 | `ai-sdk/test/generate-text.wasmer.test.ts` | 0 of 10 |

So the session file stalls without any help from other files. Round 2 (36297367277) selected only
the two `limits` tests (`-t "limits"`, everything else skipped): 1 of 20 stalled, in the same place.

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

Attempt 17 of 36297367277 (limits tests only) stalled the same way: the timeout test passed
(1954 ms), then the truncation test hung, and the fork was `R` with the main thread and one worker
(`worker-6`) busy. This time the watchdog dumped the instructions at each pc. Both threads are in
the same shape of loop, a wasm atomic exchange retried until it returns 0:

```
worker-6:                                   MainThread:
=> test   %r8d,%r8d                         => mov    %rdi,-0x18(%rbp)
   je     <acquired>                           mov    $0x1,%r8d
   mov    %rdi,%r8                             ...
   xchg   %r8d,(%rcx)                          xchg   %r9d,(%rdi)
   test   %r8d,%r8d                            test   %r9d,%r9d
   je     <acquired>                           je     <acquired>
   cmp    -0x60(%r13),%rsp   (stack guard)     ...
   jbe    ...                                  cmp    -0x60(%r13),%rsp
   xchg   %edi,(%rcx)                          jbe    ...
   test   %edi,%edi                            xchg   %r8d,(%rdi)
   jne    <loop>                               test   %r8d,%r8d
```

That's a spin lock in shared wasm memory, and no live thread holds it.

`Wasmer.close()` ends in the client's wasm `shutdown()`, which terminates its workers through
`node-worker-adapter.js` (`worker.terminate()`). Node's `terminate()` stops a thread at its next
interrupt check, including in the middle of wasm code holding a lock in shared memory.

Hypothesis, now much stronger: two threads spinning on one shared-memory word points at a spin lock
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
On CI it did something worse than stall. Stress 36297366137 (20 jobs × 300 iterations,
ubuntu-24.04, Node 24.21.0): 2 jobs **segfaulted** (`Segmentation fault (core dumped)`, exit 139)
14 s and 25 s in, and the other 18 ran all 300 iterations (p50 1.0 s per iteration). `basic` and
`lifecycle` never crashed in 7,200 iterations. Locally (Windows), 300 of 300 passed. Both crashes
happened early in the process, so the job can now run many short processes, capture core dumps
(only the gdb summary is uploaded), and wait `close_delay_ms` between the kill and the close to test
whether the close is what leaves the lock held.

The stress job now runs the repro under the watchdog, because a busy main thread can't fire the
repro's own stall timer, and the gdb dump includes the instructions at each thread's pc.

## A/B: kill-to-close gap (the repro reproduces both problems)

Stress 36300951450 (gap 0 ms) and 36300955555 (gap 1000 ms): kill-close, 20 jobs × up to 10 fresh
processes × 30 iterations, ubuntu-24.04, Node 24.21.0. A job stops at its first failing process.

| Gap | Failed jobs | SIGTRAP (V8 CHECK) | SIGSEGV | Stall |
|---|---|---|---|---|
| 0 ms | 8 / 20 | 5 | 2 | 1 |
| 1000 ms | 9 / 20 | 6 | 3 | 0 |

That's about 150 processes per arm, so roughly 5% of fresh processes fail. The gap changes nothing,
so a race between the kill and the close is not the cause. What stands out is *where*: 15 of the 16
crashes happened at iteration 11, step `first command times out`, and the other at iteration 10. So
it happens at a fixed amount of client churn (about the 21st client and its workers in the process),
not at a random moment. `basic` and `lifecycle`, which never crashed, keep a long-lived client open
all the time. kill-close doesn't, and neither do the suite's `limits` tests.

### The crash is in V8

SIGTRAP is a failed V8 CHECK:

```
# Fatal error in , line 0
# Check failed: jit_page_->allocations_.erase(addr) == 1.
  3: v8::internal::ThreadIsolation::JitPageReference::UnregisterAllocation(unsigned long)
  4: v8::internal::ThreadIsolation::UnregisterWasmAllocation(unsigned long, unsigned long)
```

The core (gdb, 36300951450 attempt 20) continues `WasmCodeAllocator::FreeCode` ←
`WasmImportWrapperCache::Free` ← `WasmEngine::FreeDeadCode` ← `WasmCodeRefScope::~WasmCodeRefScope`
← `Runtime_TierUpWasmToJSWrapper`, on an SDK worker thread. The SIGSEGVs take the same path and crash
in `NativeModule::FreeCode` → `RecursiveMutex::Lock` (36300951450 attempt 16): V8 frees dead import
wrapper code for a native module that looks already freed.

This matches nodejs/node#64500 (open). PGlite users see the same CHECK on Linux CI in ~4–5% of runs
with Node 24.16–24.19, and `--no-wasm-tier-up` didn't help them. Prisma worked around it by awaiting
`worker.terminate()` on close, and with `--no-memory-protection-keys` (V8's PKU JIT write protection
is Linux-only, which would explain why Windows never crashes). The SDK's `node-worker-adapter.js`
does `void this.#worker.terminate()`, so `Wasmer.close()` doesn't wait for its threads to exit.

### The stall is one fixed lock in the SDK's wasm memory

36300951450 attempt 18 stalled in process 1, iteration 29, step `close (truncation)`. It looks like the suite's
stalls: the main thread and one worker (`worker-145`) are both spinning on `xchg`, and both have
`rdi = 0x7f59d417a2b4`. That's offset `0x17a2b4` from the memory base, the **same offset** as the suite
stall in 36294840179 (`0x7fcdac17a2b4`). So it's one static lock in the SDK's wasm linear memory, the
same one in the suite and in the SDK-only repro. Which static sits at `0x17a2b4` isn't known yet.

Not filed upstream yet. Next: find what's at `0x17a2b4`, rerun with a long-lived client, on Node
22.23, and with `--no-memory-protection-keys`, then write a short issue.
