import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mintInstallationToken } from '../_shared/githubAppToken';
import { logGroupName, logStreamName, ensureLogStream, buildLiveTailUrl } from '../_shared/liveTail';
import { sanitizeHarmony } from '../../../lib/harmony-sanitize';
import { friendlyHarnessError } from '../../../lib/harness-error-message';
import { buildRunDurationLine } from '../../../lib/run-duration';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? '';
const GITHUB_APP_PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '';
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? '';
const JIRA_API_EMAIL = process.env.JIRA_API_EMAIL ?? '';
const JIRA_API_TOKEN_SECRET_ARN = process.env.JIRA_API_TOKEN_SECRET_ARN ?? '';
const HOSTING_DOMAIN = process.env.HOSTING_DOMAIN ?? '';
const BRANCH_SLUG = process.env.BRANCH_SLUG ?? '';
const CLAUDE_CODE_RUNTIME_ARN = process.env.CLAUDE_CODE_RUNTIME_ARN ?? '';

// Labels the Step Function manages around a label-triggered run (issue #56):
// `agent-working` while the agent runs, `agent-error` if it fails.
const WORKING_LABEL = 'agent-working';
const ERROR_LABEL = 'agent-error';

interface PostCommentInput {
  runId: string;
  source: 'github' | 'jira';
  // 'awaiting_input' (issue #185, increment 3): the Claude Code runtime ended
  // its run asking the user a question rather than finishing the work. Posts
  // a distinct "paused" comment and does NOT touch the agent-error label.
  // 'monitor_stopped' (issue #262/#263): the monitor loop hit maxIterations
  // without the check ever passing. Like 'awaiting_input', this posts
  // `responseText` verbatim and clears agent-working without adding
  // agent-error — it must NOT go through 'final's success-path "no PR was
  // opened" heuristic, which would overwrite this stage's own explanatory
  // message with a misleading "ran out of turn" one (confirmed end-to-end).
  stage: 'initial' | 'final' | 'awaiting_input' | 'monitor_stopped';
  // github
  repo?: string;
  issueNumber?: number;
  // jira
  issueKey?: string;
  // final stage only — the failure path sends a plain responseText (the error
  // cause); the success path sends responseContent, the native invokeHarness
  // result's Message.Content array (which may be empty).
  responseText?: string;
  responseContent?: Array<{ Text?: string }>;
  // awaiting_input stage only — the question extracted by detectAwaitingInput.
  awaitingQuestion?: string;
  // 'label' when the run was started by the `agentcore` label, 'comment' for an
  // @-mention comment. Both GitHub triggers get the agent-working/agent-error
  // label bookkeeping below (issue #77); Jira runs (no repo/issueNumber) skip it.
  trigger?: 'label' | 'comment';
  // Set on the final stage reached via the Step Function's failure Catch, so
  // this stage adds `agent-error` in addition to removing `agent-working`.
  isError?: boolean;
  // ISO-8601 execution start time from the Step Functions context object
  // ($$.Execution.StartTime), passed by the final/failure states. Used to
  // prepend an "Agent finished after N" line to the final comment (issue #321).
  // Optional so a run that somehow omits it (or the awaiting/monitor stages)
  // just skips the line rather than failing.
  executionStartTime?: string;
}

interface PostCommentOutput {
  logGroupName?: string;
  logStreamName?: string;
  githubToken?: string;
  githubTokenExpiresAt?: string;
  agentsSystemPrompt?: string;
}

async function postGithubCommentWithToken(repo: string, issueNumber: number, body: string, token: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`GitHub createComment failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

async function postGithubComment(repo: string, issueNumber: number, body: string): Promise<{ token: string; expiresAt: string }> {
  if (!GITHUB_APP_PRIVATE_KEY_SECRET_ARN) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_SECRET_ARN not configured');
  }
  const { token, expiresAt } = await mintInstallationToken(repo, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN);
  await postGithubCommentWithToken(repo, issueNumber, body, token);
  return { token, expiresAt };
}

// Detect a real PR URL for THIS repo in the agent's own final text — the
// strongest signal, since the agent is instructed (agent-webhook-invoke-agent's
// <github_access> block) to report the confirmed `gh pr list` URL. Anchored to
// the repo so a PR URL for some other project mentioned in passing doesn't
// count.
function extractPrUrl(text: string, repo: string): string | null {
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`https://github\\.com/${escapedRepo}/pull/\\d+`));
  return match ? match[0] : null;
}

// Fallback ground-truth check (issue #166, direction 4): the agent's final
// text may have been cut off before it ever mentioned a PR URL (the #165
// failure mode — a leaked mid-thought fragment), so also ask GitHub directly
// whether a PR for this task already exists. Two cases count as "a PR
// exists":
//   1. The webhook target itself is already a PR (the `agentcore` label can
//      be applied directly to a PR, per agent-webhook-receiver's
//      `pull_request` labeled-event path) — the agent was asked to keep
//      pushing to it, not open a new one.
//   2. Some other open PR in the repo references this issue/PR number in its
//      title or body (the normal case — a fresh PR closing the issue).
// Best-effort: a listing hiccup must not block the normal comment from
// posting, so callers treat a thrown error the same as "found nothing" — a
// false positive here just means the run skips posting the clearer message.
async function hasOpenPrReferencingIssue(repo: string, issueNumber: number, token: string): Promise<boolean> {
  const targetRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${issueNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (targetRes.ok) {
    const target = await targetRes.json() as { state: string };
    if (target.state === 'open') return true;
  } else if (targetRes.status !== 404) {
    throw new Error(`GitHub get pull #${issueNumber} failed (HTTP ${targetRes.status}): ${await targetRes.text()}`);
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub list pulls failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const pulls = await res.json() as Array<{ title: string; body: string | null }>;
  const ref = new RegExp(`#${issueNumber}\\b`);
  return pulls.some((pr) => ref.test(pr.title) || (pr.body ? ref.test(pr.body) : false));
}

// Add/remove a GitHub label using an already-minted installation token.
// Best-effort: label bookkeeping must never fail the run, so callers swallow
// errors. `addLabel` is idempotent (GitHub ignores a label already present);
// `removeLabel` treats a 404 (label not on the issue) as success.
async function addLabel(repo: string, issueNumber: number, token: string, label: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) throw new Error(`GitHub addLabel(${label}) failed (HTTP ${res.status}): ${await res.text()}`);
}

async function removeLabel(repo: string, issueNumber: number, token: string, label: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub removeLabel(${label}) failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

const secretsManager = new SecretsManagerClient({ region: REGION });

async function getJiraApiToken(): Promise<string> {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: JIRA_API_TOKEN_SECRET_ARN }));
  const token = result.SecretString;
  if (!token) throw new Error('Jira API token secret has no SecretString');
  return token;
}

async function postJiraComment(issueKey: string, body: string): Promise<void> {
  if (!JIRA_BASE_URL || !JIRA_API_EMAIL || !JIRA_API_TOKEN_SECRET_ARN) {
    throw new Error('JIRA_BASE_URL / JIRA_API_EMAIL / JIRA_API_TOKEN_SECRET_ARN not configured');
  }
  const token = await getJiraApiToken();
  const auth = Buffer.from(`${JIRA_API_EMAIL}:${token}`).toString('base64');

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira addComment failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

export const handler = async (input: PostCommentInput): Promise<PostCommentOutput> => {
  const sourceSlug = input.source === 'github' ? (input.repo ?? 'github').replace(/\//g, '-') : (input.issueKey ?? 'jira').split('-')[0];
  const groupName = logGroupName(sourceSlug);
  const streamName = logStreamName(input.runId);

  if (input.stage === 'initial') {
    await ensureLogStream(groupName, streamName);
    const accountId = process.env.ACCOUNT_ID ?? '';
    const liveTailUrl = accountId
      ? buildLiveTailUrl(REGION, accountId, groupName, streamName)
      : null;

    let chatUrl: string | null = null;
    if (HOSTING_DOMAIN && BRANCH_SLUG) {
      chatUrl = `https://${HOSTING_DOMAIN}/${BRANCH_SLUG}/chat?sessionId=${input.runId}`;
    }
    const links = [];
    if (chatUrl) links.push(`[watch live in the chat UI](${chatUrl})`);
    if (liveTailUrl) links.push(`[watch live via CloudWatch Logs Live Tail](${liveTailUrl})`);
    let body = links.length
      ? `🤖 Working on it — ${links.join(' · ')}`
      : `🤖 Working on it (run \`${input.runId}\`)…`;

    // Issue #203: also offer a copy-paste `agentcore exec` command so a
    // developer already in a terminal can attach directly to the running
    // ClaudeCode session, rather than only having browser-based follow-along
    // options. Only when the runtime ARN is configured for this deploy (GitHub
    // runs only — Jira has no ClaudeCode runtime session to attach to).
    if (input.source === 'github' && CLAUDE_CODE_RUNTIME_ARN) {
      body += `\n\nOr attach a terminal directly to the running agent container to follow along (needs \`@aws/agentcore\` CLI >= 0.18 — \`npm i -g @aws/agentcore\` or \`agentcore update cli\`):\n`
        + '```bash\n'
        + `agentcore exec --it --runtime ${CLAUDE_CODE_RUNTIME_ARN} --session-id ${input.runId} --region ${REGION}\n`
        + '```';
    }

    let githubToken: string | undefined;
    let githubTokenExpiresAt: string | undefined;
    let agentsSystemPrompt: string | undefined;

    if (input.source === 'github') {
      if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
      const minted = await postGithubComment(input.repo, input.issueNumber, body);
      githubToken = minted.token;
      githubTokenExpiresAt = minted.expiresAt;

      // Attempt to fetch AGENTS.md from the repo root. If it exists, include its content as a system prompt.
      try {
        const agentsRes = await fetch(`https://api.github.com/repos/${input.repo}/contents/AGENTS.md`, {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (agentsRes.ok) {
          const agentsData = await agentsRes.json();
          // The content field is base64-encoded.
          if (agentsData.content) {
            agentsSystemPrompt = Buffer.from(agentsData.content, 'base64').toString('utf-8');
          }
        }
      } catch (e) {
        console.warn('Failed to fetch AGENTS.md:', e instanceof Error ? e.message : String(e));
      }

      // Mark the issue/PR as actively being worked on. Applied to both label-
      // and comment-mention triggered GitHub runs (issue #77) so the issue list
      // shows an at-a-glance "in progress" signal for either entry point, matching
      // .github/workflows/claude.yml which labels unconditionally. Best-effort —
      // never fail the run over label bookkeeping.
      if (input.trigger === 'label' || input.trigger === 'comment') {
        try {
          await addLabel(input.repo, input.issueNumber, minted.token, WORKING_LABEL);
        } catch (err) {
          console.warn(`Could not add ${WORKING_LABEL} label: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      if (!input.issueKey) throw new Error('issueKey required for jira source');
      await postJiraComment(input.issueKey, body);
    }

    // Always emit agentsSystemPrompt as a string (never undefined): the
    // downstream PrepareGitAuth step reads it with JsonPath.stringAt(), which
    // throws "could not be found in the input" if the field is absent from the
    // JSON. That happens whenever the target repo has no root AGENTS.md (e.g.
    // aws-samples/sample-edge-to-cloud-digital-ops-workshop), which previously
    // failed the whole execution. Consumers already treat '' as "no prompt".
    return { logGroupName: groupName, logStreamName: streamName, githubToken, githubTokenExpiresAt, agentsSystemPrompt: agentsSystemPrompt ?? '' };
  }

  if (input.stage === 'awaiting_input' || input.stage === 'monitor_stopped') {
    const body = input.stage === 'awaiting_input'
      ? sanitizeHarmony(`⏸️ Paused — waiting for your input: ${input.awaitingQuestion || '(no question text captured)'}`)
      : sanitizeHarmony(input.responseText || 'Monitoring stopped without the condition being met.');
    if (input.source === 'github') {
      if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
      const { token } = await postGithubComment(input.repo, input.issueNumber, body);
      // Clear agent-working like a normal completion, but never add agent-error —
      // this is a pause/stop, not a failure. Best-effort, matching the final stage.
      if (input.trigger === 'label' || input.trigger === 'comment') {
        try {
          await removeLabel(input.repo, input.issueNumber, token, WORKING_LABEL);
        } catch (err) {
          console.warn(`Could not remove ${WORKING_LABEL} label: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      if (!input.issueKey) throw new Error('issueKey required for jira source');
      await postJiraComment(input.issueKey, body);
    }
    return {};
  }

  // Final stage — post the agent's response as a follow-up comment.
  // Success path: use only the last text block of the native invokeHarness result's
  // Message.Content (the integration omits tool-use/reasoning blocks, so this
  // can be empty). Failure path: responseText carries the error cause.
  const lastBlockText = (input.responseContent ?? [])
    .filter((block) => block?.Text)
    .map((block) => block?.Text ?? '')
    .pop();
  // On the failure path (input.responseText carries the raw error cause), turn a
  // recognized harness failure — chiefly context-window overflow (#140) — into a
  // concise, actionable message rather than posting the raw Bedrock exception.
  // Falls back to the raw cause for unrecognized errors.
  const failureText = input.responseText
    ? (friendlyHarnessError(input.responseText) ?? input.responseText)
    : undefined;
  // Strip any leaked Harmony special tokens (<|channel|>/<|message|>/…) the
  // gpt-oss-120b harness can emit into the plain-text block (issue #105) before
  // posting. Applied to both the success text and the failure cause so neither
  // path posts raw model markup. sanitizeHarmony is a no-op on clean text.
  let responseText = sanitizeHarmony(
    failureText
      ?? (lastBlockText?.trim() || '_The agent finished but produced no text response (it may have ended on a tool action). See the CloudWatch logs linked above._'),
  );

  // Prepend the total run duration (issue #321): "Agent finished after N ____".
  // A failed run reads "Agent failed after N". Computed from the execution's
  // start time (Step Functions context object) vs now. Skipped silently if the
  // start time is missing/unparseable. Prepended here so BOTH the github and
  // jira post paths include it; the github "no PR opened" heuristic below
  // rebuilds responseText, so this must run after that — see prependDuration().
  const durationLine = buildRunDurationLine(
    input.executionStartTime,
    Date.now(),
    input.isError ? 'Agent failed after' : 'Agent finished after',
  );
  const prependDuration = (text: string): string =>
    durationLine ? `${durationLine}\n\n____\n\n${text}` : text;
  if (input.source === 'github') {
    if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
    if (!GITHUB_APP_PRIVATE_KEY_SECRET_ARN) throw new Error('GITHUB_APP_PRIVATE_KEY_SECRET_ARN not configured');
    const { token } = await mintInstallationToken(input.repo, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN);

    // Issue #166, direction 4: every GitHub run is told (agent-webhook-invoke-agent's
    // <github_access> block) to push a branch and open a PR, so a SUCCEEDED run
    // that did neither is the "ran out of turn" failure mode — the agent's final
    // text is often a cut-off chain-of-thought fragment rather than a clear
    // status, which is confusing on the issue thread. Detect it and replace the
    // raw text with an unambiguous message. Skipped on the failure path
    // (isError) — that already gets a distinct, purpose-built message above.
    if (!input.isError) {
      const prUrlInText = extractPrUrl(responseText, input.repo);
      if (!prUrlInText) {
        // Determine if we have a substantive answer from the agent. For non-coding runs,
        // the responseContent will contain one or more text blocks. If any block has
        // non‑empty text, we consider the run to have produced a real answer and skip
        // the "no PR" replacement heuristic.
        const hasAnswer = (input.responseContent ?? []).some((b) => b?.Text?.trim());
        if (!hasAnswer) {
          try {
            const prExists = await hasOpenPrReferencingIssue(input.repo, input.issueNumber, token);
            if (!prExists) {
              responseText = sanitizeHarmony(
                'The run ended before pushing a branch (likely hit the per-turn ceiling after editing part of the task); '
                + 'no PR was created — re-dispatch with a smaller scope.',
              );
            }
          } catch (err) {
            // Best-effort — a listing hiccup must not block the original comment.
            console.warn(`Could not check for an existing PR referencing #${input.issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    await postGithubCommentWithToken(input.repo, input.issueNumber, prependDuration(responseText), token);

    // Clear agent-working now that the run is done, and flag agent-error if this
    // final stage was reached via the failure Catch. Applied to both label- and
    // comment-mention triggered runs (issue #77) so the working label added at
    // the initial stage is always cleared and failures are always flagged.
    // Best-effort — a label API hiccup must not fail the whole execution.
    if (input.trigger === 'label' || input.trigger === 'comment') {
      try {
        await removeLabel(input.repo, input.issueNumber, token, WORKING_LABEL);
        if (input.isError) {
          await addLabel(input.repo, input.issueNumber, token, ERROR_LABEL);
        }
      } catch (err) {
        console.warn(`Could not update labels: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    if (!input.issueKey) throw new Error('issueKey required for jira source');
    await postJiraComment(input.issueKey, prependDuration(responseText));
  }

  return {};
};
