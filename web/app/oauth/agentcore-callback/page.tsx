'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE,
  type AgentCoreOauthCallbackMessage,
} from '@/lib/mcp-elicitation-auth';

/**
 * Return-URL landing page for AgentCore Identity's hosted 3LO consent flow
 * (epic #412 slice 5, #417) — distinct from /oauth/callback, which handles the
 * unrelated direct-to-IdP browser-PKCE flow (mcp-auth.ts) for NO_AUTH
 * -discovered MCP servers. Point each McpServer row's `oauthReturnUrl` at
 * `${origin}/oauth/agentcore-callback` to land here.
 *
 * AgentCore's own hosted UI performs the token exchange with the external IdP
 * before redirecting here — this page's only job is telling the opener the
 * flow finished. The opener still needs to call completeResourceTokenAuth
 * (URL session binding) using the ORIGINAL elicitation's `sessionUri`, which
 * it already holds from mcp-elicitation.ts — there's nothing to re-derive
 * from this URL for that. We only look for a standard OAuth-style
 * `error`/`error_description` pair to surface a hosted-flow failure.
 */
function AgentCoreOauthCallbackInner() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (window.opener) {
      const message: AgentCoreOauthCallbackMessage = error
        ? { type: AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE, success: false, error: errorDescription ?? error }
        : { type: AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE, success: true };
      window.opener.postMessage(message, window.location.origin);
    }

    setTimeout(() => window.close(), 200);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export default function AgentCoreOauthCallbackPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">Completing authentication…</p>
      <Suspense>
        <AgentCoreOauthCallbackInner />
      </Suspense>
    </div>
  );
}
