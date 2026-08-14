'use client';
import type { AbstractAgent } from '@ag-ui/client';
import { useMcpElicitation } from './use-mcp-elicitation';
import { openAuthPopup } from '@/lib/mcp-auth';
import { Button } from '@/components/ui/button';
import { LockIcon } from 'lucide-react';

/**
 * "Authenticate to continue" affordance for epic #412 slice 4/8: when the
 * gateway elicits 3LO consent for a tool call, this opens the consent URL in a
 * popup (reusing mcp-auth.ts's popup sizing). Completing the round-trip
 * (CompleteResourceTokenAuth + retrying the original tool call) is slice 5
 * (#417) — this only gets the user to the sign-in page instead of leaving them
 * looking at a stalled/failed run.
 */
export function McpElicitationBanner({ agent }: { agent: AbstractAgent }) {
  const elicitation = useMcpElicitation(agent);
  if (!elicitation) return null;

  return (
    <div className="flex items-center gap-2 border-b bg-sky-50 px-3 py-2.5 text-sm dark:bg-sky-950/30">
      <LockIcon className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <div className="min-w-0 flex-1 text-sky-900 dark:text-sky-200">
        {elicitation.message ?? 'Authentication is required to use this tool.'}
      </div>
      <Button
        size="sm"
        onClick={() => {
          try {
            openAuthPopup(elicitation.url);
          } catch (err) {
            console.error('[McpElicitationBanner] failed to open consent popup', err);
          }
        }}
      >
        Authenticate
      </Button>
    </div>
  );
}
