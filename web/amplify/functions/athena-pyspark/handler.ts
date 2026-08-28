import type { Context } from 'aws-lambda';
import {
  AthenaClient,
  StartSessionCommand,
  GetSessionStatusCommand,
  StartCalculationExecutionCommand,
  GetCalculationExecutionCommand,
  ListSessionsCommand,
} from '@aws-sdk/client-athena';
import { S3Client, GetObjectCommand, ListObjectsV2Command, NotFound } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { resolveArtifactsPrefix } from '../../../lib/s3-fs-upload';
import { loadPythonScript } from './loadScript';

const ATHENA_WORKGROUP = process.env.ATHENA_PYSPARK_WORKGROUP_NAME!;
const STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME!;
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

const athena = new AthenaClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

// The gateway invokes this Lambda directly — the event IS the tool's input
// arguments (see s3-tools/handler.ts). Three tools (SubmitPySpark,
// GetPySparkStatus, GetPySparkResults) back this target, so dispatch on
// bedrockAgentCoreToolName the same way s3-tools/graph-traverse do.
interface GatewayClientContext {
  custom?: {
    bedrockAgentCoreToolName?: string;
  };
}

function extractToolName(context: Context): string {
  const raw = (context.clientContext as GatewayClientContext | undefined)?.custom?.bedrockAgentCoreToolName;
  if (!raw) return 'SubmitPySpark';
  const idx = raw.lastIndexOf('___');
  return idx === -1 ? raw : raw.slice(idx + 3);
}

interface ToolEvent {
  code?: string;
  subdir?: string;
  description?: string;
  calculationId?: string;
  [key: string]: unknown;
}

// Maximum characters returned for stdout/stderr/result content to keep tool
// responses within the harness's context budget — full output stays in S3.
const MAX_OUTPUT_CHARS = 20000;

function truncateOutput(content: string, label: string): string {
  if (content.length <= MAX_OUTPUT_CHARS) return content;
  const truncated = content.slice(0, MAX_OUTPUT_CHARS);
  const omitted = content.length - MAX_OUTPUT_CHARS;
  return `${truncated}\n\n... [${label} truncated — ${omitted.toLocaleString()} characters omitted. Full output available in S3.]`;
}

async function readS3File(s3Uri: string): Promise<string> {
  if (!s3Uri.startsWith('s3://')) throw new Error(`Invalid S3 URI: ${s3Uri}`);
  const uriWithoutProtocol = s3Uri.substring(5);
  const firstSlashIndex = uriWithoutProtocol.indexOf('/');
  if (firstSlashIndex === -1) throw new Error(`Invalid S3 URI format: ${s3Uri}`);
  const bucket = uriWithoutProtocol.substring(0, firstSlashIndex);
  const key = uriWithoutProtocol.substring(firstSlashIndex + 1);

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString('utf-8')) ?? '';
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NoSuchKey') return '';
    throw err;
  }
}

/** Matches quoted, extension-having string literals in the code — a cheap heuristic for "files this script reads". */
function extractReferencedFilePaths(code: string): string[] {
  const filePathRegex = /['"]([a-zA-Z0-9_./\-]+\.[a-zA-Z0-9]{2,4})['"](?:\s*[,)}]|\s*$|\s*\n|$)/g;
  const matches = code.match(filePathRegex) ?? [];
  const paths = matches
    .map((match) => match.match(/['"]([a-zA-Z0-9_./\-]+\.[a-zA-Z0-9]{2,4})['"]/)?.[1])
    .filter((p): p is string => Boolean(p));
  return [...new Set(paths)];
}

/** sessionSetup + preExecution + <user code> + postExecution, composed fresh for every submission (idempotent — safe to run on every calculation, new or reused session). */
function buildScript(code: string, artifactsPrefix: string): string {
  const setup = loadPythonScript('sessionSetup.py', {
    AWS_REGION,
    STORAGE_BUCKET_NAME,
    ARTIFACTS_S3_PREFIX: artifactsPrefix,
  });
  const filesToDownload = extractReferencedFilePaths(code);
  const pre = `\nfiles_to_download = ${JSON.stringify(filesToDownload)}\n` + loadPythonScript('preExecution.py');
  const post = loadPythonScript('postExecution.py');
  return `${setup}\n${pre}\n\n${code}\n${post}`;
}

const SESSION_TAG_PREFIX = 'ChatSessionID:';
function sessionTag(subdir: string): string {
  return `[${SESSION_TAG_PREFIX}${subdir}]`;
}

// Non-terminal session states — a session in one of these may still reach
// IDLE; TERMINATED/FAILED/DEGRADED sessions are dead and a new one is created.
const LIVE_SESSION_STATES = new Set(['CREATING', 'IDLE', 'BUSY']);

async function findExistingSession(subdir: string): Promise<{ sessionId: string; state: string } | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await athena.send(new ListSessionsCommand({ WorkGroup: ATHENA_WORKGROUP, NextToken: nextToken }));
    const match = (res.Sessions ?? []).find(
      (s) => s.Description?.includes(sessionTag(subdir)) && s.SessionId && LIVE_SESSION_STATES.has(s.Status?.State ?? ''),
    );
    if (match?.SessionId) return { sessionId: match.SessionId, state: match.Status?.State ?? 'UNKNOWN' };
    nextToken = res.NextToken;
  } while (nextToken);
  return undefined;
}

async function waitForIdle(sessionId: string, timeoutSeconds: number): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state = 'CREATING';
  while (Date.now() < deadline) {
    const res = await athena.send(new GetSessionStatusCommand({ SessionId: sessionId }));
    state = res.Status?.State ?? 'UNKNOWN';
    if (state === 'IDLE' || !LIVE_SESSION_STATES.has(state)) return state;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return state;
}

// Bounded wait budgets, well under the Lambda's own timeout (see backend.ts) —
// SubmitPySpark never blocks for the full job, only for the session to become
// ready to accept a calculation. A cold-start session can take longer than
// this; the tool returns a "pending" status instead of erroring so the agent
// retries with the same subdir and reuses the same (by-then-further-along)
// session rather than starting a duplicate.
const SESSION_WAIT_TIMEOUT_SECONDS = 90;

async function handleSubmit(event: ToolEvent): Promise<unknown> {
  const { code, subdir, description } = event;
  if (!code) throw new Error('code is required');
  if (!subdir) throw new Error('subdir is required');

  const artifactsPrefix = resolveArtifactsPrefix(subdir);

  const existing = await findExistingSession(subdir);
  let sessionId: string;
  let state: string;

  if (existing) {
    sessionId = existing.sessionId;
    state = existing.state === 'IDLE' ? 'IDLE' : await waitForIdle(existing.sessionId, SESSION_WAIT_TIMEOUT_SECONDS);
  } else {
    const started = await athena.send(new StartSessionCommand({
      WorkGroup: ATHENA_WORKGROUP,
      Description: `PySpark session for ${description ?? 'analytics agent'} ${sessionTag(subdir)}`,
      ClientRequestToken: randomUUID(),
      EngineConfiguration: {
        MaxConcurrentDpus: 20,
        SparkProperties: {
          'spark.sql.catalog.spark_catalog': 'org.apache.iceberg.spark.SparkSessionCatalog',
          'spark.sql.catalog.spark_catalog.catalog-impl': 'org.apache.iceberg.aws.glue.GlueCatalog',
          'spark.sql.catalog.spark_catalog.io-impl': 'org.apache.iceberg.aws.s3.S3FileIO',
          'spark.sql.extensions': 'org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions',
        },
      },
    }));
    if (!started.SessionId) {
      return { error: 'Failed to create Athena session: no session id returned' };
    }
    sessionId = started.SessionId;
    state = await waitForIdle(sessionId, SESSION_WAIT_TIMEOUT_SECONDS);
  }

  if (state !== 'IDLE') {
    return {
      status: 'pending',
      sessionId,
      subdir,
      sessionState: state,
      message:
        'Athena PySpark session is still starting up (common on the first job in a while — cold start can take 40-90s+). '
        + `Call SubmitPySpark again with the same subdir ("${subdir}") in ~15-30s to retry — the same session will be reused.`,
    };
  }

  const script = buildScript(code, artifactsPrefix);
  const calc = await athena.send(new StartCalculationExecutionCommand({
    SessionId: sessionId,
    CodeBlock: script,
    Description: description ?? 'PySpark execution',
    ClientRequestToken: randomUUID(),
  }));

  if (!calc.CalculationExecutionId) {
    return { error: 'Failed to start calculation execution: no calculation id returned', sessionId };
  }

  return {
    status: 'submitted',
    sessionId,
    calculationId: calc.CalculationExecutionId,
    subdir,
    artifactsPrefix,
  };
}

async function handleStatus(event: ToolEvent): Promise<unknown> {
  const { calculationId } = event;
  if (!calculationId) throw new Error('calculationId is required');

  const res = await athena.send(new GetCalculationExecutionCommand({ CalculationExecutionId: calculationId }));
  const progress = res.Statistics?.Progress;
  const pctMatch = progress?.match(/(\d+)%/);
  const dpuMillis = res.Statistics?.DpuExecutionInMillis;

  return {
    calculationId,
    state: res.Status?.State ?? 'UNKNOWN',
    stateChangeReason: res.Status?.StateChangeReason,
    progressPercent: pctMatch?.[1] ? Number(pctMatch[1]) : undefined,
    dpuExecutionSeconds: dpuMillis !== undefined && dpuMillis > 0 ? dpuMillis / 1000 : undefined,
  };
}

interface ArtifactEntry {
  name: string;
  type: 'file';
  size: number;
}

async function listArtifacts(prefix: string): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: STORAGE_BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      entries.push({ name: obj.Key.slice(prefix.length), type: 'file', size: obj.Size ?? 0 });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function handleResults(event: ToolEvent): Promise<unknown> {
  const { calculationId, subdir } = event;
  if (!calculationId) throw new Error('calculationId is required');
  if (!subdir) throw new Error('subdir is required');

  const res = await athena.send(new GetCalculationExecutionCommand({ CalculationExecutionId: calculationId }));
  const state = res.Status?.State ?? 'UNKNOWN';
  const artifactsPrefix = resolveArtifactsPrefix(subdir);

  if (!['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) {
    return {
      state,
      message: 'Execution has not finished yet — call GetPySparkStatus to poll, then GetPySparkResults again once it reaches a terminal state.',
    };
  }

  const result = res.Result;
  const [stdout, stderr, resultContent] = await Promise.all([
    result?.StdOutS3Uri ? readS3File(result.StdOutS3Uri) : Promise.resolve(''),
    result?.StdErrorS3Uri ? readS3File(result.StdErrorS3Uri) : Promise.resolve(''),
    result?.ResultS3Uri ? readS3File(result.ResultS3Uri) : Promise.resolve(''),
  ]);

  const files = await listArtifacts(artifactsPrefix);

  return {
    state,
    stateChangeReason: res.Status?.StateChangeReason,
    output: {
      stdout: truncateOutput(stdout, 'stdout'),
      stderr: truncateOutput(stderr, 'stderr'),
      result: truncateOutput(resultContent, 'result'),
    },
    artifactsPrefix,
    files,
  };
}

export const handler = async (event: ToolEvent, context: Context): Promise<unknown> => {
  const toolName = extractToolName(context);

  try {
    switch (toolName) {
      case 'GetPySparkStatus':
        return await handleStatus(event);
      case 'GetPySparkResults':
        return await handleResults(event);
      case 'SubmitPySpark':
      default:
        return await handleSubmit(event);
    }
  } catch (err) {
    // Gateway-target tools return errors as a value, not by throwing (matches
    // s3-tools/graph-traverse) so the agent sees a readable message.
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
};
