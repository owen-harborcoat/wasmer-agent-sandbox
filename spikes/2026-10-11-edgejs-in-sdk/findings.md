# Edge.js inside `@wasmer/sdk` sandboxes (2026-10-11)

Node guests through `wasmer/edgejs` 0.2.5 (host JS engine via N-API) and `wasmer/edgejs-quickjs` 0.2.5
(QuickJS inside the module), `@wasmer/sdk` 0.19.1 (and 0.19.0 where noted), network disabled, guest
files only. Local runs: Windows 11 (10.0.26200), Node 24.21.0. CI runs: `stress.yml` `node-script` job,
`ubuntu-24.04` and `windows-2025`, Node 24.21.0 (and 22.23.0 for the leak run).

| CI run | What |
|---|---|
| 38185067570 | `pipes.mjs wasmer/edgejs`, ubuntu + windows |
| 38185069390 | `pipes.mjs wasmer/edgejs-quickjs`, ubuntu + windows |
| 38185071594 | `leak.mjs 120` with `--expose-gc`, ubuntu, Node 24.21.0 and 22.23.0 |

## What works

`node`, `edge`, `edgejs`, `npm` (10.34.5, aliased to pnpm per the package). ESM and CommonJS, `fs` in
`/workspace`, `child_process.execSync` of coreutils, async `spawn` of a node child with pipes,
`worker_threads`, timers (200 ms → 215 ms), `crypto`, exit codes, uncaught throw → exit 1, host-fed
stdin at the top level, per-command `env`. `process.version` says v24.13.2, platform `wasi`, arch
`wasm32`. `npx` isn't one of the package's commands (`COMMAND_NOT_FOUND`). Loopback `listen()` with
networking disabled gives `ENOTSUP`, as for Python.

## An Edge.js process loses its stdio when it's a pipe

Identical on Windows locally, `ubuntu-24.04` and `windows-2025`, for both packages (raw `pipes-*.jsonl`):

| Probe | stdout |
|---|---|
| `node log.js` (top level, control) | `7` |
| `node log.js \| cat` | empty, exit 0 |
| `x=$(node log.js)` | `captured=[]` |
| `console.log` then 300 ms alive `\| cat` | empty |
| 200 KB `process.stdout.write` `\| wc -c` | `0` |
| `fs.writeSync(1, …) \| cat` | `7` |
| `node log.js > file; cat file` | `7` |
| `echo hi \| node` reading `process.stdin` | `""` |
| `echo hi \| node` with `fs.readFileSync(0)` | `"hi\n"` |
| `spawnSync('node', …)` / `execSync('node …')` | empty, status 0 |
| `spawn('node', …)` (async) | `7` |

On a pipe, `process.stdout` is a plain `Writable` and `process.stdin` a plain `Readable`: Node's no-op
stdio for an `'UNKNOWN'` handle (`lib/internal/bootstrap/switches/is_main_thread.js`). Edge.js's
`GuessHandleType` (`src/edge_util.cc`) asks libuv's `uv_guess_handle(fd)`, and that can't classify the
fd because `fstat()` on a WASIX pipe returns `st_mode == 0` (`pipes-*`: "stdout kind: pipe"; bash
`[ -p /dev/stdin ]` says not-fifo too).

In Wasmer (`lib/wasix`, same at the SDK's pinned rev `5bd2b7d` and at main `4a7f16c`): `fd_pipe` makes
both ends with `create_inode_with_default_stat`, so `st_filetype` is `Filetype::Unknown`, and
`WasiFs::fdstat` maps pipe kinds to `Unknown` too. `Filetype` has no FIFO variant.

The top level goes the other way: `create_std_dev_inner` stamps every stdio inode `CharacterDevice`, so
a command whose stdout the host captures sees a terminal (`0o20000`, isatty true; raw
`top-level-tty-win32.jsonl`, and `python -` with host stdin opens the REPL). That's the remainder of
wasmerio/wasmer#6425. The two interact: if the top level stopped being a char device without a real pipe
type, Edge.js would drop top-level output as well.

Edge.js-side stopgap: in `GuessHandleType`, under WASI, treat an unknown handle on fds 0–2 as a file.
Node then uses `SyncWriteStream` and `fs.ReadStream`, and `fs.writeSync(1)` and `fs.readFileSync(0)`
already work on these fds.

## wasmer-sdk#547 memory growth: bounded on 0.19.1

The issue's repro (create, run `edge main.js`, close, forced GC), 120 sandboxes, one client, RSS in MB,
stopped at a 2.6 GB cap locally (raw `leak-*.jsonl`):

| | 1 | 10 | 20 | 30 | 40 | 60 | 80 | 100 | 120 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.19.0, Windows 11 | 405 | 1098 | 1664 | 2158 | 2639, cap | | | | | |
| 0.19.1, Windows 11 | 401 | 991 | 1357 | 1794 | 1688 | 1734 | 1684 | 2009 | 2026 | 2201 |
| 0.19.1, ubuntu-24.04 | 540 | 1177 | 1697 | 2031 | 2224 | 2339 | 2023 | 2211 | 2393 | 2610 |

0.19.0 grows ~55 MB per closed sandbox with no drops. 0.19.1 (wasmer-sdk#550) levels off after 30–40
sandboxes and saws between ~1.7 and 2.6 GB. That plateau holds with no sandbox open, well above the
~520–700 MB #550 reports for Node 26.

## Edge.js needs JSPI: Node 22 panics

On Node 22.23.0 (`ubuntu-24.04`) the first `wasmer/edgejs` command exits 1 and the SDK panics:
`the JavaScript host does not support WebAssembly JSPI` at `lib/api/src/backend/js/entities/function/mod.rs:115`.
The next command on the same client fails with `Scheduler is dead` (raw
`leak-ci-ubuntu-node22-sdk0.19.1.log`). Node 24.21.0 works. So Node guests need Node 24 and Python
guests ≥22.19, while the SDK's `engines` says `>=20` (wasmer-sdk#541).

## Host-JS mode isn't a sandbox yet

Edge.js's `SECURITY-HOST-JS-NAPI.md` says the host-engine package (`wasmer/edgejs`) must not be treated
as a security boundary yet, and recommends the embedded-engine package for untrusted JS. Visible from the
guest: error stacks name the host's absolute SDK install path (`wasmer_napi_context_eval` frames). Use
`wasmer/edgejs-quickjs` for agent workloads.
