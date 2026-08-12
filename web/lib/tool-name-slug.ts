// Slugify an McpServer display name into a valid `remote_mcp` tool name.
//
// InvokeHarness rejects any tool `name` that doesn't match `[a-zA-Z0-9_-]+`
// (#366), and McpServer display names routinely contain spaces (e.g.
// "Knowledge Graph Tools", "S3 Filesystem Tools"). The tool `name` is only the
// AI SDK label for the remote_mcp tool group — gateway routing is by URL + JWT
// and the downstream tools keep their own `<target>___<tool>` names — so
// collapsing runs of disallowed characters to `-` is safe.
//
// Kept in its own dependency-free module so it can be unit-tested with
// `node --test` (harness-agent.ts pulls in aws-amplify + amplify_outputs.json,
// which a bare test runner can't import).

/** Collapse disallowed characters to `-`; fall back to `mcp-server` if empty. */
export function slugifyToolName(name: string): string {
  const slug = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'mcp-server';
}
