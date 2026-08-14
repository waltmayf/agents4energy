// Completes the AgentCore OAuth return-URL round-trip for epic #412 slice 5
// (#417): after mcp-elicitation-banner.tsx opens the consent popup (slice 4)
// and the user finishes AgentCore's hosted 3LO flow, the popup redirects to
// web/app/oauth/agentcore-callback, which postMessages back here. This module
// waits for that signal, then calls the completeResourceTokenAuth mutation
// (URL session binding) so AgentCore vaults the token for this user.
//
// Distinct from mcp-auth.ts's waitForCode/exchangeCode, which handle the
// unrelated direct-to-IdP browser-PKCE flow for NO_AUTH-discovered servers.

import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

const client = generateClient<Schema>({ authMode: 'userPool' });

export const AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE = 'agentcore-oauth-callback';

export interface AgentCoreOauthCallbackMessage {
  type: typeof AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE;
  success: boolean;
  error?: string;
}

/**
 * Wait for the AgentCore consent popup to redirect back to
 * /oauth/agentcore-callback and report whether the hosted consent flow
 * succeeded. Mirrors mcp-auth.ts's waitForCode: rejects if the user closes
 * the popup manually, or after `timeoutMs` with no response.
 */
export function waitForAgentCoreConsent(popup: Window, timeoutMs = 5 * 60 * 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for authentication to complete.'));
    }, timeoutMs);

    const pollPopupClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error('Authentication cancelled — the popup was closed.'));
      }
    }, 500);

    function onMessage(evt: MessageEvent) {
      if (evt.origin !== window.location.origin) return;
      const msg = evt.data as AgentCoreOauthCallbackMessage;
      if (msg?.type !== AGENTCORE_OAUTH_CALLBACK_MESSAGE_TYPE) return;
      cleanup();
      popup.close();
      if (msg.success) resolve();
      else reject(new Error(msg.error ?? 'Authentication failed.'));
    }

    function cleanup() {
      clearTimeout(timer);
      clearInterval(pollPopupClosed);
      window.removeEventListener('message', onMessage);
    }

    window.addEventListener('message', onMessage);
  });
}

/**
 * Complete URL session binding for `sessionUri` (from the original
 * elicitation — see mcp-elicitation.ts) now that the user has finished the
 * hosted consent flow. `callerAccessToken` must be the SAME Cognito access
 * token forwarded to the gateway for the original elicited tool call (see
 * harness-agent.ts's fetchCallerIdentity) — the mutation cross-checks its
 * `sub` against the caller's verified identity server-side.
 */
export async function completeResourceTokenAuth(
  sessionUri: string,
  callerAccessToken: string,
): Promise<void> {
  const result = await client.mutations.completeResourceTokenAuth({
    sessionUri,
    userToken: callerAccessToken,
  });
  if (result.errors?.length) {
    throw new Error(result.errors[0]?.message ?? 'Failed to complete authentication.');
  }
  if (!result.data?.success) {
    throw new Error(result.data?.error ?? 'Failed to complete authentication.');
  }
}
