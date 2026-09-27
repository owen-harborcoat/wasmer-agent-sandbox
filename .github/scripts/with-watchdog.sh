#!/usr/bin/env bash
# Usage: with-watchdog.sh SECONDS command [args...]
#
# Runs the command in its own process group. If it is still running after SECONDS, the watchdog
# collects evidence and then kills the group, failing the step:
# - a process listing and native thread stacks (gdb) for every process in the group, written to
#   $WATCHDOG_DIR (default $RUNNER_TEMP/results/watchdog). Native stacks matter when a JS main
#   thread is blocked (e.g. in Atomics.wait), where Node can't produce a report. The instructions
#   at each thread's pc and its registers show a spin loop in JIT or wasm code, which has no symbols;
# - SIGUSR2 to the group, so Node processes started with --report-on-signal write a diagnostic
#   report (JS stacks included) to the --report-directory from NODE_OPTIONS, created here.
# Signals and process groups are Linux-only; elsewhere the command just runs.
set -uo pipefail

limit=$1
shift
if [[ "$(uname -s)" != Linux ]]; then
  exec "$@"
fi

dump_dir=${WATCHDOG_DIR:-${RUNNER_TEMP:-/tmp}/results/watchdog}
if [[ "${NODE_OPTIONS:-}" =~ --report-directory=([^[:space:]]+) ]]; then
  mkdir -p "${BASH_REMATCH[1]}"
fi

setsid "$@" &
pid=$!

collect() {
  mkdir -p "$dump_dir"
  ps -o pid,ppid,stat,wchan:32,etime,args -g "$pid" > "$dump_dir/ps.txt" 2>&1
  cat "$dump_dir/ps.txt"
  if ! command -v gdb > /dev/null; then
    sudo -n apt-get install -y -qq gdb > /dev/null 2>&1 || echo "gdb unavailable"
  fi
  for p in $(pgrep -g "$pid"); do
    timeout 60 sudo -n gdb -p "$p" -batch -ex 'info threads' -ex 'thread apply all bt 20' \
      -ex 'thread apply all x/16i $pc' -ex 'thread apply all info registers' \
      > "$dump_dir/gdb-$p.txt" 2>&1
  done
}

(
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    if ((SECONDS - start >= limit)); then
      echo "::error title=watchdog::still running after ${limit}s; collecting stacks, then killing it"
      collect
      kill -USR2 -- "-$pid" 2>/dev/null
      sleep 20
      kill -KILL -- "-$pid" 2>/dev/null
      exit 0
    fi
    sleep 5
  done
) &
watchdog=$!

wait "$pid"
status=$?
wait "$watchdog"
exit "$status"
