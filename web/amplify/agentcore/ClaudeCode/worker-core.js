// Portable core of the @agentcore-claude coding worker.
//
// This module holds the host-agnostic worker logic — set up a git workspace,
// assemble + spawn the `claude` CLI, stream-parse its output, publish ActiveRun
// live-view snapshots (#17/#15) and AgentCore Memory events (#186) — with NO
// dependency on the transport that drove it. It is imported by BOTH:
//   - server.js — the AgentCore Runtime Express shell (GET /ping, POST
//     /invocations, the SFN taskToken callback), which stays in service until
//     slice #566 decommissions the runtime; and
//   - codebuild-entrypoint.js — the CodeBuild build entrypoint (epic #558,
//     slice 2a/7 — issue #570), which drives the exact same core from
//     environment variables instead of an HTTP body.
//
// Keeping the core here (rather than duplicating it) means the two hosts can
// never drift: a fix to the `claude` arg assembly, the clone/auth setup, or the
// live-view publisher lands once and both paths get it. Everything that is
// AgentCore-Runtime-SPECIFIC (the Express server, /ping HealthyBusy microVM
// pinning, the SendTaskSuccess/Failure callback, cancel-via-session routing, the
// runtime session-id header, the /mnt/workspace mount) stays in server.js and is
// NOT ported to CodeBuild — see the epic-#558 design doc.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { persistClaudeStreamEvent } from './memory.js';
import { startBrowserMcp } from './browser-mcp.js';
import { gatewayMcpServerEntry } from './gateway-mcp.js';
import { writeMcpConfig, removeMcpConfig } from './mcp-config.js';
import { upsertActiveRun, clearActiveRun } from './active-run.js';

// Bedrock model for Claude Code. Overridable via env so the model can be bumped
// without a code change. Mirrors .github/workflows/claude.yml.
export const MODEL = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-5';

// Where the target repo is cloned. On the AgentCore Runtime this is the
// persistent (but quota-limited, #180) session-storage mount `/mnt/workspace`.
// On CodeBuild there is no such mount — the build's large ephemeral disk is
// rooted at $CODEBUILD_SRC_DIR, so fall back to that. WORKSPACE_ROOT (if
// explicitly set) always wins; CODEBUILD_SRC_DIR is the CodeBuild default; and
// `/mnt/workspace` remains the AgentCore default (CODEBUILD_SRC_DIR is unset
// there, so the AgentCore path is byte-for-byte unchanged). Resolved lazily (at
// call time, not import time) so a caller that sets the env just before driving
// the core still takes effect.
export function resolveWorkspaceRoot() {
  return process.env.WORKSPACE_ROOT || process.env.CODEBUILD_SRC_DIR || '/mnt/workspace';
}

// pnpm's content-addressable store already lives under HOME (container root fs,
// not the mount). But pnpm's *virtual store* (node_modules/.pnpm — a symlink farm
// with one entry per resolved package, the actual bulk of node_modules) defaults
// to inside the project directory, i.e. onto WORKSPACE_ROOT. On a large repo that
// exceeds the mount's quota (issue #180) — `pnpm install` fails with ENOSPC even
// though the container root fs has plenty of room. Point it at root fs instead via
// the npm_config_ environment convention pnpm reads (equivalent to
// `--virtual-store-dir`); repo clones are deleted and recreated on every run (see
// setupWorkspace), so nothing here needs to persist on the mount.
const PNPM_VIRTUAL_STORE_DIR =
  process.env.PNPM_VIRTUAL_STORE_DIR || join(process.env.HOME || '/root', '.pnpm-virtual-store');

// AgentCore Memory (MyHarnessMemory, shared with the harness — issue #186).
// Both env vars are set by backend.ts (agentCoreApp.addRuntimeEnvironmentVariable)
// on the runtime, and by StartBuild on the CodeBuild path; empty on a branch
// where the memory isn't wired up, in which case persistence is skipped (see
// memory.js) rather than failing the run.
export const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || '';
export const MEMORY_REGION = process.env.AGENTCORE_MEMORY_REGION || process.env.AWS_REGION;
export const memoryClient = MEMORY_ID ? new BedrockAgentCoreClient({ region: MEMORY_REGION }) : null;

// Strip any GitHub token that may have leaked into an error/clone URL before it
// leaves this process (SFN cause, HTTP error body, logs).
export function redact(s) {
  return s.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

// Clone the repo (if provided) into the workspace root and configure git/gh auth
// using the short-lived GitHub App token. Returns the directory Claude Code
// should run in.
export async function setupWorkspace({ repo, githubToken, baseBranch, log }) {
  if (!repo) {
    // No repo context — run in a throwaway dir so Claude Code has a valid cwd.
    return await mkdtemp(join(tmpdir(), 'cc-'));
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const [, name] = repo.split('/');
  const dest = join(workspaceRoot, name || 'repo');
  const authRepoUrl = githubToken
    ? `https://x-access-token:${githubToken}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;

  if (githubToken) {
    // gh + git auth for pushes and PR creation.
    await run('git', ['config', '--global', 'credential.helper', 'store'], { log });
    await writeFile(
      join(process.env.HOME || '/root', '.git-credentials'),
      `https://x-access-token:${githubToken}@github.com\n`,
      { mode: 0o600 },
    );
    await run('git', ['config', '--global', 'user.name', 'agentcore-claude[bot]'], { log });
    await run('git', ['config', '--global', 'user.email', 'agentcore-claude@users.noreply.github.com'], { log });
  }

  // Fresh clone each run keeps state deterministic; session storage just makes
  // the clone fast on resume (layers/objects cached). Remove a stale clone first.
  await rm(dest, { recursive: true, force: true }).catch(() => {});
  const cloneArgs = ['clone', '--depth', '50'];
  if (baseBranch) cloneArgs.push('--branch', baseBranch);
  cloneArgs.push(authRepoUrl, dest);
  await run('git', cloneArgs, { log });
  // Log the workspace's actual free space so a quota regression (issue #180)
  // shows up in the logs instead of only surfacing as an ENOSPC deep in `pnpm
  // install`.
  await logDiskUsage(workspaceRoot, log).catch(() => {});
  return dest;
}

// Build the system-prompt appends injected into every `claude` run. Pure (no
// side effects) so it's unit-testable and so the CodeBuild entrypoint's dry-run
// can exercise arg assembly without spawning the CLI (issue #570).
export function buildAppendParts({ repo, issueNumber, systemAppend }) {
  const appendParts = [];
  if (repo) {
    appendParts.push(
      `You are acting on GitHub repository ${repo}${issueNumber ? `, issue/PR #${issueNumber}` : ''}.`,
      `The repository is already cloned at the current working directory.`,
      `The \`gh\` CLI and \`git\` are authenticated — git commit/push and gh pr create all work with no token setup needed.`,
      // Incremental delivery (issue #166): this job runs under a hard timeout,
      // and anything only in the container (not pushed) is LOST when the turn is
      // cut off. Mirrors the guidance the harness path injects in
      // agent-webhook-invoke-agent/handler.ts.
      'DELIVER INCREMENTALLY — do not save all your work for the end. Your turn can be cut off before you finish, and any work that is only in this container (not pushed) is LOST. So:',
      '  1. Create your branch and make the first coherent edit EARLY.',
      '  2. Commit and push that first chunk right away: `git push -u origin <your-branch>`.',
      `  3. Immediately open a DRAFT PR so the work is durable and resumable: gh pr create --repo ${repo} --draft --base main --head <your-branch> --title "<title>" --body "<body>"`,
      '  4. Keep committing and pushing to the same branch after each further coherent chunk — every push updates the open PR. Never batch many files into a single final push.',
      'This way, even if your turn ends mid-task, there is a real PR with real progress to resume from — instead of nothing. Prefer the smallest coherent change that resolves the request; for a large coupled refactor, land what you have and list the remaining edits as a checklist in the PR body rather than trying to finish everything in one turn.',
      // Bounded tool output (issue #140): a single command that prints tens of
      // thousands of lines can overflow the model context and kill the run.
      'KEEP TOOL OUTPUT SMALL — a single command that prints tens of thousands of lines (e.g. `pnpm lint` on generated output, a full `git diff`, or `cat` of a big/generated file) can overflow the model context and kill your run with no result. Never dump unbounded output: pipe through `| tail -n 50` (or `| head`), use quiet/summary flags (`--quiet`, `--silent`), and check size first with `| wc -l` before printing. If a check is inherently noisy, capture it to a file and inspect just the relevant lines (e.g. `... > /tmp/out.txt 2>&1; grep -i error /tmp/out.txt | head -n 50`).',
      'Before you mark the PR ready for review (`gh pr ready <your-branch>`), verify the change builds: run `pnpm install` at the REPOSITORY ROOT (this is a pnpm workspace with one root lockfile — do NOT run it inside web/), then `cd web && npx tsc --noEmit` and make it pass. Leave the PR as a draft while the type check fails, and do not claim it passed unless you actually ran it and it did.',
      issueNumber
        ? `When finished, your final message should summarize what you did and include the confirmed PR URL (a caller posts it as a comment on #${issueNumber}).`
        : `When finished, summarize what you did and include the confirmed PR URL in your final message.`,
    );
  }
  // Monitor handoff (issue #261, extended by #377): lets a run end its turn
  // by asking the state machine to poll an external condition (or just wait a
  // fixed duration) instead of busy-waiting in-session for a deploy/CI run/
  // other long job to finish.
  appendParts.push(
    'MONITOR HANDOFF: if you are waiting on an external async condition (a deploy, a CI run, a long job) rather than doing work yourself, end your final message with a fenced ```monitor``` block instead of busy-waiting in-session. **The monitor block must be the last thing you output; any additional content after it will be ignored.** Two shapes:',
    '1. Condition poll — wake as soon as a check passes:',
    '```monitor',
    '{"intervalSeconds": 120, "maxIterations": 20, "checkCommand": "bash -c \\"curl -sf https://api.github.com/repos/owner/name/commits/main/status | grep -q success\\"", "followUpPrompt": "The deploy finished — verify it succeeded and comment the result."}',
    '```',
    '2. Timed wait — no `checkCommand` at all, just pause for a fixed duration then continue (e.g. "give workers ~3h to deliver"):',
    '```monitor',
    '{"waitSeconds": 10800, "followUpPrompt": "3 hours should be enough for workers to deliver — check the review queue and act on whatever landed."}',
    '```',
    '`followUpPrompt` is always required (a malformed block is ignored and the run just completes normally). `checkCommand` is optional — include it for shape 1, omit it for shape 2. `intervalSeconds`/`waitSeconds` (either name works, up to 99,999,999 — the Step Functions Wait state max, ~3.17 years) default to 60s if omitted; `maxIterations` (shape 1 only) is clamped to [1, 120], default 10. Prefer a long `intervalSeconds` over a large `maxIterations` when you need a long total budget. If a condition poll exhausts `maxIterations` without the check ever passing, you are still re-invoked with `followUpPrompt` — the loop treats this as "wake up and re-check reality," not a terminal failure.',
    'IMPORTANT — `checkCommand` has `git` HTTPS credentials on disk but NOT `gh` CLI auth — use `curl`/`git`/`aws` directly, never `gh` (a `gh`-based check fails asking for `gh auth login` and exits non-zero every tick, so the condition never fires). For the standard "are dispatched workers done?" check, use the curl-only `scripts/agents-done-check.sh` (absolute path `/mnt/workspace/agents4energy/scripts/agents-done-check.sh`); when checking on your own epic\'s workers, wrap it with `EXCLUDE_ISSUE=<own epic #>` so the check does not see your own `agent-working` label and block forever, e.g. `"checkCommand": "bash -c \\"EXCLUDE_ISSUE=390 /mnt/workspace/agents4energy/scripts/agents-done-check.sh\\""`.',
    'IMPORTANT — `checkCommand` runs with NO shell: it is executed directly, not via `/bin/sh -c`, so pipes (`|`), `&&`, and quoting are NOT interpreted and get passed to your first command as literal extra arguments (e.g. a bare `curl ... | grep -q x` never pipes — `curl` receives `|`, `grep`, `-q`, `x` as literal extra arguments and fails). Wrap ANY checkCommand that uses a pipe, `&&`, or shell quoting in `bash -c "..."` as shown above.',
    'IMPORTANT — the microVM running this session is RECLAIMED for the duration of the wait: `checkCommand` runs in a FRESH container on each tick, and only the /mnt/workspace mount persists across ticks — nothing else you installed or created outside it survives. So `checkCommand` must be fully self-contained: use `curl`/`git`/`aws` directly, or re-bootstrap any tooling it needs, rather than relying on anything set up earlier in this session. Exit 0 means the condition is met (you will be re-invoked with `followUpPrompt`, same session/workspace); any non-zero exit means keep waiting. Keep checkCommand fast and its output tiny (see KEEP TOOL OUTPUT SMALL above). A timed wait (shape 2) always re-invokes with `followUpPrompt` once `waitSeconds` elapses — there is no check to fail.',
  );
  if (systemAppend) appendParts.push(systemAppend);
  return appendParts;
}

// Assemble the full `claude` CLI argv. Pure — see buildAppendParts.
export function buildClaudeArgs({ prompt, repo, issueNumber, systemAppend, mcpConfigPath, model = MODEL }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--dangerously-skip-permissions',
  ];
  const appendParts = buildAppendParts({ repo, issueNumber, systemAppend });
  if (appendParts.length) {
    args.push('--append-system-prompt', appendParts.join('\n'));
  }
  // Give Claude Code MCP tools via a single merged --mcp-config (issue #339 /
  // #183). Absent when no MCP source is available for this run.
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  return args;
}

// Build the environment the `claude` CLI runs under. Pure.
export function buildClaudeEnv({ githubToken }) {
  const env = {
    ...process.env,
    // Route Claude Code through Amazon Bedrock (the host's execution role /
    // service role supplies credentials via the standard AWS provider chain).
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: MODEL,
    HOME: process.env.HOME || '/root',
    // Keep pnpm's virtual store (node_modules/.pnpm) off the quota-limited
    // session-storage mount — see PNPM_VIRTUAL_STORE_DIR above (issue #180).
    npm_config_virtual_store_dir: PNPM_VIRTUAL_STORE_DIR,
    // The container runs as root, and the CLI otherwise refuses
    // `--dangerously-skip-permissions` under root ("cannot be used with
    // root/sudo privileges for security reasons"). Both hosts run the job in an
    // isolated environment (AgentCore Firecracker microVM / a per-build
    // CodeBuild container), so declaring the sandbox is accurate and lets the
    // headless run proceed as root.
    IS_SANDBOX: '1',
  };
  if (githubToken) env.GH_TOKEN = githubToken;
  return env;
}

// Drive the Claude Code CLI headlessly. `-p` runs a single prompt to
// completion. `--output-format stream-json --verbose` prints one JSON object
// per line (system/assistant/user/result) as the run progresses — needed
// (rather than the simpler `--output-format json`) so each assistant/tool turn
// can be persisted to AgentCore Memory as it happens (issue #186), not just
// the final text.
export function runClaudeCode({ prompt, workDir, repo, issueNumber, systemAppend, githubToken, memorySessionId, log, onSpawn, mcpConfigPath }) {
  const args = buildClaudeArgs({ prompt, repo, issueNumber, systemAppend, mcpConfigPath });
  const env = buildClaudeEnv({ githubToken });

  log(`spawning claude (model=${MODEL}) in ${workDir}`);

  return new Promise((resolve, reject) => {
    // stdin: 'ignore' closes the child's stdin immediately — otherwise it
    // stays an open pipe that's never written or ended, which is what
    // triggers the CLI's benign "no stdin data received in 3s, proceeding
    // without it" warning on every run (issue #257). That warning used to be
    // the only thing left in `stderr` by the time a real failure surfaced,
    // masking the actual cause.
    const child = spawn('claude', args, { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Hand the child back so a cancel invocation (issue #182) can kill it.
    if (typeof onSpawn === 'function') onSpawn(child);
    let resultText = null;
    let stderr = '';
    let buffered = '';
    // Raw stdout tail for failure diagnostics, kept separate from `buffered`
    // (which is consumed line-by-line by handleLine and doesn't retain
    // history) — capped so a long-running job can't grow this unbounded.
    let stdoutTail = '';

    // ActiveRun producer (issue #15): a browserless run has no browser tab
    // producing the in-flight-message snapshot web/lib/harness-agent.ts writes
    // for harness sessions, so this run writes its own — same contract
    // (upsert with status:'streaming' while text accumulates, clearActiveRun()
    // once settled) so a late-joining viewer's loadHistory() renders it
    // identically regardless of which producer wrote it. One synthetic
    // messageId for the whole job (not per CLI message) — good enough for a
    // "here's roughly what's happening now" preview bubble, cleared the moment
    // memory has the real, complete turns.
    const activeRunMessageId = `claude-code-${memorySessionId || Date.now()}`;
    let activeRunText = '';
    let activeRunRowId = null;
    let activeRunLastWrite = 0;
    let activeRunTimer = null;
    const ACTIVE_RUN_THROTTLE_MS = 750;

    const flushActiveRun = () => {
      if (!memorySessionId) return;
      activeRunLastWrite = Date.now();
      upsertActiveRun(
        { sessionId: memorySessionId, messageId: activeRunMessageId, accumulatedText: activeRunText, status: 'streaming' },
        activeRunRowId,
        log,
      ).then((id) => { if (id) activeRunRowId = id; });
    };

    const scheduleActiveRunWrite = () => {
      if (!memorySessionId) return;
      const elapsed = Date.now() - activeRunLastWrite;
      if (elapsed >= ACTIVE_RUN_THROTTLE_MS) {
        flushActiveRun();
        return;
      }
      if (activeRunTimer) return;
      activeRunTimer = setTimeout(() => {
        activeRunTimer = null;
        flushActiveRun();
      }, ACTIVE_RUN_THROTTLE_MS - elapsed);
    };

    // Settle the snapshot: cancel any pending throttled write, flush the
    // final text so the row is never stuck showing a stale partial, then
    // delete it now that memory has (or will shortly have) the real turns.
    // Called on the terminal `result` event's close, AND on error/teardown —
    // an ActiveRun row must never outlive the job that owns it.
    const settleActiveRun = () => {
      if (!memorySessionId) return;
      if (activeRunTimer) { clearTimeout(activeRunTimer); activeRunTimer = null; }
      if (activeRunText) flushActiveRun();
      void clearActiveRun(memorySessionId, log);
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return; // A non-JSON stdout line (shouldn't happen under stream-json) — ignore.
      }
      if (event.type === 'result') {
        resultText = typeof event.result === 'string' ? event.result : '';
        return;
      }
      if (event.type === 'assistant') {
        const textBlocks = (event.message?.content ?? []).filter(
          (b) => b?.type === 'text' && typeof b.text === 'string',
        );
        if (textBlocks.length) {
          activeRunText += textBlocks.map((b) => b.text).join('');
          scheduleActiveRunWrite();
        }
      }
      if (memoryClient) {
        persistClaudeStreamEvent(memoryClient, { memoryId: MEMORY_ID, sessionId: memorySessionId, event, log });
      }
    };

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdoutTail = (stdoutTail + chunk).slice(-2000);
      buffered += chunk;
      let newlineIndex;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
        handleLine(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); log('claude:', d.toString().trimEnd()); });
    child.on('error', (err) => { settleActiveRun(); reject(err); });
    child.on('close', (code, signal) => {
      if (buffered.trim()) handleLine(buffered);
      settleActiveRun();
      if (code !== 0) {
        // A signal (SIGTERM/SIGKILL) with code === null means the process was
        // killed rather than crashing on its own — either the ceiling/cancel
        // path (issue #182) or an OOM kill, not a genuine CLI-reported error.
        const cause = signal
          ? `claude killed by signal ${signal} (code=${code})`
          : `claude exited ${code}`;
        reject(new Error(
          `${cause}\n--- stdout tail ---\n${redact(stdoutTail.slice(-2000))}\n--- stderr tail ---\n${redact(stderr.slice(-2000))}`,
        ));
        return;
      }
      resolve(resultText ?? '');
    });
  });
}

// Shared job body for every host: set up the workspace, wire MCP tool sources,
// then run Claude Code to completion. Leaves the git clone under the workspace
// root (persistent on AgentCore) for reuse.
//
// `enableBrowser` gates the AgentCore Browser MCP tool (issue #183): it's a
// direct SigV4 connection to the AWS-managed default browser that only exists
// under an AgentCore Runtime session. The CodeBuild path has no such session,
// so it passes `enableBrowser: false` and the browser tool is simply omitted;
// the gateway-routed MCP tools (plain HTTP + bearer token, #339) still work on
// both hosts.
export async function runManagedJob({
  prompt, repo, issueNumber, githubToken, baseBranch, systemAppend, memorySessionId,
  log, onSpawn, cognitoAccessToken, enableBrowser = true,
}) {
  const workDir = await setupWorkspace({ repo, githubToken, baseBranch, log });
  // Give Claude Code the AgentCore Browser tool as an MCP server for this run
  // (issue #183). A failure here (e.g. AccessDenied on a role that predates the
  // browser connection) shouldn't block the whole job — fall back to no browser.
  let browserMcp = null;
  if (enableBrowser) {
    try {
      browserMcp = await startBrowserMcp({ log });
    } catch (err) {
      log('[browser-mcp] failed to start; continuing without browser tool:', err?.message || String(err));
    }
  }
  // Route every other MCP tool through the AgentCore gateway (issue #339) —
  // never a container-local/direct connection — using the caller's relayed
  // Cognito access token. Merged with the browser entry above into one
  // `.mcp.json` so the CLI needs only a single --mcp-config flag.
  const gatewayEntry = gatewayMcpServerEntry({ accessToken: cognitoAccessToken, log });
  const mcpConfigPath = await writeMcpConfig(workDir, {
    ...(browserMcp?.mcpServerEntry ?? {}),
    ...(gatewayEntry ?? {}),
  });
  try {
    return await runClaudeCode({
      prompt, workDir, repo, issueNumber, systemAppend, githubToken, memorySessionId, log, onSpawn,
      mcpConfigPath,
    });
  } finally {
    if (browserMcp) await browserMcp.stop();
    await removeMcpConfig(mcpConfigPath);
  }
}

// `df -h <path>` for log visibility into the workspace's actual free space
// (issue #180) — `run()` discards stdout, so this logs it directly.
export function logDiskUsage(path, log) {
  return new Promise((resolve, reject) => {
    const child = spawn('df', ['-h', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) log(`disk usage:\n${stdout.trimEnd()}`);
      resolve();
    });
  });
}

export function run(cmd, args, { log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      // Redact any token that may appear in a clone URL before surfacing.
      else reject(new Error(`${cmd} exited ${code}: ${stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').slice(-1000)}`));
    });
  });
}
