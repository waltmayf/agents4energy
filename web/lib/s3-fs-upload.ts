// Shared file-upload primitives for the agent filesystem (issue #499, part of
// the HPC/Analytics epic — see docs/hpc-analytics-agents-epic.md).
//
// Sibling of s3-fs-path.ts / s3-fs-diff.ts. Built on s3-fs-path.ts's
// normalization + "../"-traversal guard so every write into `files/` — from
// the s3-tools UploadFile tool or (later) the Athena PySpark tool's
// in-session auto-upload — goes through the same path resolution.

import { PutObjectCommand, CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { resolveS3Path, resolveS3Prefix } from './s3-fs-path.ts';

export const ARTIFACTS_SUBPREFIX = 'artifacts';

/**
 * Resolve the S3 "directory" prefix artifacts for a given subdir land under,
 * e.g. resolveArtifactsPrefix('session-123') -> 'files/artifacts/session-123/'.
 * Omit subdir for the shared artifacts root, 'files/artifacts/'.
 */
export function resolveArtifactsPrefix(subdir?: string | null): string {
  const rawPath = subdir && subdir.trim() ? `${ARTIFACTS_SUBPREFIX}/${subdir}` : ARTIFACTS_SUBPREFIX;
  return resolveS3Prefix(rawPath);
}

// Ported from reference/genai-demos/cdk/lib/tools/python/sessionSetup.py's
// content-type map.
export function sniffContentType(key: string): string | undefined {
  if (key.endsWith('.html')) return 'text/html';
  if (key.endsWith('.csv')) return 'text/csv';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.txt')) return 'text/plain';
  if (key.endsWith('.png')) return 'image/png';
  return undefined;
}

export interface UploadObjectBytesParams {
  s3: S3Client;
  bucket: string;
  /** Destination path, resolved under the shared files/ root. */
  destPath: string;
  content: string;
  /** How `content` is encoded. Defaults to 'utf-8'. */
  encoding?: 'utf-8' | 'base64';
}

export interface UploadObjectBytesResult {
  key: string;
  bytesWritten: number;
}

/** Upload inline content to a destination key under files/, via PutObject. */
export async function uploadObjectBytes(params: UploadObjectBytesParams): Promise<UploadObjectBytesResult> {
  const key = resolveS3Path(params.destPath);
  const body = Buffer.from(params.content, params.encoding === 'base64' ? 'base64' : 'utf-8');

  await params.s3.send(new PutObjectCommand({
    Bucket: params.bucket,
    Key: key,
    Body: body,
    ContentType: sniffContentType(key),
  }));

  return { key, bytesWritten: body.length };
}

export interface CopyObjectWithinFsParams {
  s3: S3Client;
  bucket: string;
  /** Existing source path under files/. */
  sourcePath: string;
  /** Destination path, resolved under the shared files/ root. */
  destPath: string;
}

export interface CopyObjectWithinFsResult {
  key: string;
}

/** Server-side copy of an existing files/ object to another files/ key, via CopyObject. */
export async function copyObjectWithinFs(params: CopyObjectWithinFsParams): Promise<CopyObjectWithinFsResult> {
  const sourceKey = resolveS3Path(params.sourcePath);
  const destKey = resolveS3Path(params.destPath);

  // CopySource is "bucket/key" with the key URL-encoded per-segment (encoding
  // the whole string with encodeURIComponent would also escape "/").
  const encodedSourceKey = sourceKey.split('/').map(encodeURIComponent).join('/');

  await params.s3.send(new CopyObjectCommand({
    Bucket: params.bucket,
    CopySource: `${params.bucket}/${encodedSourceKey}`,
    Key: destKey,
  }));

  return { key: destKey };
}
