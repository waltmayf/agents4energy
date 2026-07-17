'use client';
import { MessageResponse } from '@/components/ai-elements/message';
import { cn } from '@/lib/utils';

/**
 * Markdown renderer for user message bubbles.
 *
 * CopilotKit's default user `MessageRenderer` dumps the raw string into a
 * `whitespace-pre-wrap` div, so a structured prompt renders as an unreadable
 * wall of text. This is very visible for webhook-initiated sessions, whose
 * first user turn is a large Markdown prompt (AGENTS.md system prompt +
 * `<github_context>`/`<github_access>` blocks — see
 * `web/amplify/functions/agent-webhook-invoke-agent/handler.ts`).
 *
 * We render the content through the same Streamdown-backed `MessageResponse`
 * the assistant bubbles use, so headings, fenced code, lists, and inline code
 * display properly. Wired into `<CopilotChat>` via the
 * `messageView.userMessage.messageRenderer` slot (see chat/page.tsx).
 *
 * The wrapper keeps the bubble chrome from CopilotKit's default renderer
 * (`bg-muted`, rounded, padded) but drops `whitespace-pre-wrap` — Markdown
 * produces block elements — and adds `min-w-0 overflow-hidden` so long code
 * fences scroll within the bubble instead of overflowing it.
 */
export function UserMessageMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'prose dark:prose-invert bg-muted relative inline-block min-w-0 max-w-[80%] overflow-hidden rounded-[18px] px-4 py-3 text-sm',
        className,
      )}
    >
      <MessageResponse>{content}</MessageResponse>
    </div>
  );
}
