# Waiting for remote dispatched agents

When you dispatch coding work to a remote webhook agent (e.g. by commenting
`@agentcore-claude` on a GitHub issue), you need a reliable way to know when the
run is *done* and what it produced. Two scripts cover the whole
**dispatch → wait → review** loop:

| Script | What it does |
|--------|--------------|
| [`scripts/wait-for-agents.sh`](../scripts/wait-for-agents.sh) | Blocks until no open issue carries the working label — i.e. every dispatched run has finished — then prints the review queue. |
| [`scripts/review-queue.sh`](../scripts/review-queue.sh) | Non-blocking snapshot: open PRs ready to review, issues still working (leave alone), and issues that finished empty-handed (re-dispatch). |

Both are driven by [`scripts/lib/agents-wait-config.sh`](../scripts/lib/agents-wait-config.sh).

## The convention they rely on

The webhook bot:

1. Adds a **working label** (default `agent-working`) to an issue when a
   dispatched run starts and **removes it when the run ends** — success OR
   empty-handed at the turn/time ceiling. The *absence* of that label — not PR
   draft state — is the authoritative "the agent is done" signal. Dispatched
   runs push **draft** PRs early and leave them draft, so never wait on a PR
   going non-draft.
2. Posts a **sentinel comment** (e.g. "no PR was created") when a run finishes
   without pushing anything — that run hit the ceiling and must be re-dispatched.

## Usage

```bash
# Block until all dispatched runs finish, then print the review queue.
# Run this in the background and act when it returns.
./scripts/wait-for-agents.sh                 # poll every 90s, no timeout
./scripts/wait-for-agents.sh --interval 60   # custom poll interval (seconds)
./scripts/wait-for-agents.sh --timeout 10800 # give up after N seconds (exit 124)

# Ad-hoc "what needs my attention right now?" without blocking.
./scripts/review-queue.sh
./scripts/review-queue.sh --exit-code        # exit 10 if anything needs attention
```

Requires an authenticated `gh` CLI and `jq`.

## Configuration — it targets your repo automatically

The scripts figure out **which repo to watch** with this precedence (highest
first):

1. **`REPO` environment variable** — `REPO=owner/name ./scripts/review-queue.sh`
2. **`.agents-wait.json`** at the repo root (searched upward from the current
   directory)
3. **The `origin` git remote** of the current directory — so a bare call from
   inside *any* clone targets that clone's GitHub repo with no configuration
4. **Built-in fallback** (`waltmayf/agents4energy`)

Because of (3), if you fork this repo, the scripts automatically watch *your*
fork — no edits needed. To point them somewhere else, or to customize the label,
bot login, or the sentinel regex, drop a `.agents-wait.json` at your repo root:

```json
{
  "repo": "owner/name",
  "workLabel": "agent-working",
  "bot": "my-webhook-bot-login",
  "sentinel": "no PR was created|ended before pushing|hit the ceiling"
}
```

| Key | Meaning | Per-call env override |
|-----|---------|-----------------------|
| `repo` | `owner/name` the dispatched runs push to (where CI runs) | `REPO` |
| `workLabel` | Label the bot adds/removes around a run | `AGENTS_WORK_LABEL` |
| `bot` | GitHub login of the webhook bot (attributes sentinel comments) | `AGENTS_BOT` |
| `sentinel` | Regex matching the bot's "ended without a PR" comment | `AGENTS_SENTINEL` |

Point at a specific config file with `AGENTS_WAIT_CONFIG=/path/to/file.json`.

## Wiring it into a Claude Code workflow

These scripts are the portable interface for letting Claude Code (or any agent)
wait on remote executions. The idiomatic pattern:

- Run `wait-for-agents.sh` in **background Bash** — it can run for hours, and
  the harness re-invokes the agent when it exits. Don't foreground-poll it.
- Once it returns, the printed review queue tells the agent exactly what to
  review or re-dispatch.

See the dispatch/wait section of the project [CLAUDE.md](../CLAUDE.md) for the
full loop guidance the in-repo agent follows. To make these available in *every*
Claude Code session across all your repos (not just this one), package the
`scripts/` + a skill as a user-scoped Claude Code plugin — the git-`origin`
resolution above means the same scripts then target whatever repo you're in.
