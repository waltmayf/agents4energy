#!/usr/bin/env bash
#
# wait-for-agents.sh — block until no open issue carries the `agent-working`
# label, i.e. until every dispatched @agentcore-claude run has finished.
#
# The webhook adds `agent-working` to an issue when a run starts and removes it
# when the run ends (success OR empty-handed). So "no issue has agent-working"
# is the authoritative "all remote agents are done — my turn to act" signal.
# This is the DEFAULT waiting method for the dispatch/review loop; prefer it
# over bespoke per-run polls.
#
# On completion it prints the review queue (scripts/review-queue.sh) so the
# very next thing you see is what needs attention.
#
# Usage:
#   scripts/wait-for-agents.sh                 # poll every 90s, no timeout
#   scripts/wait-for-agents.sh --interval 60   # custom poll interval (seconds)
#   scripts/wait-for-agents.sh --timeout 10800 # give up after N seconds (exit 124)
#
# Exit codes: 0 = all agents done (queue printed); 124 = timed out still working.
# Always targets the fork where CI runs. Override with REPO=owner/name.
set -euo pipefail

REPO="${REPO:-waltmayf/agents4energy}"
WORK_LABEL="agent-working"
interval=90
timeout=0   # 0 = no timeout

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) interval="$2"; shift 2 ;;
    --timeout)  timeout="$2";  shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
start=$SECONDS

working_issues() {
  gh issue list --repo "$REPO" --label "$WORK_LABEL" --state open \
    --json number,title --jq '.[] | "#\(.number) \(.title)"'
}

while :; do
  working="$(working_issues || true)"
  if [[ -z "$working" ]]; then
    echo "✅ No issues carry '$WORK_LABEL' — all remote agents are done. Your turn."
    echo
    "$script_dir/review-queue.sh" || true
    exit 0
  fi

  count="$(wc -l <<<"$working" | tr -d ' ')"
  elapsed=$(( SECONDS - start ))
  echo "⏳ ${count} run(s) still working (${elapsed}s elapsed):"
  sed 's/^/    /' <<<"$working"

  if [[ "$timeout" -gt 0 && "$elapsed" -ge "$timeout" ]]; then
    echo "⌛ Timed out after ${elapsed}s with runs still working." >&2
    exit 124
  fi
  sleep "$interval"
done
