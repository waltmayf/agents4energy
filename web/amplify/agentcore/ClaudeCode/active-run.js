// Server-side ActiveRun producer for the ClaudeCode AgentCore runtime (issue
// #15's "browserless run" scenario). Mirrors web/lib/active-run.ts's
// upsert/clear semantics byte-for-byte — same one-row-per-session
// list-then-update-or-create, same delete-on-done — so a late-joining viewer's
// loadHistory() (which reads that model) can't tell whether the snapshot it
// sees came from a browser tab or from a run started via @agentcore-claude.
//
// Unlike the browser producer, this runtime is not a Cognito principal — it
// can't use the Amplify Data client (which requires a userPool/identityPool
// auth session). It IS a plain IAM principal (the runtime's own execution
// role), so it calls the AppSync GraphQL API directly over HTTPS, signing each
// request with SigV4 — exactly what scripts/graphql.sh does locally with the
// developer's own credentials. See docs/active-run-live-view.md.
//
// Best-effort throughout: every export swallows and logs its own errors. A
// snapshot write must never fail, delay, or retry into the actual Claude Code
// run.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

// Key query against the sessionId GSI (see chat.schema.ts's secondaryIndexes())
// rather than listActiveRuns' Scan-with-filter.
const LIST_ACTIVE_RUNS = `
  query ListActiveRunBySession($sessionId: ID!) {
    listActiveRunBySession(sessionId: $sessionId, limit: 1) {
      items { id }
    }
  }
`;

const CREATE_ACTIVE_RUN = `
  mutation CreateActiveRun($input: CreateActiveRunInput!) {
    createActiveRun(input: $input) { id }
  }
`;

const UPDATE_ACTIVE_RUN = `
  mutation UpdateActiveRun($input: UpdateActiveRunInput!) {
    updateActiveRun(input: $input) { id }
  }
`;

const DELETE_ACTIVE_RUN = `
  mutation DeleteActiveRun($input: DeleteActiveRunInput!) {
    deleteActiveRun(input: $input) { id }
  }
`;

const credentialProvider = fromNodeProviderChain();

let cachedConfigPromise = null;

/**
 * Fetch { url, region } published to SSM by scripts/build.sh, once per
 * process. Returns null (and logs) if the parameter is absent — e.g. a local
 * `agentcore dev` run with no matching deploy — so callers can no-op cleanly.
 */
function loadConfig(log) {
  if (cachedConfigPromise) return cachedConfigPromise;
  cachedConfigPromise = (async () => {
    const path = process.env.ACTIVERUN_GRAPHQL_SSM_PATH || '';
    if (!path) {
      log?.('[active-run] ACTIVERUN_GRAPHQL_SSM_PATH not set; ActiveRun snapshots disabled');
      return null;
    }
    try {
      const ssm = new SSMClient({ region: process.env.AWS_REGION });
      const res = await ssm.send(new GetParameterCommand({ Name: path }));
      const value = res.Parameter?.Value ? JSON.parse(res.Parameter.Value) : null;
      if (!value?.url || !value?.region) throw new Error('missing url/region in SSM value');
      return value;
    } catch (err) {
      log?.('[active-run] failed to load GraphQL config from SSM; ActiveRun snapshots disabled:', err?.message || String(err));
      return null;
    }
  })();
  return cachedConfigPromise;
}

async function signedGraphqlRequest({ url, region, query, variables, log }) {
  const endpoint = new URL(url);
  const body = JSON.stringify({ query, variables });

  const request = new HttpRequest({
    method: 'POST',
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: endpoint.pathname,
    headers: {
      'Content-Type': 'application/json',
      host: endpoint.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: credentialProvider,
    region,
    service: 'appsync',
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  const res = await fetch(url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function findActiveRunId({ url, region, sessionId, log }) {
  const data = await signedGraphqlRequest({
    url, region, query: LIST_ACTIVE_RUNS, variables: { sessionId }, log,
  });
  return data?.listActiveRunBySession?.items?.[0]?.id ?? null;
}

/**
 * Write a throttled snapshot of the in-flight assistant message for a
 * session. Creates the session's row on first write, updates it (by id)
 * thereafter — same contract as web/lib/active-run.ts's upsertActiveRun, so
 * the caller can cache the returned id across throttled writes in one run.
 * Returns the row id on success, or null on failure/no-op (never throws).
 */
export async function upsertActiveRun({ sessionId, messageId, accumulatedText, status }, existingId, log) {
  const config = await loadConfig(log);
  if (!config) return null;
  try {
    const updatedAt = new Date().toISOString();
    const id = existingId ?? (await findActiveRunId({ ...config, sessionId, log }));
    if (id) {
      const data = await signedGraphqlRequest({
        ...config,
        query: UPDATE_ACTIVE_RUN,
        variables: { input: { id, messageId, accumulatedText, status, updatedAt } },
        log,
      });
      return data?.updateActiveRun?.id ?? id;
    }
    const data = await signedGraphqlRequest({
      ...config,
      query: CREATE_ACTIVE_RUN,
      variables: { input: { sessionId, messageId, accumulatedText, status, updatedAt } },
      log,
    });
    return data?.createActiveRun?.id ?? null;
  } catch (err) {
    log?.('[active-run] upsert failed for session', sessionId, ':', err?.message || String(err));
    return null;
  }
}

/** Delete the session's ActiveRun row, swallowing errors — best-effort cleanup. */
export async function clearActiveRun(sessionId, log) {
  const config = await loadConfig(log);
  if (!config) return;
  try {
    const id = await findActiveRunId({ ...config, sessionId, log });
    if (!id) return;
    await signedGraphqlRequest({
      ...config,
      query: DELETE_ACTIVE_RUN,
      variables: { input: { id } },
      log,
    });
  } catch (err) {
    log?.('[active-run] clear failed for session', sessionId, ':', err?.message || String(err));
  }
}
