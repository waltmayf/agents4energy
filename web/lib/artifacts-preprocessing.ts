// Rewrites `/artifacts/<rel>` references emitted by agent tools (e.g. the
// PySpark analytics pack, issue #501) into `/file?s3Key=...` links the
// frontend `/file` route (web/app/(with-auth)/file/page.tsx) can resolve to a
// presigned S3 URL. Ported from
// reference/genai-demos/src/lib/htmlPreprocessing.ts (~L479-488) — this repo
// has no per-session artifact prefix, so unlike the original there's no chat
// session id to inject; every artifact lives under the single shared
// `files/artifacts/` root (see web/lib/s3-fs-path.ts).

const ARTIFACTS_PREFIX = '/artifacts/';
const ARTIFACTS_ROOT_KEY = 'files/artifacts/';

/** `subdir/plots/foo.png` -> `files/artifacts/subdir/plots/foo.png` */
function artifactRelPathToS3Key(relPath: string): string {
  return `${ARTIFACTS_ROOT_KEY}${relPath}`;
}

/** `files/artifacts/subdir/plots/foo.png` -> `/file?s3Key=files%2Fartifacts%2F...` */
function toFileRouteHref(s3Key: string): string {
  return `/file?s3Key=${encodeURIComponent(s3Key)}`;
}

/**
 * If `href` is an `/artifacts/<rel>` reference, returns the rewritten
 * `/file?s3Key=...` href. Returns null for anything else (absolute URLs,
 * other app routes, etc.) so callers can leave those untouched.
 */
export function rewriteArtifactHref(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith(ARTIFACTS_PREFIX)) {
    return null;
  }
  const relPath = href.slice(ARTIFACTS_PREFIX.length);
  if (!relPath) {
    return null;
  }
  return toFileRouteHref(artifactRelPathToS3Key(relPath));
}

// Matches `<iframe ... src="/artifacts/<rel>" ...>` (single or double quoted).
const ARTIFACTS_IFRAME_SRC_RE = /(<iframe\b[^>]*?\ssrc\s*=\s*)(["'])\/artifacts\/([^"'>]+)\2/gi;

/**
 * Rewrites every `<iframe src="/artifacts/<rel>">` in an HTML string to point
 * at the `/file` route instead. Used when a tool result embeds an artifact
 * reference inside a larger HTML blob (see SandboxedHtml). No-op if `html`
 * doesn't contain any `/artifacts/` iframe.
 */
export function rewriteArtifactsIframeSrc(html: string): string {
  if (typeof html !== 'string' || !html.includes(ARTIFACTS_PREFIX)) {
    return html;
  }
  return html.replace(
    ARTIFACTS_IFRAME_SRC_RE,
    (_match, prefix: string, quote: string, relPath: string) =>
      `${prefix}${quote}${toFileRouteHref(artifactRelPathToS3Key(relPath))}${quote}`,
  );
}
