import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const logs = new CloudWatchLogsClient({ region: REGION });

// Console rison string codec used throughout the CloudWatch Logs console URL
// fragment: unreserved chars pass through, everything else becomes
// '*' + 2 lowercase hex digits. Ported from the Python `enc()` in
// .github/workflows/claude.yml's "Post CloudWatch log links" step so both
// call sites produce byte-identical URLs.
function enc(value: string): string {
  return Array.from(value)
    .map((c) => (/[A-Za-z0-9\-._]/.test(c) ? c : `*${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .join('');
}

// One dedicated log group per repo/project (mirrors the OTLP scheme in
// claude.yml: /github-actions/claude-code-otlp/<repo-slug>) and one stream
// per webhook-triggered run, created by the receiver Lambda *before*
// StartExecution so the Live Tail link in the very first posted comment is
// already valid — no need to discover a runtime-assigned stream name after
// the fact.
export function logGroupName(sourceSlug: string): string {
  return `/agent-webhook/${sourceSlug}`;
}

export function logStreamName(runId: string): string {
  return runId;
}

export async function ensureLogStream(groupName: string, streamName: string): Promise<void> {
  try {
    await logs.send(new CreateLogGroupCommand({ logGroupName: groupName }));
  } catch (err) {
    if (!(err instanceof ResourceAlreadyExistsException)) throw err;
  }
  try {
    await logs.send(new CreateLogStreamCommand({ logGroupName: groupName, logStreamName: streamName }));
  } catch (err) {
    if (!(err instanceof ResourceAlreadyExistsException)) throw err;
  }
}

export async function appendLog(groupName: string, streamName: string, message: string): Promise<void> {
  await logs.send(new PutLogEventsCommand({
    logGroupName: groupName,
    logStreamName: streamName,
    logEvents: [{ timestamp: Date.now(), message }],
  }));
}

// Builds the same "Live Tail" console deep-link as claude.yml's OTLP step,
// scoped to a single log stream so only this run's events show.
export function buildLiveTailUrl(region: string, accountId: string, groupName: string, streamName: string): string {
  const base = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#`;
  const arn = `arn:aws:logs:${region}:${accountId}:log-group:${groupName}:*`;
  return `${base}logsV2:live-tail?logGroupArns=~(~'${enc(arn)})~logStreamNames~(~'${enc(streamName)})`;
}
