// Claude Code invocation server for AgentCore Runtime.
//
// Implements the AgentCore Runtime HTTP contract
// (docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html):
//   GET  /ping         → health check ({"status":"Healthy"})
//   POST /invocations  → do the work; body is the caller's payload verbatim
//
// The webhook Step Function calls InvokeAgentRuntime with a payload shaped like:
//   {
//     "prompt":      "<user request, @agentcore-claude stripped>",
//     "repo":        "owner/name",           // optional; enables git clone + PR
//     "issueNumber": 123,                     // optional; used for the reply
//     "githubToken": "ghs_...",               // optional; short-lived App token
//     "branch":      "main",                  // optional; base branch (default: repo default)
//     "systemAppend":"<extra system prompt>", // optional
//     "taskToken":   "<sfn callback token>"   // optional; enables the async path
//   }
//
// We run the Claude Code CLI headlessly against Amazon Bedrock (same engine as
// anthropics/claude-code-action --use_bedrock), so a customer already using the
// GitHub Action migrates by pointing @agentcore-claude at this runtime instead.
//
// Two invocation modes (issue #175):
//   - No `taskToken`: SYNCHRONOUS. Run Claude Code to completion and return its
//     final text in the HTTP response (used by the direct-invoke smoke test and
//     any non-Step-Functions caller). Bounded by the caller's 15-min ceiling.
//   - With `taskToken`: CALLBACK. A Claude Code job routinely runs longer than
//     the 15-min Lambda/state-machine ceiling (often >1h), so we start the job
//     in the BACKGROUND, immediately ack `{ started: true }`, and when the job
//     finishes resume the paused Step Functions task ourselves via
//     SendTaskSuccess/SendTaskFailure. AgentCore sessions can run up to ~hours,
//     which comfortably covers the state machine's 3h task timeout.

import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { persistClaudeStreamEvent, persistUserPrompt } from './memory.js';
import { startBrowserMcp } from './browser-mcp.js';

const PORT = 8080;
// SendTaskSuccess/Failure need only the token + a client in the SAME region and
// account as the state machine (the runtime's execution role is granted
// states:SendTask* on the webhook state machine ARN in backend.ts). AWS_REGION
// is always set inside the AgentCore Runtime container.
const sfn = new SFNClient({ region: process.env.AWS_REGION });
// Bedrock model for Claude Code. Overridable via env so the runtime's model can
// be bumped without a code change. Mirrors .github/workflows/claude.yml.
const MODEL = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-5';
// Session storage mount (see agentcore.json filesystemConfigurations). Persists
// across stop/resume so a follow-up comment on the same issue reuses the clone.
// It's also quota-limited (observed 1GB) — see PNPM_VIRTUAL_STORE_DIR below.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/mnt/workspace';
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
// Both env vars are set by backend.ts (agentCoreApp.addRuntimeEnvironmentVariable);
// empty on a branch where the memory isn't wired up, in which case persistence
// is skipped (see memory.js) rather than failing the run.
const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || '';
const MEMORY_REGION = process.env.AGENTCORE_MEMORY_REGION || process.env.AWS_REGION;
const memoryClient = MEMORY_ID ? new BedrockAgentCoreClient({ region: MEMORY_REGION }) : null;

const app = express();
// InvokeAgentRuntime passes the payload through verbatim; it can be large
// (issue bodies, diffs), so lift the default 100kb limit.
app.use(express.json({ limit: '25mb' }));

// Count of Claude Code jobs currently running in the BACKGROUND (callback path).
// This is the single most important piece of the callback design: AgentCore
// Runtime polls GET /ping to decide when a session is idle and may be
// snapshotted/suspended/reclaimed. `Healthy` means "idle, safe to reclaim";
// `HealthyBusy` means "work in flight, keep me alive". A detached background
// job has NO in-flight HTTP request, so if /ping reported `Healthy` the runtime
// would reclaim the microVM at its idle threshold (~13 min observed) and kill
// the still-running `claude` process before it could call SendTaskSuccess —
// exactly the failure seen on issue #165. So we report `HealthyBusy` for the
// entire lifetime of every background job, which pins the session open (up to
// the ~8h session cap) until the job finishes and resumes the SFN task.
let activeJobs = 0;

// In-flight BACKGROUND jobs, keyed by runId, so a later cancel invocation can
// abort a superseded run (issue #182). A newer @agentcore-claude comment on the
// same issue supersedes the one already running; the webhook routes a
// `{ action: 'cancel', runId }` invocation to THIS run's session
// (runtimeSessionId === runId), which lands on the same microVM, and we kill the
// spawned CLI. Each value is `{ child, taskToken, cancelled }` — `child` is null
// until the CLI is spawned (the job may still be cloning), and `cancelled` lets
// the onSpawn hook kill a job that was cancelled before its CLI even started.
const runningJobs = new Map();

// Cause reported (via SendTaskFailure) when a run is cancelled. The SFN Catch
// turns this into a PostFailureComment; deliberately omits the raw "@" mention
// so the superseded-run comment can never re-trigger the webhook.
const SUPERSEDED_CAUSE =
  'Cancelled: superseded by a newer agentcore-claude comment on the same issue.';

app.get('/ping', (_req, res) => {
  res.status(200).json({
    status: activeJobs > 0 ? 'HealthyBusy' : 'Healthy',
    // Unix seconds; part of the AgentCore health contract so the control plane
    // can tell a fresh status apart from a stale one.
    time_of_last_update: Math.floor(Date.now() / 1000),
  });
});

app.post('/invocations', async (req, res) => {
  const payload = req.body ?? {};

  // CANCEL ACTION (issue #182): a control invocation, not a work request. The
  // webhook sends `{ action: 'cancel', runId }` to the superseded run's session
  // so it lands on the same microVM as the job to kill. Handle it before the
  // prompt check (a cancel carries no prompt).
  if (payload.action === 'cancel') {
    const cancelRunId = typeof payload.runId === 'string' ? payload.runId : '';
    const cancelLog = (...args) => console.log('[invocations][cancel]', ...args);
    cancelLog(`request for runId=${cancelRunId || '(none)'} (tracked=${runningJobs.size})`);
    const job = cancelRunId ? runningJobs.get(cancelRunId) : undefined;
    if (!job) {
      // Nothing to cancel on this microVM — the job already finished, never ran
      // here, or the session was reclaimed. Not an error: report it and move on.
      res.status(200).json({ cancelled: false, reason: 'no matching in-flight job' });
      return;
    }
    // Mark cancelled so runManagedJob resolves to a sentinel (→ SendTaskFailure
    // with the superseded cause) instead of SendTaskSuccess, and so a job still
    // cloning (child not yet spawned) gets killed the instant its CLI starts.
    job.cancelled = true;
    if (job.child) {
      cancelLog(`killing claude process for runId=${cancelRunId}`);
      job.child.kill('SIGTERM');
      // Escalate if the CLI ignores SIGTERM (e.g. stuck in a subprocess).
      job.killTimer = setTimeout(() => {
        try { job.child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5000);
    } else {
      cancelLog(`runId=${cancelRunId} not yet spawned; will abort on spawn`);
    }
    res.status(200).json({ cancelled: true });
    return;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ error: 'payload.prompt is required' });
    return;
  }

  const runId = typeof payload.runId === 'string' ? payload.runId : '';
  const repo = typeof payload.repo === 'string' ? payload.repo : '';
  const issueNumber = payload.issueNumber ?? null;
  const githubToken = typeof payload.githubToken === 'string' ? payload.githubToken : '';
  const baseBranch = typeof payload.branch === 'string' ? payload.branch : '';
  const systemAppend = typeof payload.systemAppend === 'string' ? payload.systemAppend : '';
  // Present only on the Step Functions callback path (issue #175).
  const taskToken = typeof payload.taskToken === 'string' ? payload.taskToken : '';
  // InvokeAgentRuntime forwards runtimeSessionId as this header (not the JSON
  // body) — see the SDK's schema for InvokeAgentRuntimeRequest. It's the same
  // id every caller here already passes as runtimeSessionId (agent-webhook-
  // invoke-claude sets it to runId), so memory events land in the exact
  // session the chat UI's HarnessAgent reads (issue #186).
  const memorySessionId = req.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id') || runId || '';

  const log = (...args) => console.log(`[invocations]`, ...args);
  log(`runId=${runId || '(none)'} repo=${repo || '(none)'} issue=${issueNumber ?? '(none)'} promptChars=${prompt.length} mode=${taskToken ? 'callback' : 'sync'}`);

  if (memoryClient) {
    await persistUserPrompt(memoryClient, { memoryId: MEMORY_ID, sessionId: memorySessionId, prompt, log });
  }

  const runJob = (onSpawn) => runManagedJob({ prompt, repo, issueNumber, githubToken, baseBranch, systemAppend, memorySessionId, log, onSpawn });

  // CALLBACK PATH: a Claude Code run can outlast the 15-min invoke ceiling, so
  // ack immediately and drive the (possibly hours-long) job in the background,
  // resuming the paused Step Functions task ourselves when it finishes. After
  // res returns the HTTP request is done, but the server process keeps running,
  // so the background promise continues. Guard it with .catch so a rejection can
  // never surface as an unhandledRejection and crash the process.
  if (taskToken) {
    // Mark the session BUSY before we ack, so /ping reports HealthyBusy from the
    // moment the HTTP request returns and the runtime never reclaims the microVM
    // out from under the background job. Decremented in .finally below.
    activeJobs++;
    res.status(200).json({ started: true });
    log(`[callback] job started in background (activeJobs=${activeJobs}); will resume SFN task on completion`);

    // Register this run so a later cancel invocation (issue #182) can find and
    // kill it. `child` is filled in by onSpawn once the CLI actually starts —
    // until then the job may be cloning, and a cancel just sets `cancelled`.
    const job = { child: null, taskToken, cancelled: false, killTimer: null };
    if (runId) runningJobs.set(runId, job);

    const onSpawn = (child) => {
      job.child = child;
      // If a cancel arrived while we were still cloning, honor it now that the
      // CLI exists (the cancel handler couldn't kill a child that didn't exist).
      if (job.cancelled) {
        log(`[callback] runId=${runId} was cancelled before spawn; killing now`);
        child.kill('SIGTERM');
      }
    };

    runJob(onSpawn).then(
      async (finalText) => {
        // A cancelled run reaches here if the CLI exited 0 despite the SIGTERM
        // (race), or was never spawned. Treat it as superseded, not success.
        if (job.cancelled) {
          log(`[callback] job cancelled; sending SendTaskFailure (superseded)`);
          await sfn.send(new SendTaskFailureCommand({
            taskToken, error: 'ClaudeCodeRuntimeCancelled', cause: SUPERSEDED_CAUSE,
          }));
          return;
        }
        log(`[callback] job finished (${finalText.length} chars); sending SendTaskSuccess`);
        await sfn.send(new SendTaskSuccessCommand({
          taskToken,
          // Match the synchronous $.agentResult shape the native invokeHarness
          // task produces so the shared PostFinalComment step reads both alike.
          output: JSON.stringify({ Output: { Message: { Role: 'assistant', Content: [{ Text: finalText }] } } }),
        }));
      },
      async (err) => {
        // A killed CLI rejects (non-zero exit from SIGTERM/SIGKILL). If we asked
        // for the cancel, report it as superseded rather than a runtime error.
        if (job.cancelled) {
          log(`[callback] job killed by cancel; sending SendTaskFailure (superseded)`);
          await sfn.send(new SendTaskFailureCommand({
            taskToken, error: 'ClaudeCodeRuntimeCancelled', cause: SUPERSEDED_CAUSE,
          }));
          return;
        }
        // Short, token-redacted failure so the SFN Catch → PostFailureComment
        // step surfaces a useful (but not leaky) cause on the issue/PR.
        const cause = redact(String(err?.stack || err?.message || err)).slice(0, 3000);
        log(`[callback] job failed; sending SendTaskFailure:`, cause);
        await sfn.send(new SendTaskFailureCommand({
          taskToken,
          error: 'ClaudeCodeRuntimeError',
          cause,
        }));
      },
    ).catch((sendErr) => {
      // SendTask* itself failed (e.g. token already timed out) — nothing left to
      // do but log; the SFN task will time out on its own if it hasn't already.
      log(`[callback] ERROR delivering task result:`, sendErr?.stack || String(sendErr));
    }).finally(() => {
      // Job (and its result delivery) is fully done — let /ping report idle again
      // so the runtime can reclaim the session once no other job is in flight.
      if (job.killTimer) clearTimeout(job.killTimer);
      if (runId) runningJobs.delete(runId);
      activeJobs--;
      log(`[callback] job settled (activeJobs=${activeJobs})`);
    });
    return;
  }

  // SYNCHRONOUS PATH: run to completion and return the final text in the HTTP
  // response (direct-invoke smoke test / any non-token caller).
  try {
    const finalText = await runJob();
    res.status(200).json({ result: finalText, repo: repo || null, issueNumber });
  } catch (err) {
    log('ERROR', err?.stack || String(err));
    res.status(500).json({ error: redact(String(err?.message || err)) });
  }
});

// Shared job body for both invocation paths: set up the workspace, then run
// Claude Code to completion. Kept separate so the sync and callback paths never
// drift. Leaves the git clone under WORKSPACE_ROOT (persistent) for reuse.
async function runManagedJob({ prompt, repo, issueNumber, githubToken, baseBranch, systemAppend, memorySessionId, log, onSpawn }) {
  const workDir = await setupWorkspace({ repo, githubToken, baseBranch, log });
  // Give Claude Code the AgentCore Browser tool as an MCP server for this run
  // (issue #183). A failure here (e.g. AccessDenied on a role that predates the
  // browser connection) shouldn't block the whole job — fall back to no browser.
  let browserMcp = null;
  try {
    browserMcp = await startBrowserMcp({ workDir, log });
  } catch (err) {
    log('[browser-mcp] failed to start; continuing without browser tool:', err?.message || String(err));
  }
  try {
    return await runClaudeCode({
      prompt, workDir, repo, issueNumber, systemAppend, githubToken, memorySessionId, log, onSpawn,
      mcpConfigPath: browserMcp?.mcpConfigPath,
    });
  } finally {
    if (browserMcp) await browserMcp.stop();
  }
}

// Strip any GitHub token that may have leaked into an error/clone URL before it
// leaves this process (SFN cause, HTTP error body, logs).
function redact(s) {
  return s.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

// Clone the repo (if provided) into session storage and configure git/gh auth
// using the short-lived GitHub App token. Returns the directory Claude Code
// should run in.
async function setupWorkspace({ repo, githubToken, baseBranch, log }) {
  if (!repo) {
    // No repo context — run in a throwaway dir so Claude Code has a valid cwd.
    return await mkdtemp(join(tmpdir(), 'cc-'));
  }

  const [, name] = repo.split('/');
  const dest = join(WORKSPACE_ROOT, name || 'repo');
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
  // Log the mount's actual free space so a quota regression (issue #180) shows
  // up in CloudWatch instead of only surfacing as an ENOSPC deep in `pnpm install`.
  await logDiskUsage(WORKSPACE_ROOT, log).catch(() => {});
  return dest;
}

// Drive the Claude Code CLI headlessly. `-p` runs a single prompt to
// completion. `--output-format stream-json --verbose` prints one JSON object
// per line (system/assistant/user/result) as the run progresses — needed
// (rather than the simpler `--output-format json`) so each assistant/tool turn
// can be persisted to AgentCore Memory as it happens (issue #186), not just
// the final text.
function runClaudeCode({ prompt, workDir, repo, issueNumber, systemAppend, githubToken, memorySessionId, log, onSpawn, mcpConfigPath }) {
  const appendParts = [];
  if (repo) {
    appendParts.push(
      `You are acting on GitHub repository ${repo}${issueNumber ? `, issue/PR #${issueNumber}` : ''}.`,
      `The repository is already cloned at the current working directory.`,
      `The \`gh\` CLI and \`git\` are authenticated. If you make code changes, create a branch, commit, push, and open a pull request with \`gh\`.`,
      issueNumber
        ? `When finished, your final message should summarize what you did (a caller posts it as a comment on #${issueNumber}).`
        : `When finished, summarize what you did in your final message.`,
    );
  }
  if (systemAppend) appendParts.push(systemAppend);

  const args = [
    '-p', prompt,
    '--model', MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--dangerously-skip-permissions',
  ];
  if (appendParts.length) {
    args.push('--append-system-prompt', appendParts.join('\n'));
  }
  // Give Claude Code the AgentCore Browser tool via MCP (issue #183) — see
  // browser-mcp.js. Absent if the browser session failed to start.
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  const env = {
    ...process.env,
    // Route Claude Code through Amazon Bedrock (the runtime's execution role
    // supplies credentials via the standard AWS provider chain).
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: MODEL,
    HOME: process.env.HOME || '/root',
    // Keep pnpm's virtual store (node_modules/.pnpm) off the quota-limited
    // session-storage mount — see PNPM_VIRTUAL_STORE_DIR above (issue #180).
    npm_config_virtual_store_dir: PNPM_VIRTUAL_STORE_DIR,
    // The container runs as root, and the CLI otherwise refuses
    // `--dangerously-skip-permissions` under root ("cannot be used with
    // root/sudo privileges for security reasons"). AgentCore Runtime executes
    // each session in an isolated Firecracker microVM, so declaring the
    // sandbox is accurate and lets the headless run proceed as root (which
    // keeps the /mnt/workspace mount writable).
    IS_SANDBOX: '1',
  };
  if (githubToken) env.GH_TOKEN = githubToken;

  log(`spawning claude (model=${MODEL}) in ${workDir}`);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: workDir, env });
    // Hand the child back so a cancel invocation (issue #182) can kill it.
    if (typeof onSpawn === 'function') onSpawn(child);
    let resultText = null;
    let stderr = '';
    let buffered = '';

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
      if (memoryClient) {
        persistClaudeStreamEvent(memoryClient, { memoryId: MEMORY_ID, sessionId: memorySessionId, event, log });
      }
    };

    child.stdout.on('data', (d) => {
      buffered += d.toString();
      let newlineIndex;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
        handleLine(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); log('claude:', d.toString().trimEnd()); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buffered.trim()) handleLine(buffered);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(resultText ?? '');
    });
  });
}

// `df -h <path>` for CloudWatch visibility into the session-storage mount's
// actual quota (issue #180) — `run()` discards stdout, so this logs it directly.
function logDiskUsage(path, log) {
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

function run(cmd, args, { log }) {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code AgentCore runtime listening on 0.0.0.0:${PORT} (model=${MODEL})`);
});
