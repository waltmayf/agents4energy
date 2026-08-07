#!/usr/bin/env bash
#
# agents-wait-config.sh — shared config loader for the agent dispatch/wait/review
# scripts (wait-for-agents.sh, review-queue.sh).
#
# Makes those scripts portable across repos that follow the same GitHub dispatch
# convention: a webhook bot adds a "working" label to an issue when a dispatched
# run starts and removes it when the run ends, and posts a sentinel comment when
# a run finishes without pushing a PR.
#
# Resolution order (highest precedence first):
#   REPO:  env REPO > .agents-wait.json "repo" > git `origin` remote of $PWD >
#          built-in fallback. Deriving from `origin` means a bare call from
#          inside ANY git repo targets that repo — no args, no config needed.
#   label/bot/sentinel: env > .agents-wait.json > built-in defaults (these
#          encode the shared webhook convention, so they rarely need overriding).
#
# Config file shape (all keys optional):
#   {
#     "repo": "owner/name",
#     "workLabel": "agent-working",
#     "bot": "my-bot-login",
#     "sentinel": "no PR was created|ended before pushing"
#   }
#
# Override the config file location with AGENTS_WAIT_CONFIG=/path/to/file.json.
#
# Source this file, then call load_agents_wait_config. It exports:
#   REPO  AGENTS_WORK_LABEL  AGENTS_BOT  AGENTS_SENTINEL

# --- Built-in defaults (agents4energy's original values) ----------------------
_DEFAULT_REPO="waltmayf/agents4energy"
_DEFAULT_WORK_LABEL="agent-working"
_DEFAULT_BOT="waltmayf-claude-code-app"
_DEFAULT_SENTINEL='no PR was created|ended before pushing|no text response|hit the per-turn ceiling'

# Find the nearest .agents-wait.json walking up from $PWD. Prints the path (empty
# if none found). Honors AGENTS_WAIT_CONFIG as an explicit override.
_find_agents_wait_config() {
  if [[ -n "${AGENTS_WAIT_CONFIG:-}" ]]; then
    [[ -f "$AGENTS_WAIT_CONFIG" ]] && printf '%s\n' "$AGENTS_WAIT_CONFIG"
    return
  fi
  local dir="$PWD"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.agents-wait.json" ]]; then
      printf '%s\n' "$dir/.agents-wait.json"
      return
    fi
    dir="$(dirname "$dir")"
  done
  [[ -f "/.agents-wait.json" ]] && printf '%s\n' "/.agents-wait.json"
  # Always succeed: callers use `cfg="$(_find_agents_wait_config)"` under
  # `set -e`, where a non-zero return (no config found) would abort the script.
  return 0
}

# Read one string key from a JSON file, printing empty on any miss/error.
_json_str() { jq -r --arg k "$2" '.[$k] // empty' "$1" 2>/dev/null || true; }

# Derive owner/name from the `origin` remote of the git repo containing $PWD.
# Handles https and ssh forms, with or without a trailing .git. Prints empty
# (and always succeeds) when not in a repo or origin isn't a GitHub URL — the
# caller falls back to the built-in default.
_repo_from_git_origin() {
  local url
  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  [[ -z "$url" ]] && return 0
  # git@github.com:owner/name(.git)  or  https://github.com/owner/name(.git)
  url="${url%.git}"
  case "$url" in
    *github.com[:/]*) printf '%s\n' "${url#*github.com}" | sed 's#^[:/]##' ;;
    *) : ;;  # non-GitHub remote → leave empty, use default
  esac
  return 0
}

load_agents_wait_config() {
  local cfg cfg_repo="" cfg_label="" cfg_bot="" cfg_sentinel=""
  cfg="$(_find_agents_wait_config)"
  if [[ -n "$cfg" ]]; then
    cfg_repo="$(_json_str "$cfg" repo)"
    cfg_label="$(_json_str "$cfg" workLabel)"
    cfg_bot="$(_json_str "$cfg" bot)"
    cfg_sentinel="$(_json_str "$cfg" sentinel)"
  fi

  # env > config file > git origin of cwd > default
  local git_repo=""
  [[ -z "${REPO:-}" && -z "$cfg_repo" ]] && git_repo="$(_repo_from_git_origin)"
  export REPO="${REPO:-${cfg_repo:-${git_repo:-$_DEFAULT_REPO}}}"
  export AGENTS_WORK_LABEL="${AGENTS_WORK_LABEL:-${cfg_label:-$_DEFAULT_WORK_LABEL}}"
  export AGENTS_BOT="${AGENTS_BOT:-${cfg_bot:-$_DEFAULT_BOT}}"
  export AGENTS_SENTINEL="${AGENTS_SENTINEL:-${cfg_sentinel:-$_DEFAULT_SENTINEL}}"
}
