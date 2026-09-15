// CodeBuild build entrypoint for the @agentcore-claude coding worker
// (epic #558, slice 2a/7 — issue #570).
//
// This is the CodeBuild counterpart to server.js's AgentCore-Runtime HTTP
// shell: it drives the SAME portable core (worker-core.js) from ENVIRONMENT
// VARIABLES set by `StartBuild --environment-variables-override`, instead of an
// HTTP `/invocations` body. There is NO Express server, NO GET /ping, and NO
// Step Functions taskToken callback here — a CodeBuild build is a single
// foreground process with an 8 h ceiling, so it just runs the job to completion
// and writes a structured result the future SFN loop (#564) reads back.
//
// ── Job payload contract (environment variables) ──────────────────────────
// Mirrors InvokeClaudeInput in
// web/amplify/functions/agent-webhook-invoke-claude/handler.ts. All are set by
// StartBuild's `environmentVariablesOverride`; every field is optional except a
// prompt (empty prompt → the build fails loudly, exit 1).
//
//   A4E_RUN_ID              run id; also the AgentCore Memory / ActiveRun
//                           sessionId (so the browser live-view + chat history
//                           key to the same session as the runtime path did).
//   A4E_REPO                "owner/name" — enables git clone + PR (optional).
//   A4E_ISSUE_NUMBER        issue/PR number for the reply (optional).
//   A4E_PROMPT              the user request, @-mention stripped (required).
//   A4E_GITHUB_TOKEN        short-lived GitHub App installation token (optional).
//   A4E_SYSTEM_APPEND       extra system prompt appended to Claude Code's
//                           (AGENTS.md-derived on the webhook path) (optional).
//   A4E_COGNITO_ACCESS_TOKEN  relayed Cognito ACCESS token for gateway MCP
//                           tools (#339/#340) (optional).
//   A4E_BASE_BRANCH         base branch to clone (optional; repo default).
//
// ── Result outputs ────────────────────────────────────────────────────────
// On completion (success OR a handled awaiting/monitor state), a structured
// result JSON is written to:
//   - a build ARTIFACT file at A4E_RESULT_PATH (default ./a4e-result.json,
//     relative to $CODEBUILD_SRC_DIR), and
//   - (best-effort) an SSM String param at A4E_RESULT_SSM_PATH if set, keyed by
//     A4E_RUN_ID by the caller.
// so the future SFN monitor loop (#564) can read {finalText, agentStatus,
// awaitingQuestion, monitorSpec} without a taskToken callback (there is no
// taskToken in this slice — do NOT call SendTaskSuccess/Failure).
//
// The build EXITS NON-ZERO on any unhandled failure so it fails loudly (the
// #310/#324 "green CI, dead runtime" class of bug never recurs silently).
//
// ── Dry run ───────────────────────────────────────────────────────────────
// `node codebuild-entrypoint.js --dry-run` (or A4E_DRY_RUN=1) parses the env,
// assembles the `claude` argv via the shared buildClaudeArgs, prints it, and
// exits 0 WITHOUT cloning a repo or spawning the CLI — proving the entrypoint
// reaches runClaudeCode arg assembly without any of the Express/ping/taskToken
// shell (issue #570 acceptance gate).

import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import {
  runManagedJob,
  buildClaudeArgs,
  redact,
  memoryClient,
  MEMORY_ID,
  MEMORY_REGION,
} from './worker-core.js';
import { persistUserPrompt, persistAwaitingInputMarker } from './memory.js';
import { detectAwaitingInput } from './detect-awaiting-input.js';
import { detectMonitorRequest } from './detect-monitor.js';

const log = (...args) => console.log('[codebuild]', ...args);

// Parse the job payload from the StartBuild-provided environment.
function readJobFromEnv() {
  const num = (v) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    runId: process.env.A4E_RUN_ID || '',
    repo: process.env.A4E_REPO || '',
    issueNumber: num(process.env.A4E_ISSUE_NUMBER),
    prompt: (process.env.A4E_PROMPT || '').trim(),
    githubToken: process.env.A4E_GITHUB_TOKEN || '',
    systemAppend: process.env.A4E_SYSTEM_APPEND || '',
    cognitoAccessToken: process.env.A4E_COGNITO_ACCESS_TOKEN || '',
    baseBranch: process.env.A4E_BASE_BRANCH || '',
  };
}

// Where the structured result artifact is written. Relative paths resolve
// against $CODEBUILD_SRC_DIR (the build source root) so the buildspec's
// `artifacts.files` can pick it up.
function resultFilePath() {
  const configured = process.env.A4E_RESULT_PATH || 'a4e-result.json';
  if (isAbsolute(configured)) return configured;
  const base = process.env.CODEBUILD_SRC_DIR || process.cwd();
  return join(base, configured);
}

async function writeResultArtifact(result) {
  const path = resultFilePath();
  try {
    await writeFile(path, JSON.stringify(result, null, 2));
    log(`wrote result artifact to ${path}`);
  } catch (err) {
    log('failed to write result artifact:', err?.message || String(err));
  }
}

// Best-effort mirror of the result to an SSM String parameter, so the SFN loop
// (#564) can read it without an artifact roundtrip. No-op unless
// A4E_RESULT_SSM_PATH is set. Imported lazily so the dry-run and the common
// (no-SSM) path never pull in the SSM client.
async function writeResultSsm(result) {
  const name = process.env.A4E_RESULT_SSM_PATH || '';
  if (!name) return;
  try {
    const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssm = new SSMClient({ region: process.env.AWS_REGION });
    await ssm.send(new PutParameterCommand({
      Name: name,
      Type: 'String',
      Overwrite: true,
      Value: JSON.stringify(result),
    }));
    log(`wrote result to SSM parameter ${name}`);
  } catch (err) {
    log('failed to write result to SSM (best-effort):', err?.message || String(err));
  }
}

// Classify the final message into the same agentStatus/awaitingQuestion/
// monitorSpec shape server.js's callback emits to the state machine — minus the
// SendTaskSuccess (there's no taskToken here). Kept identical so #564 can reuse
// the runtime path's SFN Choice branching unchanged.
function classifyResult(finalText) {
  const { awaiting, question } = detectAwaitingInput(finalText);
  // `awaiting` takes precedence — a run asking the user a question isn't
  // monitoring — so only check for a monitor block when there's no question.
  const monitorResult = awaiting ? { monitor: false } : detectMonitorRequest(finalText);
  let agentStatus = 'completed';
  if (awaiting) agentStatus = 'awaiting_input';
  else if (monitorResult.monitor) agentStatus = 'monitoring';
  return {
    agentStatus,
    ...(awaiting ? { awaitingQuestion: question } : {}),
    ...(monitorResult.monitor ? { monitorSpec: monitorResult.spec } : {}),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.A4E_DRY_RUN === '1';
  const job = readJobFromEnv();

  if (!job.prompt) {
    // Fail loudly — a build with no prompt is a wiring bug, not a no-op.
    throw new Error('A4E_PROMPT is required (empty prompt).');
  }

  log(`runId=${job.runId || '(none)'} repo=${job.repo || '(none)'} issue=${job.issueNumber ?? '(none)'} promptChars=${job.prompt.length}${dryRun ? ' [DRY RUN]' : ''}`);

  // memorySessionId keys AgentCore Memory + ActiveRun to the run's session,
  // exactly like the runtime path (which used the runtime session-id header,
  // itself always equal to runId).
  const memorySessionId = job.runId;

  if (dryRun) {
    // Prove we reach runClaudeCode arg assembly without cloning or spawning.
    const args = buildClaudeArgs({
      prompt: job.prompt,
      repo: job.repo,
      issueNumber: job.issueNumber,
      systemAppend: job.systemAppend,
      // No MCP config in the dry-run (no workspace to write it into).
      mcpConfigPath: null,
    });
    log(`dry-run: assembled ${args.length} claude args:`);
    log(JSON.stringify(args, null, 2));
    log('dry-run complete — did not clone a repo or spawn the CLI.');
    return;
  }

  if (memoryClient) {
    await persistUserPrompt(memoryClient, {
      memoryId: MEMORY_ID, sessionId: memorySessionId, prompt: job.prompt, log,
    });
  } else {
    log(`AgentCore Memory not configured (AGENTCORE_MEMORY_ID empty); skipping memory persistence. region=${MEMORY_REGION}`);
  }

  // Run the portable core to completion. `enableBrowser: false` — CodeBuild has
  // no AgentCore Browser session, so the browser MCP tool is omitted (the
  // gateway-routed MCP tools still work via plain HTTP + bearer token).
  const finalText = await runManagedJob({
    prompt: job.prompt,
    repo: job.repo,
    issueNumber: job.issueNumber,
    githubToken: job.githubToken,
    baseBranch: job.baseBranch,
    systemAppend: job.systemAppend,
    memorySessionId,
    log,
    cognitoAccessToken: job.cognitoAccessToken,
    enableBrowser: false,
  });

  const classification = classifyResult(finalText);
  log(`job finished (${finalText.length} chars); agentStatus=${classification.agentStatus}`);

  // Persist an awaiting-input marker turn to Memory, same as the runtime
  // callback path, so a future re-trigger can read that the run stopped
  // mid-question.
  if (classification.agentStatus === 'awaiting_input' && memoryClient) {
    await persistAwaitingInputMarker(memoryClient, {
      memoryId: MEMORY_ID, sessionId: memorySessionId, question: classification.awaitingQuestion, log,
    });
  }

  const result = {
    runId: job.runId,
    repo: job.repo || null,
    issueNumber: job.issueNumber,
    finalText,
    ...classification,
  };
  await writeResultArtifact(result);
  await writeResultSsm(result);
}

main().then(
  () => {
    log('done.');
    process.exit(0);
  },
  (err) => {
    // Loud failure: non-zero exit so the CodeBuild build is marked FAILED (the
    // #310/#324 win — a crashed worker must never look green). Redact any token
    // that might have leaked into a clone-URL error.
    console.error('[codebuild] FATAL:', redact(String(err?.stack || err?.message || err)));
    process.exit(1);
  },
);
