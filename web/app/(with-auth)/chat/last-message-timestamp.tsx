'use client';
import type { AbstractAgent } from '@ag-ui/client';
import { useLastMessageTimestamp } from './use-last-message-timestamp';

/**
 * Always-visible timestamp of the transcript's most recent message (issue
 * #451) — separate from any per-bubble timestamp, so it keeps showing even
 * while messages are only arriving via the AgentCore memory poll (a webhook
 * run or another tab), when there's otherwise no obvious sign of activity.
 * Renders nothing before the first message exists.
 */
export function LastMessageTimestamp({ agent }: { agent: AbstractAgent }) {
  const at = useLastMessageTimestamp(agent);
  if (!at) return null;

  return (
    <div className="flex items-center justify-end border-b px-3 py-1">
      <span className="text-xs text-muted-foreground" title={at.toLocaleString()}>
        Last message {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      </span>
    </div>
  );
}
