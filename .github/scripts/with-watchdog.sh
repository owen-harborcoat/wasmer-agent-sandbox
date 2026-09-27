#!/usr/bin/env bash
# Usage: with-watchdog.sh SECONDS command [args...]
#
# Runs the command in its own process group. If it is still running after SECONDS, every process
# in the group gets SIGUSR2 (Node started with --report-on-signal writes a diagnostic report with
# JS and native stacks, including worker threads), then the group is killed and the script fails.
# Signals and process groups are Linux-only; elsewhere the command just runs.
set -uo pipefail

limit=$1
shift
if [[ "$(uname -s)" != Linux ]]; then
  exec "$@"
fi

setsid "$@" &
pid=$!

(
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    if ((SECONDS - start >= limit)); then
      echo "::error title=watchdog::still running after ${limit}s; writing Node diagnostic reports, then killing it"
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
