import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const HARNESS_ARN = process.env.HARNESS_ARN ?? '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const SERVICE_ACCOUNT_USERNAME = process.env.SERVICE_ACCOUNT_USERNAME ?? '';
const SERVICE_ACCOUNT_SSM_PATH = process.env.SERVICE_ACCOUNT_SSM_PATH ?? '';

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// Cache the access token across warm invocations (~1 hour lifetime).
let cachedAccessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  const passwordParam = await ssm.send(new GetParameterCommand({
    Name: SERVICE_ACCOUNT_SSM_PATH,
    WithDecryption: true,
  }));
  const password = passwordParam.Parameter?.Value;
  if (!password) throw new Error('Service account password not found in SSM');

  const authRes = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: {
      USERNAME: SERVICE_ACCOUNT_USERNAME,
      PASSWORD: password,
    },
  }));

  const token = authRes.AuthenticationResult?.AccessToken;
  if (!token) throw new Error('Failed to obtain Cognito access token for service account');

  cachedAccessToken = token;
  return token;
}

interface InvokeAgentInput {
  runId: string;
  source: 'github' | 'jira';
  prompt: string;
  repo: string | null;
  issueNumber: number | null;
  issueKey: string | null;
  githubToken?: string | null;
  logGroupName?: string;
  logStreamName?: string;
}

interface InvokeAgentOutput {
  response: string;
}

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Logging is best-effort — never fail the agent invocation because a log write failed.
  }
}

// Invoke the AgentCore Harness over its HTTP `/harnesses/invoke` endpoint,
// authenticated with a Cognito service-account JWT — the same path the
// browser-initiated invoke-agent Lambda uses (web/amplify/functions/invoke-agent/handler.ts).
// The harness authorizes with CUSTOM_JWT (not SigV4), so a raw
// InvokeAgentRuntimeCommand against the runtime fails with an
// "Authorization method mismatch" error; the JWT path is the supported one.
// The response is an AWS binary event stream — decode contentBlockDelta frames
// into the full text (identical framing logic to invoke-agent + scripts/invoke.ts).
async function invokeHarness(opts: {
  sessionId: string;
  prompt: string;
}): Promise<string> {
  const { sessionId, prompt } = opts;

  if (!HARNESS_ARN) throw new Error('HARNESS_ARN not configured');

  const accessToken = await getAccessToken();

  const region = HARNESS_ARN.split(':')[3];
  const encodedArn = encodeURIComponent(HARNESS_ARN);
  const url = `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke?harnessArn=${encodedArn}`;

  const body: Record<string, unknown> = {
    runtimeSessionId: sessionId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    // Reset token cache on auth errors so the next invocation re-authenticates.
    if (response.status === 401 || response.status === 403) cachedAccessToken = null;
    throw new Error(`Harness HTTP ${response.status}: ${text}`);
  }

  const chunks: string[] = [];
  let raw = Buffer.alloc(0);

  for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
    raw = Buffer.concat([raw, chunk]);

    while (raw.length >= 12) {
      const totalLen = raw.readUInt32BE(0);
      if (raw.length < totalLen) break;

      const headersLen = raw.readUInt32BE(4);
      let pos = 12;
      const headersEnd = pos + headersLen;
      const headers: Record<string, string> = {};

      while (pos < headersEnd) {
        const nameLen = raw[pos++];
        const name = raw.subarray(pos, pos + nameLen).toString('utf8');
        pos += nameLen;
        pos++; // value type byte
        const valLen = raw.readUInt16BE(pos); pos += 2;
        headers[name] = raw.subarray(pos, pos + valLen).toString('utf8');
        pos += valLen;
      }

      const payloadBytes = raw.subarray(12 + headersLen, totalLen - 4);
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(payloadBytes.toString('utf8')); } catch { /* empty frame */ }

      // The stream frames errors as `:message-type: exception` (e.g. a bad
      // model id surfaces here as a ValidationException). Surface it instead
      // of silently returning "(no response)" — a swallowed exception frame is
      // what made an invalid harness model look like an empty agent reply.
      if (headers[':message-type'] === 'exception' || headers[':event-type'] === 'exception') {
        const message = (payload?.message as string | undefined) ?? payloadBytes.toString('utf8');
        throw new Error(`Harness stream exception (${headers[':exception-type'] ?? 'unknown'}): ${message}`);
      }

      if (headers[':event-type'] === 'contentBlockDelta') {
        const text = (payload?.delta as Record<string, unknown> | undefined)?.text as string | undefined;
        if (text) chunks.push(text);
      }

      raw = raw.subarray(totalLen);
    }
  }

  return chunks.join('');
}

export const handler = async (input: InvokeAgentInput): Promise<InvokeAgentOutput> => {
  const { runId, source, prompt, logGroupName, logStreamName } = input;

  await log(logGroupName, logStreamName, `[${runId}] invoking harness (source=${source})`);

  // The harness invoke is a single blocking event-stream read (fully consumed
  // below before returning), so emit a heartbeat every 20s while waiting. This
  // is the best "live" signal available without streaming step-by-step events
  // into this run's log stream — see docs/webhook-stepfunction-integration.md.
  const heartbeat = setInterval(() => {
    void log(logGroupName, logStreamName, `[${runId}] still running…`);
  }, 20_000);

  try {
    const response = await invokeHarness({ sessionId: runId, prompt });
    const finalText = response || '(no response)';

    await log(logGroupName, logStreamName, `[${runId}] harness responded (${finalText.length} chars)`);
    return { response: finalText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(logGroupName, logStreamName, `[${runId}] harness invocation failed: ${message}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
};
