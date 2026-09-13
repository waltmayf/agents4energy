'use client';
import { useEffect } from 'react';
import type { AbstractAgent, Message } from '@ag-ui/client';
import { messageText } from '@/lib/harness-agent';
import { parseGithubIssueContext } from '@/lib/github-issue-context';

export const BASE_TITLE = 'Agents For Energy';

function computeTitle(messages: readonly Message[]): string {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (!firstUserMessage) return BASE_TITLE;

  const context = parseGithubIssueContext(messageText(firstUserMessage));
  if (!context) return BASE_TITLE;

  const label = context.kind === 'pull_request' ? 'PR' : 'Issue';
  return `${label} #${context.number}: ${context.title} · ${BASE_TITLE}`;
}

/**
 * Sets the browser tab title from the session's `<github_context>` block
 * (issue #454) so a tab holding an `@agentcore`/`@agentcore-claude`
 * GitHub-driven conversation is identifiable at a glance — useful once more
 * than one such session is open at once. Re-derives on every
 * `onMessagesChanged` notification (history load, poll, or a new turn) so it
 * stays correct if the active agent is swapped mid-session. Falls back to the
 * app's default title for ordinary chats, and restores it on unmount.
 */
export function usePageTitle(agent: AbstractAgent): void {
  useEffect(() => {
    document.title = computeTitle(agent.messages);
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        document.title = computeTitle(messages);
      },
    });
    return () => {
      unsubscribe();
      document.title = BASE_TITLE;
    };
  }, [agent]);
}
