import type { Context } from 'aws-lambda';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  NotFound,
} from '@aws-sdk/client-s3';
import { resolveS3Path, resolveS3Prefix, S3FsPathError } from '../../../lib/s3-fs-path';
import { applyDiff, DiffFormatError, DiffApplyError } from '../../../lib/s3-fs-diff';

const BUCKET_NAME = process.env.BUCKET_NAME!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Cap ReadFile at 1 MiB: large enough for any doc/report the agent would
// reasonably read/write by hand, small enough to keep tool results within the
// harness's context budget.
const MAX_READ_BYTES = 1024 * 1024;

const s3 = new S3Client({ region: REGION });

// The gateway invokes this Lambda directly (no MCP JSON-RPC envelope) — the
// event IS the tool's input arguments. Which of the 4 tools was called
// arrives out-of-band on context.clientContext.custom.bedrockAgentCoreToolName
// (form "<gatewayTargetName>___<ToolName>"), since one Lambda backs all 4 tools.
interface GatewayClientContext {
  custom?: {
    bedrockAgentCoreToolName?: string;
  };
}

interface ToolEvent {
  path?: string;
  diff?: string;
  recursive?: boolean;
  [key: string]: unknown;
}

function extractToolName(context: Context): string {
  const raw = (context.clientContext as GatewayClientContext | undefined)?.custom?.bedrockAgentCoreToolName;
  if (!raw) throw new Error('Missing bedrockAgentCoreToolName in Lambda client context');
  // Gateway-target tool names are "<targetName>___<ToolName>".
  const idx = raw.lastIndexOf('___');
  return idx === -1 ? raw : raw.slice(idx + 3);
}

async function getObjectText(key: string): Promise<string | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return await res.Body!.transformToString('utf-8');
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NoSuchKey') return undefined;
    throw err;
  }
}

async function handleApplyDiff(event: ToolEvent): Promise<unknown> {
  const { path, diff } = event;
  if (!path) throw new Error('path is required');
  if (diff === undefined || diff === null) throw new Error('diff is required');

  const key = resolveS3Path(path);

  const original = await getObjectText(key);
  const { content, created } = applyDiff(original, diff);

  await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: content }));

  return { path, created, bytesWritten: Buffer.byteLength(content, 'utf-8') };
}

async function handleReadFile(event: ToolEvent): Promise<unknown> {
  const { path } = event;
  if (!path) throw new Error('path is required');

  const key = resolveS3Path(path);

  let head;
  try {
    head = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NoSuchKey') {
      throw new Error(`File not found: "${path}"`);
    }
    throw err;
  }

  if ((head.ContentLength ?? 0) > MAX_READ_BYTES) {
    throw new Error(
      `File "${path}" is ${head.ContentLength} bytes, exceeding the ${MAX_READ_BYTES}-byte read limit`,
    );
  }

  const content = await head.Body!.transformToString('utf-8');
  return { path, content };
}

async function handleDeleteFile(event: ToolEvent): Promise<unknown> {
  const { path } = event;
  if (!path) throw new Error('path is required');

  const key = resolveS3Path(path);

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  return { path, deleted: true };
}

interface FileEntry {
  name: string;
  type: 'file';
  size: number;
}
interface DirEntry {
  name: string;
  type: 'directory';
}

async function handleListFiles(event: ToolEvent): Promise<unknown> {
  const { path, recursive } = event;
  const prefix = resolveS3Prefix(path);

  const entries: Array<FileEntry | DirEntry> = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      Delimiter: recursive ? undefined : '/',
      ContinuationToken: continuationToken,
    }));

    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue; // skip the "directory marker" itself
      entries.push({ name: obj.Key.slice(prefix.length), type: 'file', size: obj.Size ?? 0 });
    }
    for (const common of res.CommonPrefixes ?? []) {
      if (!common.Prefix) continue;
      entries.push({ name: common.Prefix.slice(prefix.length), type: 'directory' });
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return { path: path ?? '/', entries };
}

export const handler = async (event: ToolEvent, context: Context): Promise<unknown> => {
  const toolName = extractToolName(context);

  try {
    switch (toolName) {
      case 'ApplyDiff':
        return await handleApplyDiff(event);
      case 'ListFiles':
        return await handleListFiles(event);
      case 'ReadFile':
        return await handleReadFile(event);
      case 'DeleteFile':
        return await handleDeleteFile(event);
      default:
        throw new Error(`Unknown tool: "${toolName}"`);
    }
  } catch (err) {
    if (
      err instanceof S3FsPathError
      || err instanceof DiffFormatError
      || err instanceof DiffApplyError
      || err instanceof Error
    ) {
      return { error: err.message };
    }
    throw err;
  }
};
