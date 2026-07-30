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

# Finished-no-PR = an issue whose LATEST webhook-bot comment is an empty-handed
# sentinel ("no PR was created" / "ended before pushing" / "no text response")
# AND no open PR references it. The webhook leaves NO label behind on a finished
# run (labels can be []), so we detect via the bot's own sign-off comment, not a
# label. Only issues NOT currently working are candidates.
bold "── Finished, no PR (re-dispatch these) ──"
# Regex the webhook bot uses when a run ends without pushing anything.
SENTINEL='no PR was created|ended before pushing|no text response|hit the per-turn ceiling'
BOT='waltmayf-claude-code-app'

# Candidate issues: open, not currently working. Bounded to recently-updated
# ones so we don't fetch comments for the entire backlog.
candidates="$(jq -r --arg W "$WORK_LABEL" \
  '.[] | select(all(.labels[]; .name != $W)) | .number' <<<"$issues_json")"

any_finished=0
while IFS= read -r num; do
  [[ -z "$num" ]] && continue
  # Skip if an open PR already references this issue → surfaced in bucket 1.
  grep -qwE "#?$num" <<<"$pr_issue_refs" && continue
  # Latest comment authored by the webhook bot on this issue.
  last_bot="$(gh issue view "$num" --repo "$REPO" --json comments \
    --jq "[.comments[] | select(.author.login==\"$BOT\")] | last | .body // \"\"" 2>/dev/null || echo "")"
  if grep -qiE "$SENTINEL" <<<"$last_bot"; then
    title="$(jq -r --argjson n "$num" '.[] | select(.number==$n) | .title' <<<"$issues_json")"
    echo "#$num $title  ← run ended empty-handed; re-dispatch smaller"
    any_finished=1
  fi
done <<<"$candidates"
[[ "$any_finished" -eq 0 ]] && echo "  (none)"
echo

# ── Exit code for polling loops ───────────────────────────────────────────────
if [[ "$want_exit_code" -eq 1 ]]; then
  if [[ "$pr_count" -gt 0 || "$any_finished" -eq 1 ]]; then
    exit 10   # something needs attention
  fi
  exit 0      # all quiet (nothing to review, nothing stalled)
fi
