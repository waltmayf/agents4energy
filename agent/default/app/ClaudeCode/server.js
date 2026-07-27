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
//     "systemAppend":"<extra system prompt>"  // optional
//   }
//
// We run the Claude Code CLI headlessly against Amazon Bedrock (same engine as
// anthropics/claude-code-action --use_bedrock), so a customer already using the
// GitHub Action migrates by pointing @agentcore-claude at this runtime instead.
//
// AgentCore sessions can run up to 8h; a single InvokeAgentRuntime request is
// synchronous, so we run Claude Code to completion and return its final text.

import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8080;
// Bedrock model for Claude Code. Overridable via env so the runtime's model can
// be bumped without a code change. Mirrors .github/workflows/claude.yml.
const MODEL = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-5';
// Session storage mount (see agentcore.json filesystemConfigurations). Persists
// across stop/resume so a follow-up comment on the same issue reuses the clone.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/mnt/workspace';

const app = express();
// InvokeAgentRuntime passes the payload through verbatim; it can be large
// (issue bodies, diffs), so lift the default 100kb limit.
app.use(express.json({ limit: '25mb' }));

app.get('/ping', (_req, res) => {
  res.status(200).json({ status: 'Healthy' });
});

app.post('/invocations', async (req, res) => {
  const payload = req.body ?? {};
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ error: 'payload.prompt is required' });
    return;
  }

  const repo = typeof payload.repo === 'string' ? payload.repo : '';
  const issueNumber = payload.issueNumber ?? null;
  const githubToken = typeof payload.githubToken === 'string' ? payload.githubToken : '';
  const baseBranch = typeof payload.branch === 'string' ? payload.branch : '';
  const systemAppend = typeof payload.systemAppend === 'string' ? payload.systemAppend : '';

  const log = (...args) => console.log(`[invocations]`, ...args);
  log(`repo=${repo || '(none)'} issue=${issueNumber ?? '(none)'} promptChars=${prompt.length}`);

  let workDir;
  try {
    workDir = await setupWorkspace({ repo, githubToken, baseBranch, log });
    const finalText = await runClaudeCode({ prompt, workDir, repo, issueNumber, systemAppend, githubToken, log });
    res.status(200).json({ result: finalText, repo: repo || null, issueNumber });
  } catch (err) {
    log('ERROR', err?.stack || String(err));
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    // Leave the git clone under WORKSPACE_ROOT (persistent) for reuse; only the
    // ephemeral config dir (if any) needs cleanup. Nothing to remove here today.
    void workDir;
  }
});

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
  return dest;
}

// Drive the Claude Code CLI headlessly. `-p` runs a single prompt to completion;
// `--output-format json` yields a final result object we can return.
function runClaudeCode({ prompt, workDir, repo, issueNumber, systemAppend, githubToken, log }) {
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
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--dangerously-skip-permissions',
  ];
  if (appendParts.length) {
    args.push('--append-system-prompt', appendParts.join('\n'));
  }

  const env = {
    ...process.env,
    // Route Claude Code through Amazon Bedrock (the runtime's execution role
    // supplies credentials via the standard AWS provider chain).
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: MODEL,
    HOME: process.env.HOME || '/root',
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
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); log('claude:', d.toString().trimEnd()); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      // --output-format json prints a single JSON result object with a `result`
      // string (the final assistant text). Fall back to raw stdout if parsing fails.
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result ?? parsed.text ?? stdout);
      } catch {
        resolve(stdout.trim());
      }
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
