# A guest that signals itself crashes or hangs the SDK

Found 2026-10-06 while writing conformance v0 (`packages/core/test/conformance.wasmer.test.ts`).
Not filed.

## What happens

A command whose top-level process sends itself an untrapped SIGTERM (`kill -TERM $$; echo after`)
exits 27, not 143, with `Program recieved termination signal: Terminated` and a run of
`Program recieved fatal signal: Aborted` lines in its stderr (the same lines as
wasmerio/wasmer-sdk#540). The follow-up command works. Repeat it a few times in the same process
and the SDK either crashes the host process or hangs it:

- `RuntimeError: memory access out of bounds` in the SDK's wasm, sometimes reported as
  `Wasmer SDK worker error`, followed by `EXECUTION_ERROR ... the thread pool is shut down:
  Scheduler is dead` for the next command
- `RuntimeError: table index is out of bounds`
- a hang with no output. Vitest's per-test timeout doesn't fire, so the event loop is blocked too.
  One run finished all 20 iterations and then hung in `close()`.

These match two of the intermittent Windows CI failures in HANDOFF.md (36333372121: memory access
out of bounds; 36518385645: "Scheduler is dead"). Both happened in the SIGPIPE probe, where
pipeline members die of a signal.

## Tally (SDK 0.18.0, Node 24.21.0, Windows 11 10.0.26200, warm cache)

`node spikes/2026-10-06-sdk-0.18-guest-signals/repro.mjs <shape> 20 <scope>`, 4 processes per row,
60 s limit per process. Raw lines: `tally-win32-sdk0.18.0.txt`; crash output: `raw-sdk0.18.0/`.

| Shape | Scope | Clean | Crash | Hang | Iterations done before failing |
|---|---|---|---|---|---|
| `kill -TERM $$` (self-term) | one sandbox | 0 | 2 | 2 | 1, 4, 1, 1 |
| `kill -TERM $$` (self-term) | new sandbox per iteration | 0 | 1 | 3 | 3, 1, 3, 20 (hung in close) |
| `sh -c 'kill -TERM $$'` (child-self-term) | one sandbox | 4 | 0 | 0 | |
| host `terminate()` of `sleep 30` | one sandbox | 4 | 0 | 0 | |
| host `kill()` of `sleep 30` | one sandbox | 4 | 0 | 0 | |
| `yes \| head -c 1000` (sigpipe) | one sandbox | 4 | 0 | 0 | |
| `true` (control) | one sandbox | 4 | 0 | 0 | |

So it's the command's own top-level process dying of its own signal. A child that does the same
(bash survives) is fine, and so are host-initiated terminate and kill. SIGPIPE was clean here, but
this machine has never shown the SIGPIPE noise either (0/90), while the Windows runners show it in
9–18 of 30 runs. A slower host may let SIGPIPE deaths hit the same path.

## Consequences here

- Conformance v0 doesn't run a self-signalling guest. With one in the suite, 2 of 3 local runs hung.
- Agents run arbitrary commands, so a model that runs `kill $$` (or a script that does) can take
  down the host process. The core can't prevent it from outside the guest.
