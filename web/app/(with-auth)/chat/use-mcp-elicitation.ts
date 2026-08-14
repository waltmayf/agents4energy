'use client';
import { useEffect, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import { MCP_ELICITATION_EVENT_NAME, type McpElicitation } from '@/lib/mcp-elicitation';

/**
 * Surfaces the AG-UI CUSTOM event that harness-stream-to-agui.ts /
 * harness-agent.ts emit when the gateway returns an MCP -32042 elicitation
 * (epic #412 slice 4): a 3LO-protected tool call needs the user's consent
 * before it can run. Cleared whenever a new run starts, so a stale prompt
 * doesn't linger once the user retries.
 */
export function useMcpElicitation(agent: AbstractAgent): McpElicitation | null {
  // Keyed by `agent` identity so switching agents re-initializes cleanly,
  // mirroring useAwaitingInput's pattern for the same reason.
  const [{ forAgent, elicitation }, setSnapshot] = useState<{
    forAgent: AbstractAgent;
    elicitation: McpElicitation | null;
  }>({ forAgent: agent, elicitation: null });

  useEffect(() => {
    setSnapshot({ forAgent: agent, elicitation: null });
    const { unsubscribe } = agent.subscribe({
      onRunInitialized: () => setSnapshot({ forAgent: agent, elicitation: null }),
      onCustomEvent: ({ event }) => {
        if (event.name === MCP_ELICITATION_EVENT_NAME) {
          setSnapshot({ forAgent: agent, elicitation: event.value as McpElicitation });
        }
      },
    });
    return unsubscribe;
  }, [agent]);

  return forAgent === agent ? elicitation : null;
}
