'use client';
import { useCallback, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import { useCopilotKit } from '@copilotkit/react-core/v2';
import { useMcpElicitation } from './use-mcp-elicitation';
import { openAuthPopup } from '@/lib/mcp-auth';
import { fetchCallerIdentity } from '@/lib/harness-agent';
import { waitForAgentCoreConsent, completeResourceTokenAuth } from '@/lib/mcp-elicitation-auth';
import { Button } from '@/components/ui/button';
import { LockIcon, Loader2Icon } from 'lucide-react';

type Status = 'idle' | 'authenticating' | 'retrying' | 'error';

/**
 * "Authenticate to continue" affordance for epic #412 (slices 4 + 5, #416 +
 * #417): when the gateway elicits 3LO consent for a tool call, this opens the
 * consent URL in a popup (reusing mcp-auth.ts's popup sizing), waits for
 * AgentCore's hosted flow to redirect back to /oauth/agentcore-callback,
 * completes URL session binding (completeResourceTokenAuth), then re-drives
 * the original turn — `copilotkit.runAgent({ agent })` resends the agent's
 * unchanged message list into a fresh run, exactly like AwaitingInputBanner's
 * retry, so the tool call is retried without the user re-typing anything.
 */
export function McpElicitationBanner({ agent }: { agent: AbstractAgent }) {
  const elicitation = useMcpElicitation(agent);
  const { copilotkit } = useCopilotKit();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleAuthenticate = useCallback(async () => {
    if (!elicitation) return;
    setError(null);
    if (!elicitation.sessionUri) {
      setStatus('error');
      setError('Could not determine the authentication session for this request — retry the tool call to get a fresh link.');
      return;
    }

    setStatus('authenticating');
    try {
      const popup = openAuthPopup(elicitation.url);
      await waitForAgentCoreConsent(popup);

      const { accessToken } = await fetchCallerIdentity();
      if (!accessToken) throw new Error('You appear to be signed out — sign in again and retry.');
      await completeResourceTokenAuth(elicitation.sessionUri, accessToken);

      setStatus('retrying');
      await copilotkit.runAgent({ agent });
      setStatus('idle');
    } catch (err) {
      console.error('[McpElicitationBanner] authentication failed', err);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    }
  }, [agent, copilotkit, elicitation]);

  if (!elicitation) return null;

  const busy = status === 'authenticating' || status === 'retrying';

  return (
    <div className="flex items-center gap-2 border-b bg-sky-50 px-3 py-2.5 text-sm dark:bg-sky-950/30">
      <LockIcon className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <div className="min-w-0 flex-1 text-sky-900 dark:text-sky-200">
        {error ?? elicitation.message ?? 'Authentication is required to use this tool.'}
      </div>
      <Button size="sm" onClick={handleAuthenticate} disabled={busy}>
        {busy && <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />}
        {status === 'authenticating' ? 'Authenticating…' : status === 'retrying' ? 'Retrying…' : 'Authenticate'}
      </Button>
    </div>
  );
}
