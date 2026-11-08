# SDK main (ddbd6cd, unreleased) on Windows and Linux

2026-11-07. Wasmer merged fixes for wasmer-sdk#542 and #556 (#578) and #547 (#579, #581–#584, plus
edgejs#180) on SDK `main` the same day, and closed #542 and #556. None of it is released: npm `latest`
is still 0.19.1. syrusakbary measured on macOS arm64 only and listed Linux, Windows, browsers and
`wasmer/edgejs-quickjs` as not measured. This fills in Windows and Linux, on the packages we use.

## Build under test

wasmer-sdk CI run 42413101852 (push to `main`, `ci.yml`, success), artifact
`wasmer-sdk-js-ddbd6cda7ae1ddc7f744ae42225137c859e9b981` (`js/dist` + `js/pkg`, kept one day), packed
with that commit's `js/package.json` and LICENSE as `0.19.1-main.ddbd6cd`, tarball sha256
`e30193922f22cb45bfd2daf041927cae81e5a242c90e3e95c934944c1e12d984` (same bytes locally and on every CI
job). `.github/scripts/use-sdk-artifact.sh` does the packing and the pnpm override; `stress.yml` takes it
as `-f sdk_run=<wasmer-sdk run id>` and refuses runs that aren't a successful push to wasmer-sdk `main`.
Each job's `sdk-artifact.json` records run, commit, version and sha256; provenance reports the version.

Local: Windows 11 10.0.26200, 24 threads, Node 24.21.0, warm cache. CI: `ubuntu-24.04` and
`windows-2025` runners (4 vCPU), Node 22.23.0 and 24.21.0.

## Results

| | 0.19.1 | main ddbd6cd |
|---|---|---|
| Full suite (201 real-Wasmer tests), local | clean | clean (`raw/suite/win32-local-suite.json`) |
| Suite stress, ubuntu, 20 jobs each on Node 22.23.0 and 24.21.0 | 1 stall of 40 (37680056447, 82-test suite) | **0 of 40** (42425051057) |
| Suite stress, windows-2025, 5 jobs each on Node 22.23.0 and 24.21.0 | – | **0 of 10** (42425053208) |
| #542 kill-close repro, ubuntu, Node 22.23.0, 20 jobs × 10 processes × 30 iterations | 4 of 20 jobs hung (37680065612, watchdog) | **0 of 20** (42425055114) |
| #542 kill-close repro, windows-2025, Node 22.23.0, 5 jobs | **4 of 5 hung** (42425060096, 27-min step timeout) | **0 of 5** (42425057716) |
| kill-close repro, ubuntu, Node 24.21.0, 10 jobs: V8 `Check failed` crash (nodejs/node#66366) | 3 of 10 (42426051645) | **0 of 10** (42426049503) |
| #556 a lone busy loop after timeout or `kill()`: host CPU over the next 3 s, `wasmer.close()` | ~1 core, close never resolves | **~0.18 cores (the 500 ms grace), 1–7 ms**, every shape, all three hosts |
| #556 a busy loop stopped by a timeout, then a command in another sandbox straight away | ~1 core each, close hangs | **still ~1 core each, close hangs** (see below) |
| #547 Edge.js sandboxes, RSS after 60 (see table below) | 1.8–2.5 GB edgejs, 0.8–1.3 GB edgejs-quickjs | **0.45–0.72 GB**, flat |
| Guest that SIGTERMs itself, 4 × 20 iterations, local | 3 of 4 failed | **4 of 4 failed** (3 hangs, 1 `RuntimeError: unreachable`) |
| Child that SIGTERMs itself, same | 4 of 4 failed | **4 of 4 failed** (2 hangs, 2 crashes incl. `unaligned accesses`) |
| Guest self-signal on CI runners, main only, 4 jobs per shape per OS | – | **16 of 16 failed** (42425084276, 42425086715) |

Pinned conformance behaviours that #578–#584 didn't target (stdio tty, `terminate()` reporting 143,
sync fs errors, `/dev/tcp`) are unchanged: the suite passes with every pin in place. The core's
`readDir`/`stat`/`mkdir`/`remove` are still synchronous on `main`, so wasmer-sdk#554 is still needed.

## #556: fixed for a lone loop, not when the next command starts right away

`busy-loop.mjs` on main, local (raw `raw/busy-loop/`): every shape that kept a core on 0.19.1 now
drops to ~0.18 cores over the 3 s after the stop, which is one core for the 500 ms grace, and
`wasmer.close()` takes 1–7 ms. Same on both runners for `quickjs timeout` and `python kill`.

| Shape | Stop | Cores over 3 s after | `wasmer.close()` |
|---|---|---|---|
| `node -e 'for (;;) {}'` (edgejs-quickjs) | timeout / kill | 0.18 / 0.18 | 4 / 2 ms |
| same, loop calling `fs.statSync` | timeout / kill | 0.18 / 0.17 | 4 / 1 ms |
| `node -e 'for (;;) {}'` (edgejs, host JS) | timeout | 0.20 | 4 ms |
| `python -c 'while True: pass'` | timeout / kill | 0.18 / 0.20 | 5 / 1 ms |
| python loop calling `os.stat` | timeout | 0.20 | 5 ms |
| `bash -c 'while :; do :; done'` | timeout | 0.04 | 7 ms |
| node `setTimeout` 60 s (control) | timeout | 0.01 | 7 ms |

But `starve.mjs` still showed one more busy core per stopped loop (12 loops → 12.09 cores locally, 4.0 on
the 4-vCPU runners). It runs `echo ok` in a fresh sandbox right after each timeout. `stop-then-run.mjs`
isolates it: three python loops stopped one after another on one client, then the first column after
each (local; raw `raw/stop-then-run/`):

| After each timeout | Cores busy 2–3 s later | `wasmer.close()` |
|---|---|---|
| nothing | 0, 0, 0 | 6 ms |
| `echo ok` in a new sandbox straight away (~6–26 ms) | 0.98, 1.97, 2.89 | pending at 15 s |
| same 100 / 300 / 450 / 600 / 800 / 1000 ms later | 0 (max 0.02) | done |
| close the timed-out sandbox (0 ms), then `echo ok` in a new one | 0.92, 2.06, 3.03 | pending |
| close the timed-out sandbox only | 0, 0.08, 0 | 6 ms |
| run a command in the timed-out sandbox itself | 0.89, 1.99, 2.97 | pending; that command itself timed out at 15 s for loops 2 and 3 |
| `kill()` instead of the timeout, then `echo ok` straight away | 0, 0, 0 (quickjs 0, 0.16, 0) | done |

Same for the edgejs-quickjs loop (1, 2.03, 2.91), and on both runners for python and quickjs (1, 2, 3;
`close()` pending).

Cause, from `__wasmerSchedulerDiagnostics` (`WASMER_SCHEDULER_DIAGNOSTICS=1`, raw `*-diagnostics.txt`)
and `js/bindgen/src/tasks/scheduler.rs` at ddbd6cd: the scheduler finds the worker to stop through
`wasm_workers`, keyed by the guest's `(pid, tid)`, and every sandbox's first guest is `wasm-1.1`.
When the next sandbox's command is posted before the scheduler handles `TerminateWasmThread`, its entry
replaces the timed-out one. The terminate then dooms the new command's worker; that worker finishes,
reports `WorkerIdle`, which clears `doomed` ("the killed thread unwound on its own"), and the spinning
worker never gets a `ForceTerminate` and is no longer in `wasm_workers`. `close()` then waits on it
forever (`draining close busy=2 wasm=0`). With a 300 ms gap the order is `terminate wasm=1.1` →
`create worker` → `force terminate worker=1`; straight away it is `create worker` → `terminate wasm=1.1`
→ `idle worker=2`, and no force terminate. The scheduler's own comment already notes that "Guest
PIDs/TIDs can repeat across sandboxes sharing this pool".

Impact for agents: this is the normal loop (a tool call times out, the next one starts at once), so
on main a model-written infinite loop still keeps a core and wedges `close()` in practice.

## #542 and the Node 24 V8 crash

`spikes/2026-09-27-sdk-0.18-worker-init-hang/repro.mjs kill-close`, 30 iterations × 10 fresh processes
per job, no long-lived client (tallies in `raw/kill-close/tally.tsv`). On 0.19.1 the failures are the
#542 hang (main thread wedged, timers dead; the Linux watchdog fires at 210 s, Windows runs into the
27-minute step timeout) and, on Node 24, V8's `Check failed: jit_page_->allocations_.erase(addr) == 1`.
On main: 35 of 35 jobs clean, 350 processes, 10,500 kill-close iterations.

The V8 crash is a Node 24 bug (nodejs/node#66366, backport #66376 still unreviewed), so main doesn't fix
it; main just stops setting it off here, presumably because workers now exit from their own message loop
and the main thread frees their stacks, instead of being terminated mid-run. That matters for
`keep-client-open.ts`, our workaround for both: once this ships, the suite can try running without it on
Node 22 and 24 (one stress run for that change alone).

## #547: memory

`leak.mjs` (now takes a package): 60 sandboxes on one client, each runs a one-line script and is closed,
`--expose-gc`, Node 24.21.0. RSS in MB: median from sandbox 10 on, peak in brackets, then after
`wasmer.close()`. Raw `raw/leak/`; CI runs 42425082025 / 42425077176 (0.19.1) and 42425079632 /
42425074747 (main).

| Host, package | 0.19.1 | main ddbd6cd |
|---|---|---|
| ubuntu-24.04, `wasmer/edgejs` | 1950 (2513), 1795 after close | 665 (720), 564 |
| windows-2025, `wasmer/edgejs` | 1895 (2289), 1952 | 581 (631), 466 |
| Windows 11 local, `wasmer/edgejs` | 1734 at 60 (2201 over 120), 1907 (2026-10-11 run) | 484 (578), 414 |
| ubuntu-24.04, `wasmer/edgejs-quickjs` | 931 (1274), 1265 | 514 (537), 399 |
| windows-2025, `wasmer/edgejs-quickjs` | 833 (1153), 966 | 445 (509), 366 |
| Windows 11 local, `wasmer/edgejs-quickjs` | – | 457 (466), 321 |

So Linux and Windows on Node 24.21 land where syrusakbary's macOS Node 24.16 numbers did (~530–570 MB
for edgejs), and edgejs-quickjs, which he didn't measure, is fixed too. Memory comes back on
`wasmer.close()` now. These are with edgejs 0.2.5; edgejs#180 isn't published yet.

## Guest self-signal crash: not fixed

`spikes/2026-10-06-sdk-0.18-guest-signals/repro.mjs`, 4 processes per shape, 60 s limit, local (tally
`tally-win32-guest-signals-sdk0.19.1-main.ddbd6cd.txt`, raw `raw/guest-signals/`, local repo paths
stripped from the traces):

| Shape | Clean | Crash | Hang | Iterations before failing |
|---|---|---|---|---|
| `kill -TERM $$` (self-term) | 0 | 1 (`RuntimeError: unreachable`) | 3 | 4, 1, 8, 1 |
| `sh -c 'kill -TERM $$'` (child-self-term) | 0 | 2 (`command execution failed: RuntimeError`, `unaligned accesses`) | 2 | 5, 3, 20 then crashed, 3 |
| host `terminate()` of `sleep 30` | 4 | 0 | 0 | |
| `true` (control) | 4 | 0 | 0 | |

On the runners (main only, `tally-ci-guest-signals-sdk0.19.1-main.ddbd6cd.txt`), every job failed:
ubuntu self-term 4 hangs at iteration 1, child-self-term 2 `RuntimeError: js: memory access out of bounds`
and 2 hangs; windows self-term 1 `RuntimeError: unreachable` and 3 hangs, child-self-term 4 hangs. (On
Windows a hang shows as the 17-minute step timeout: `with-watchdog.sh` doesn't kill there.)

#578 rewrote how killed workers stop, but a guest that signals itself still crashes or hangs the host
process, as on 0.18.0–0.19.1, now on Linux runners too. Still unfiled; the strongest candidate for the
next issue.

## Not covered

Browsers, macOS, Node 26, Bun. The native SDKs' half of #556 (wasmer-sdk#580, wasmerio/wasmer#7146) is
Unix only and not tested here. edgejs `main` (#180 and 18 other commits) is unpublished, so every Edge.js
number above is edgejs 0.2.5.
