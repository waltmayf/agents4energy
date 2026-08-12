#!/usr/bin/env bash
#
# agents-done-check.sh — gh-free "are all workers done?" check for the monitor
# loop's checkCommand (docs/monitor-loop.md). Exits 0 iff no open issue in the
# target repo carries the working label (AGENTS_WORK_LABEL, default
# `agent-working`), other than an optionally-excluded issue (EXCLUDE_ISSUE);
# non-zero otherwise (including on any curl/network error — fail toward "not
# done yet" rather than falsely reporting completion).
#
# Why this exists instead of wait-for-agents.sh: the monitor loop's
# RunMonitorCheck exec environment has git's credential store but NOT gh's
# auth, and execs checkCommand with no shell (see docs/monitor-loop.md). This
# script uses curl only — no `gh` — so it works there. It still runs fine
# standalone / interactively too.
#
# EXCLUDE_ISSUE (optional): an issue number to ignore in the label query. The
# orchestrator (docs/autonomous-epic-delivery.md, agent/default/app/ClaudeCode/
# prompts/orchestrator.md) is itself a Step Functions execution that holds
# AGENTS_WORK_LABEL on its own epic issue for the run's ENTIRE duration —
# including while parked in a monitor Wait between waves — so without this,
# the epic issue would always show up in the query and the orchestrator's own
# "are the workers done?" check could never return 0. Set this to the epic
# issue's own number when the orchestrator uses this script as its
# checkCommand (see #395).
#
# Config (repo, label) resolves exactly like wait-for-agents.sh, via
# lib/agents-wait-config.sh: env > nearest .agents-wait.json > git `origin`
# remote of $PWD > built-in default. Override with REPO=owner/name or
# AGENTS_WORK_LABEL=some-label.
#
# Auth: unauthenticated curl works against public repos (rate-limited to 60
# requests/hour per IP by GitHub). Set GITHUB_TOKEN (or GH_TOKEN) to send an
# Authorization header for a higher rate limit or a private repo.
#
# Usage standalone:
#   scripts/agents-done-check.sh
#   REPO=owner/name AGENTS_WORK_LABEL=agent-working scripts/agents-done-check.sh
#   EXCLUDE_ISSUE=390 scripts/agents-done-check.sh
#
# Usage as a monitor-loop checkCommand (no shell — wrap in bash -c per
# docs/monitor-loop.md; use the absolute path to the checked-out repo):
#   "checkCommand": "bash -c \"EXCLUDE_ISSUE=390 /mnt/workspace/agents4energy/scripts/agents-done-check.sh\""
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/agents-wait-config.sh
source "$script_dir/lib/agents-wait-config.sh"
load_agents_wait_config

auth_header=()
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -n "$token" ]]; then
  auth_header=(-H "Authorization: Bearer $token")
fi

# per_page=100 (not 1): with EXCLUDE_ISSUE set, a single matching issue isn't
# enough to decide — we need every number to filter the excluded one out.
response="$(curl -sf \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "${auth_header[@]}" \
  "https://api.github.com/repos/${REPO}/issues?labels=${AGENTS_WORK_LABEL}&state=open&per_page=100")"

numbers="$(jq -r '.[].number' <<<"$response")"
if [[ -n "${EXCLUDE_ISSUE:-}" ]]; then
  numbers="$(grep -v -x "$EXCLUDE_ISSUE" <<<"$numbers" || true)"
fi

# No remaining numbers means no OTHER open issue carries the label — done.
if [[ -n "$numbers" ]]; then
  exit 1
fi
exit 0
