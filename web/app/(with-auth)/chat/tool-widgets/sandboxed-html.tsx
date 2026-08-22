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
 */
export function SandboxedHtml({ html }: { html: string }) {
  return (
    <iframe
      title="Tool result"
      srcDoc={html}
      sandbox=""
      className="h-96 w-full rounded border bg-white"
    />
  );
}
