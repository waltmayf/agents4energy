// Path resolution for the agent filesystem tools (issue #240).
//
// One root prefix, `files/`, that every path branches from — no per-prefix
// special-casing and no per-session isolation (all sessions share this space).
//
// Absolute paths (leading "/") resolve from the filesystem root, e.g.
// "/docs/production/gas_lift.md" -> key "files/docs/production/gas_lift.md".
// Relative paths (no leading "/") resolve from the same root, e.g.
// "reports/q3.md" -> key "files/reports/q3.md".

export class S3FsPathError extends Error {}

const ROOT_PREFIX = 'files';

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

/** Resolve a path to a concrete S3 object key under `files/`. Throws on empty/traversal paths. */
export function resolveS3Path(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new S3FsPathError('path is required');
  }
  const segments = normalizeSegments(rawPath);
  if (segments.length === 0) {
    throw new S3FsPathError(`Path resolves to empty: "${rawPath}"`);
  }
  return [ROOT_PREFIX, ...segments].join('/');
}

/**
 * Resolve a path to an S3 "directory" prefix, for ListFiles. Unlike
 * resolveS3Path, an empty/omitted path is valid and means "the filesystem
 * root" rather than an error.
 */
export function resolveS3Prefix(rawPath: string | undefined | null): string {
  if (!rawPath || !rawPath.trim()) {
    return `${ROOT_PREFIX}/`;
  }
  const segments = normalizeSegments(rawPath);
  return segments.length ? `${ROOT_PREFIX}/${segments.join('/')}/` : `${ROOT_PREFIX}/`;
}

/**
 * Validate a full S3 object key (already including the `files/` root, e.g.
 * as passed via the `/file?s3Key=...` query param — see
 * web/app/(with-auth)/file/page.tsx) so that page can't be used to presign
 * arbitrary bucket keys. Rejects anything outside the `files/` prefix and any
 * traversal within it; returns the key unchanged when valid.
 */
export function resolveFileRouteKey(rawKey: string): string {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith(`${ROOT_PREFIX}/`)) {
    throw new S3FsPathError(`s3Key must be under the "${ROOT_PREFIX}/" prefix: "${rawKey}"`);
  }
  // Re-resolve the part after the root prefix through the same traversal-safe
  // logic as resolveS3Path, then require it to land back on the exact key the
  // caller supplied (catches any residual "..", "//", etc.).
  const resolved = resolveS3Path(rawKey.slice(ROOT_PREFIX.length + 1));
  if (resolved !== rawKey) {
    throw new S3FsPathError(`Invalid s3Key: "${rawKey}"`);
  }
  return resolved;
}
