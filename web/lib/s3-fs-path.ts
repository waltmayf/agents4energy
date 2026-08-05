// Path resolution for the agent filesystem tools (issue #240).
//
// Two areas in one bucket:
//   docs/                    — shared, read-only documentation (absolute paths only)
//   workspace/id=<sessionId>/ — per-session read+write scratch space
//
// Absolute paths (leading "/") resolve from the bucket root, e.g.
// "/docs/production/gas_lift.md" -> key "docs/production/gas_lift.md".
// Relative paths (no leading "/") resolve against the session's workspace
// prefix, e.g. "reports/q3.md" -> "workspace/id=<sessionId>/reports/q3.md".

export class S3FsPathError extends Error {}

function normalizeSegments(rawPath: string): string[] {
  const parts = rawPath.split('/').filter((p) => p.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new S3FsPathError(`Path escapes its root: "${rawPath}"`);
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

export interface ResolvedPath {
  /** The full S3 object key. */
  key: string;
  /** Whether this key falls under the read-only docs/ prefix. */
  isDocs: boolean;
}

/** Resolve a path to a concrete S3 object key. Throws on empty/traversal paths. */
export function resolveS3Path(rawPath: string, sessionId: string): ResolvedPath {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new S3FsPathError('path is required');
  }
  const isAbsolute = rawPath.startsWith('/');
  const segments = normalizeSegments(rawPath);
  if (segments.length === 0) {
    throw new S3FsPathError(`Path resolves to empty: "${rawPath}"`);
  }
  if (isAbsolute) {
    return { key: segments.join('/'), isDocs: segments[0] === 'docs' };
  }
  if (!sessionId) {
    throw new S3FsPathError('sessionId is required to resolve a relative path');
  }
  return { key: `workspace/id=${sessionId}/${segments.join('/')}`, isDocs: false };
}

export interface ResolvedPrefix {
  /** The S3 prefix to list under (always ends with "/", or is "" for the bucket root). */
  prefix: string;
  /** Whether this prefix falls under the read-only docs/ prefix. */
  isDocs: boolean;
}

/**
 * Resolve a path to an S3 "directory" prefix, for ListFiles. Unlike
 * resolveS3Path, an empty/omitted path is valid and means "the CWD" (the
 * session's workspace root) rather than an error.
 */
export function resolveS3Prefix(rawPath: string | undefined | null, sessionId: string): ResolvedPrefix {
  if (!rawPath || !rawPath.trim()) {
    if (!sessionId) throw new S3FsPathError('sessionId is required to resolve the default (CWD) prefix');
    return { prefix: `workspace/id=${sessionId}/`, isDocs: false };
  }
  const isAbsolute = rawPath.startsWith('/');
  const segments = normalizeSegments(rawPath);
  if (isAbsolute) {
    const prefix = segments.length ? `${segments.join('/')}/` : '';
    return { prefix, isDocs: segments[0] === 'docs' };
  }
  if (!sessionId) {
    throw new S3FsPathError('sessionId is required to resolve a relative path');
  }
  const base = `workspace/id=${sessionId}/${segments.join('/')}`;
  return { prefix: segments.length ? `${base}/` : `workspace/id=${sessionId}/`, isDocs: false };
}
