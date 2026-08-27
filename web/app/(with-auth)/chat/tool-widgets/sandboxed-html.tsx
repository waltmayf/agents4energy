import { rewriteArtifactsIframeSrc } from '@/lib/artifacts-preprocessing';

/**
 * Renders untrusted `text/html` tool-result content inside a fully sandboxed
 * iframe rather than `dangerouslySetInnerHTML`, so tool output can never
 * touch the app DOM.
 *
 * Sandbox policy (intentionally the empty token list, i.e. every restriction
 * on): no script execution, no form submission, no popups, no top-level
 * navigation, and — critically — no `allow-same-origin`. `srcDoc` already
 * gives the frame an opaque `about:srcdoc` origin; adding `allow-same-origin`
 * back would let a script (if `allow-scripts` were ever added too) read this
 * origin's cookies/localStorage. If a future widget genuinely needs JS (e.g.
 * an interactive chart), add `allow-scripts` alone — never pair it with
 * `allow-same-origin` — and note the justification here.
 *
 * Before rendering, any `<iframe src="/artifacts/<rel>">` nested inside this
 * HTML gets rewritten to `/file?s3Key=...` (issue #502). Note that a nested
 * iframe like that still inherits this frame's zero-permission sandbox flags
 * (sandboxing can't be escaped by nesting), so it can only render there if
 * the target page needs no script execution of its own — the primary,
 * fully-functional path for `/artifacts` references is a top-level iframe in
 * the assistant's own markdown (see components/ai-elements/message.tsx).
 */
export function SandboxedHtml({ html }: { html: string }) {
  return (
    <iframe
      title="Tool result"
      srcDoc={rewriteArtifactsIframeSrc(html)}
      sandbox=""
      className="h-96 w-full rounded border bg-white"
    />
  );
}
