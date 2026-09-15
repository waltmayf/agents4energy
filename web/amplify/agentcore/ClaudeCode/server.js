// Claude Code invocation server for AgentCore Runtime.
//
// This is the AgentCore-Runtime-SPECIFIC HTTP shell around the portable worker
// core in worker-core.js. It implements the AgentCore Runtime HTTP contract
// (docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html):
//   GET  /ping         → health check ({"status":"Healthy"})
//   POST /invocations  → do the work; body is the caller's payload verbatim
//
// Everything host-agnostic — setupWorkspace, runClaudeCode, runManagedJob, the
// ActiveRun/Memory publishing — lives in worker-core.js and is shared with the
// CodeBuild build entrypoint (codebuild-entrypoint.js, epic #558). Only the
// bits that exist BECAUSE this runs inside an AgentCore Runtime stay here: the
// Express server, GET /ping HealthyBusy microVM-pinning, the Step Functions
// taskToken callback, cancel-via-session routing, and the runtime session-id
// header. None of that is ported to CodeBuild.
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
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { persistUserPrompt, persistAwaitingInputMarker } from './memory.js';
import { detectAwaitingInput } from './detect-awaiting-input.js';
import { detectMonitorRequest } from './detect-monitor.js';
import { runManagedJob, redact, memoryClient, MEMORY_ID, MODEL } from './worker-core.js';

const PORT = 8080;
// SendTaskSuccess/Failure need only the token + a client in the SAME region and
// account as the state machine (the runtime's execution role is granted
// states:SendTask* on the webhook state machine ARN in backend.ts). AWS_REGION
// is always set inside the AgentCore Runtime container.
const sfn = new SFNClient({ region: process.env.AWS_REGION });

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
// routes the 'ClaudeCodeRuntimeCancelled' error code to PostCancelledComment
// (issue #452 — a neutral "superseded" comment, not agent-error); deliberately
// omits the raw "@" mention so the superseded-run comment can never re-trigger
// the webhook.
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
  // The signed-in caller's Cognito ACCESS token (#339), relayed verbatim by
  // web/lib/claude-code-agent.ts so this run's gateway-routed MCP tools are
  // authorized against the invoking user's own cognito:groups — see
  // gateway-mcp.js. Absent on the webhook (@agentcore-claude) path, which has
  // no signed-in browser user (#340 covers that path separately).
  const cognitoAccessToken = typeof payload.cognitoAccessToken === 'string' ? payload.cognitoAccessToken : '';
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

  const runJob = (onSpawn) => runManagedJob({ prompt, repo, issueNumber, githubToken, baseBranch, systemAppend, memorySessionId, log, onSpawn, cognitoAccessToken });

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
        // Detect an ask-for-input final message (issue #185, increment 2/3).
        // When detected, persist a marker turn to Memory so a future
        // re-trigger increment can read back that the run stopped mid-question,
        // and (increment 3) tag the SendTaskSuccess output with a distinct
        // `agentStatus` so the state machine can branch to a dedicated
        // "awaiting input" comment instead of the normal final comment.
        const { awaiting, question } = detectAwaitingInput(finalText);
        if (awaiting) {
          log(`awaiting_input detected: ${question}`);
          if (memoryClient) {
            await persistAwaitingInputMarker(memoryClient, {
              memoryId: MEMORY_ID, sessionId: memorySessionId, question, log,
            });
          }
        }
        // Detect a monitor handoff request (issue #261): the run wants to wait
        // on an external async condition rather than finish now. `awaiting`
        // takes precedence — a run asking the user a question isn't monitoring
        // — so only check for a monitor block when there's no question.
        const monitorResult = awaiting ? { monitor: false } : detectMonitorRequest(finalText);
        if (monitorResult.monitor) {
          log(`monitoring handoff detected: ${JSON.stringify(monitorResult.spec)}`);
        }
        log(`[callback] job finished (${finalText.length} chars); sending SendTaskSuccess`);
        // Output.Message.Content stays byte-for-byte identical to the pre-#185
        // shape (the native invokeHarness task produces the same shape) so
        // PostFinalComment is unaffected. `agentStatus`/`awaitingQuestion`/
        // `monitorSpec` are additive top-level fields the SFN Choice below
        // branches on; they are only ever present when detected.
        await sfn.send(new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify({
            Output: { Message: { Role: 'assistant', Content: [{ Text: finalText }] } },
            ...(awaiting ? { agentStatus: 'awaiting_input', awaitingQuestion: question } : {}),
            ...(monitorResult.monitor ? { agentStatus: 'monitoring', monitorSpec: monitorResult.spec } : {}),
          }),
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code AgentCore runtime listening on 0.0.0.0:${PORT} (model=${MODEL})`);
});
