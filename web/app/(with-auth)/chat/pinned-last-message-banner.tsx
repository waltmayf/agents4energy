'use client';
import type { AbstractAgent } from '@ag-ui/client';
import { useLastUserMessage } from './use-last-user-message';

const BLURB_MAX_LENGTH = 160;

/**
 * Collapses a user turn's raw text into a single-line blurb: strips Markdown
 * emphasis/code/link syntax and webhook context markers (see
 * `collapseWebhookSections` for the full-message equivalent), flattens
 * whitespace, and truncates. Webhook-initiated sessions send a large
 * Markdown prompt as the first user turn, so without this the pinned blurb
 * would show raw `#`/`` ``` ``/HTML-comment noise instead of readable text.
 */
function toBlurb(text: string): string {
  const flattened = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= BLURB_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, BLURB_MAX_LENGTH).trimEnd()}…`;
}

/**
 * Pins a short blurb of the operator's last-sent user message above the
 * scrollable message list (issue #457). Rendered as a sibling of
 * `<CopilotChat>` rather than inside it, so it stays put — a fixed anchor
 * reminding the operator which prompt the messages below are responding to
 * while they scroll back up through earlier turns.
 */
export function PinnedLastMessageBanner({ agent }: { agent: AbstractAgent }) {
  const lastUserMessage = useLastUserMessage(agent);
  if (!lastUserMessage) return null;

  return (
    <div className="border-b bg-muted/50 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">Last message: </span>
      <span className="text-foreground/90">{toBlurb(lastUserMessage.text)}</span>
    </div>
  );
}
