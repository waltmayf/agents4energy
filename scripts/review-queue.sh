#!/usr/bin/env bash
#
# review-queue.sh — "what needs my attention right now?" for the dispatch/merge loop.
#
# The @agentcore-claude webhook adds the `agent-working` label to an issue when a
# dispatched run starts and removes it when the run ends. So the authoritative
# "the agent is done" signal is the ABSENCE of that label — NOT whether a PR is
# still a draft (dispatched runs push DRAFT PRs early and leave them draft).
#
# This script reports three buckets so a review pass never misses a finished run:
#   1. OPEN PRs           — ready to review/merge (draft or not; shows checks + mergeable)
#   2. STILL WORKING      — issues that currently carry `agent-working` (leave them alone)
#   3. FINISHED, NO PR    — issues dispatched to the agent that no longer carry
#                           `agent-working` and have no open PR → the run ended
#                           empty-handed (hit the turn/time ceiling) → re-dispatch.
#
# Usage:
#   scripts/review-queue.sh                # human-readable report
#   scripts/review-queue.sh --exit-code    # additionally exit 10 if anything needs attention
#                                          # (open PRs OR finished-no-PR), 0 if all quiet,
#                                          # useful for `watch`/polling loops.
#
# Always targets the fork where CI runs. Override with REPO=owner/name.
set -euo pipefail

REPO="${REPO:-waltmayf/agents4energy}"
WORK_LABEL="agent-working"
# Label the webhook applies to issues it has been asked to work on.
DISPATCH_LABEL="agentcore"

want_exit_code=0
[[ "${1:-}" == "--exit-code" ]] && want_exit_code=1

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# ── 1. Open PRs ──────────────────────────────────────────────────────────────
prs_json="$(gh pr list --repo "$REPO" --state open \
  --json number,title,headRefName,isDraft,mergeable,statusCheckRollup)"
pr_count="$(jq 'length' <<<"$prs_json")"

bold "── Open PRs (ready for review) : ${pr_count} ──"
if [[ "$pr_count" -gt 0 ]]; then
  jq -r '.[] |
    ( [ .statusCheckRollup[]? | select((.conclusion // .state) == "FAILURE" or (.conclusion // .state) == "CANCELLED") ] | length ) as $failed |
    ( [ .statusCheckRollup[]? | select((.status // "") == "IN_PROGRESS" or (.state // "") == "PENDING" or (.conclusion // "") == "") ] | length ) as $pending |
    "#\(.number) [\(if .isDraft then "DRAFT" else "READY" end)] \(.title)\n" +
    "        branch=\(.headRefName)  mergeable=\(.mergeable)  " +
    "checks=\(if $failed > 0 then "❌ \($failed) failing" elif $pending > 0 then "⏳ \($pending) pending" else "✅ passing" end)"' \
    <<<"$prs_json"
else
  echo "  (none)"
fi
echo

# ── 2 & 3. Dispatched issues, split by whether the run is still going ─────────
# All open issues the webhook has been asked to work on (dispatch label) OR that
# still carry the working label.
issues_json="$(gh issue list --repo "$REPO" --state open --limit 200 \
  --json number,title,labels)"

working="$(jq -r --arg L "$WORK_LABEL" \
  '[.[] | select(any(.labels[]; .name == $L))]' <<<"$issues_json")"
working_count="$(jq 'length' <<<"$working")"

bold "── Still working (agent-working, leave alone) : ${working_count} ──"
if [[ "$working_count" -gt 0 ]]; then
  jq -r '.[] | "#\(.number) \(.title)"' <<<"$working"
else
  echo "  (none)"
fi
echo

# Branch names of every open PR, so we can tell which issues already have a PR.
pr_branches="$(jq -r '.[].headRefName' <<<"$prs_json")"
# Issue numbers referenced by an open PR body/branch (best-effort: branch contains the number).
pr_issue_refs="$(gh pr list --repo "$REPO" --state open --json number,body,headRefName \
  --jq '.[] | (.body // "") + " " + .headRefName')"

# Finished-no-PR = dispatched (dispatch label) AND not currently working AND no
# open PR appears to reference it. These are runs that ended without delivering.
bold "── Finished, no PR (re-dispatch these) ──"
finished_no_pr="$(jq -r --arg L "$DISPATCH_LABEL" --arg W "$WORK_LABEL" \
  '.[] | select(any(.labels[]; .name == $L)) | select(all(.labels[]; .name != $W)) | .number' \
  <<<"$issues_json")"

any_finished=0
if [[ -n "$finished_no_pr" ]]; then
  while IFS= read -r num; do
    [[ -z "$num" ]] && continue
    # Does any open PR reference this issue number?
    if grep -qwE "#?$num" <<<"$pr_issue_refs"; then
      continue   # has a PR → already surfaced in bucket 1
    fi
    title="$(jq -r --argjson n "$num" '.[] | select(.number==$n) | .title' <<<"$issues_json")"
    echo "#$num $title"
    any_finished=1
  done <<<"$finished_no_pr"
fi
[[ "$any_finished" -eq 0 ]] && echo "  (none)"
echo

# ── Exit code for polling loops ───────────────────────────────────────────────
if [[ "$want_exit_code" -eq 1 ]]; then
  if [[ "$pr_count" -gt 0 || "$any_finished" -eq 1 ]]; then
    exit 10   # something needs attention
  fi
  exit 0      # all quiet (nothing to review, nothing stalled)
fi
