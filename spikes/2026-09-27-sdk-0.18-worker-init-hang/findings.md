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

### `0x17a2b4` is the global allocator's lock

`wasmer_sdk_js_bg.wasm` has no name section, so this comes from scanning its code. The word at
`0x17a2b4` is only ever accessed by `i32.atomic.rmw.xchg` (7 sites, no `wait`/`notify`), so it's a lock
that is taken by `swap(1)` in a loop and released by `swap(0)`, and it never parks. The futex-style
mutexes next to it (`0x17a2e0`, `0x17a2f4`) use cmpxchg + `wait32`/`notify` instead. The seven functions are
reached from `__wbindgen_malloc`, `__wbindgen_free`, `__wbindgen_realloc` and every `__wbg_*_free`
export, so it's the global allocator's spin lock (the shape of Rust std's wasm32+atomics dlmalloc
lock). It sits just past the data segments, in `.bss`.

In the SDK source (`main` at `d1aa52b`, 2026-09-24): a kill goes through wasix `terminate_worker` →
`SchedulerMessage::TerminateWasmThread` → `terminate_wasm_thread`, which drops the `WorkerHandle`.
`WorkerHandle::drop` calls `Worker::terminate()` right away (`js/bindgen/src/tasks/worker_handle.rs`).
Closing the client drops every handle the same way, and the Node adapter doesn't await
`terminate()`. A worker stopped inside malloc/free on the shared memory never releases the lock.

## Controls (20 jobs × 10 processes × 30 iterations each, ubuntu-24.04)

| Run | Arm | Failed jobs | V8 crash | Stall |
|---|---|---|---|---|
| 36300951450 + 36300955555 | baseline, Node 24.21.0 | 8 + 9 / 40 | 16 | 1 |
| 36331470220 | `kill-close-shared`: one long-lived client | **0 / 20** | 0 | 0 |
| 36331476279 | Node 22.23.0 | 6 / 20 | **0** | 6 |
| 36331482459 | `--no-memory-protection-keys` | 10 / 20 | 8 | 2 |
| 36331488916 | `--no-wasm-code-gc` | 2 / 20 | **0** | 2 |

Every arm took the host-kill path on every iteration (`host kill/terminated` 30/30 per process), and
`execArgv` in the results confirms the flags. So there are two separate bugs:

- **V8 crash:** Node 24 only, caused by wasm code GC (`--no-wasm-code-gc` removes it), not PKU. Belongs
  on nodejs/node#64500.
- **Allocator-lock stall:** Node 22 and 24, with every flag tried. It's the SDK's. On Node 24 the
  crash usually comes first, which is why stalls looked rare there.
- A long-lived client prevented both in the repro (6,000 iterations). We don't know why yet. The suite
  now keeps one open per test file (`packages/core/test/keep-client-open.ts`) as a workaround.

### The suite with the workaround: rarer, not gone

Stress 36333372198 (full suite, 20 jobs each on Node 22.23.0 and 24.21.0, `b3c53e2`): 1 of 40
stalled (Node 22.23.0, attempt 8), again right after `limits > ... times out`. The only busy thread was
the main thread, in the same `xchg` loop on `rdi = 0x7f0ab017a2b4`, offset `0x17a2b4` again. No SDK
worker thread was left in the process, so the lock holder had already been terminated. Round 1's
attempt 5 (busy main thread, no workers) was probably the same thing.

Before the workaround, full-suite runs stalled in 2 of 20 jobs. With it, 1 of 40. That's too few
to call it a real improvement, and it doesn't prevent the stall.

Drafts: `upstream-drafts/06` (wasmer-sdk, the stall) and `07` (comment on nodejs/node#64500). Neither
filed.

## Why does an open client help? Two more arms, and Node 26

Same shape as the controls (20 jobs × 10 processes × 30 iterations, ubuntu-24.04, `5a64a94`). Every process
took the host-kill path on all 30 iterations.

| Run | Arm | Processes run | V8 CHECK / SIGSEGV | Stall | Other |
|---|---|---|---|---|---|
| 36334735882 | `kill-close-module`, Node 22.23.0 | 157 | 0 / 0 | 6 | 0 |
| 36334735882 | `kill-close-module`, Node 24.21.0 | 163 | 6 / 3 | 0 | 0 |
| 36334737610 | `kill-close-idle`, Node 22.23.0 | 173 | 0 / 0 | 6 | 0 |
| 36334737610 | `kill-close-idle`, Node 24.21.0 | 161 | 2 / 6 | 0 | 0 |
| 36334739507 | `kill-close`, Node 26.10.0 | 185 | **0 / 0** | 1 | 3 (below) |

- Keeping every compiled module alive (`kill-close-module`, 60–61 modules held per process) changes nothing.
  Neither does an open client that never created a sandbox (`kill-close-idle`). The long-lived client in
  `kill-close-shared` ran a command, so it has live workers with live instances. That's what makes the
  difference, not the client object or the compiled bash module.
- All three stalls I checked (Node 26 attempt 12, module arm Node 22 attempt 11, idle arm Node 22) are on
  the same lock: a register holding `base + 0x17a2b4`. So the allocator stall happens on Node 22, 24 and 26.
- Node 26.10.0 had no V8 crash in 185 processes. At Node 24's rate (~5% of processes) you'd expect about 9.

### The V8 crash is a known, fixed V8 bug that 24.x doesn't have

Node 24.21.0 ships V8 13.6.233.17. Its `WasmImportWrapperCache::MaybeGet` does
`WasmCodeRefScope::AddRef(it->second)` and only then checks `is_dying()`. `Runtime_TierUpWasmToJSWrapper`
opens a `WasmCodeRefScope` and calls `MaybeGet`. So a wrapper that code GC is freeing on another thread
gets a ref in the scope, and when the scope unwinds (`~WasmCodeRefScope` → `DecrementRefCount` →
`FreeDeadCode` → `WasmImportWrapperCache::Free`) it's freed a second time. Its JIT allocation is already
unregistered, hence the CHECK. That's exactly our stack.

V8 fixed it in `9b8ca54d5a` ("[wasm] Fix lookup of wrappers marked is_dying", 2025-04-11, crbug 409379692),
which isn't in 13.6. Node's `v24.x` and `v24.x-staging` still have the old `MaybeGet` (checked 2026-09-27),
and no backport PR or issue exists. `68210d500a` (the CHECKs it builds on) and then `9b8ca54d5a` apply
cleanly onto `v24.x-staging`'s `deps/v8` (`git apply --check` on the four touched files; not built).
Import wrappers became per-process in `a5999be590`, which 13.6 has and 22.x's V8 12.4 doesn't. That fits
"Node 24 only".

It also explains why only a client with live instances helps: while any instance still uses a wrapper,
the wrapper never dies, so there's nothing to race with.

### New on Node 26.10.0: a DataView RangeError in an SDK worker

3 of 20 jobs failed in `Wasmer.close()` right after the kill, with `WORKER_FAILED`:

```
Wasmer SDK worker error: RangeError [Error]: Offset is outside the bounds of the DataView
    at DataView.prototype.setInt32 (<anonymous>)
    at __wbg___wbindgen_string_get_b0ca35b86a603356 (.../@wasmer/sdk/pkg/wasmer_sdk_js.js:1333:34)
    at wasm://wasm/01254326:wasm-function[8023]:0x405b41
```

The glue's `getDataViewMemory0()` rebuilds its view whenever `wasm.memory.buffer` changes identity or
length, so either the pointer from wasm is outside memory or this worker's `memory.buffer` hasn't caught
up with a grow on another thread. None in the ~770 Node 22 and 24 processes of these runs and baseline 36300951450 (grepped the job logs). Not investigated yet.

### The backport, built and tested

`node-backport.yml` run 36353991873: Node `v24.x-staging` at `13987f4` built from source on ubuntu-24.04
(reports `24.21.1-pre`, V8 `13.6.233.17-node.53`), once as is and once with V8 `68210d500a` then
`9b8ca54d5a` applied (both clean, only `deps/v8/src/wasm`). `kill-close`, 20 jobs × 10 processes × 30
iterations each, host-kill path on every iteration:

| Build | Processes run | V8 CHECK / SIGSEGV | Stall |
|---|---|---|---|
| as is | 149 | 3 / 5 | 0 |
| + the two V8 commits | 191 | **0 / 0** | 1 (`0x17a2b4`, the SDK lock) |

At the unpatched rate (8 in 149) you'd expect about 10 crashes in 191 processes. So the backport fixes the
V8 crash, and the SDK stall is untouched, as expected.

Filed 2026-09-27: the stall as wasmerio/wasmer-sdk#542, the V8 crash as nodejs/node#66366 (a backport
request), cross-linked on nodejs/node#64500.
