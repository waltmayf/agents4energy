// Webhook-initiated user turns carry large boilerplate context ahead of the
// actual request — the AGENTS.md system prompt and the prior GitHub comment
// thread (see `web/amplify/functions/agent-webhook-invoke-agent/handler.ts`),
// which push the human-readable request far down the chat bubble (issue
// #119). The prompt builder wraps each section in a stable marker tag
// (`<agents_md>`, `<comment_thread>`, `<github_access>`) rather than leaving
// them as heuristically-detected boundaries, so this transform can reliably
// find and collapse them into `<details>` disclosure widgets before the
// content reaches the Markdown renderer.
//
// Plain (non-webhook) messages contain none of these markers, so every
// replace below is a no-op and the string is returned unchanged.

function toDetails(summary: string, inner: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${inner.trim()}\n\n</details>`;
}

function collapseTag(markdown: string, tag: string, summary: string | ((inner: string) => string)): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  return markdown.replace(pattern, (_full, inner: string) =>
    toDetails(typeof summary === 'function' ? summary(inner) : summary, inner));
}

const COMMENT_COUNT_RE = /Comment thread \((\d+\+?)\):/;

/**
 * Collapse the AGENTS.md, prior-GitHub-comment-thread, and GitHub-access
 * boilerplate blocks in a webhook-initiated user message into
 * collapsed-by-default `<details>` widgets, leaving the actual request text
 * (and the issue/PR title/state/labels/description in `<github_context>`)
 * visible without expanding anything.
 */
export function collapseWebhookSections(markdown: string): string {
  if (
    !markdown.includes('<agents_md>') &&
    !markdown.includes('<comment_thread>') &&
    !markdown.includes('<github_access>') &&
    !markdown.includes('<github_context>')
  ) {
    return markdown;
  }

  let result = markdown;

  // Sub-collapse the comment thread nested inside <github_context>, showing
  // the comment count in the toggle, before unwrapping github_context itself.
  result = collapseTag(result, 'comment_thread', (inner) => {
    const count = inner.match(COMMENT_COUNT_RE)?.[1];
    return count ? `Prior GitHub comments (${count}) ▸` : 'Prior GitHub comments ▸';
  });

  result = collapseTag(result, 'agents_md', 'AGENTS.md instructions ▸');
  result = collapseTag(result, 'github_access', 'GitHub access & delivery instructions ▸');

  // <github_context> itself stays visible (issue/PR title, state, labels,
  // and description are useful at a glance) — just unwrap the marker tags so
  // they don't render as literal text.
  result = result.replace(/<github_context>\n?/g, '').replace(/\n?<\/github_context>/g, '');

  return result;
}
