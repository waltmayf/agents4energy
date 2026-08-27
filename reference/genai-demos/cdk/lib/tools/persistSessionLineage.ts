import { getConfiguredAmplifyClient } from './amplifyUtils';
import { sessionLineageTracker } from './sessionLineageTracker';

/**
 * GraphQL mutation to update the ChatSession's lineageSummary field.
 */
const updateChatSessionLineage = /* GraphQL */ `
  mutation UpdateChatSession($input: UpdateChatSessionInput!) {
    updateChatSession(input: $input) {
      id
      lineageSummary
    }
  }
`;

/**
 * Persist the accumulated lineage summary for a chat session to DynamoDB
 * via GraphQL mutation, then clear the tracker state.
 *
 * This is fire-and-forget — errors are logged but never thrown,
 * so it never interrupts the primary request flow.
 */
export async function persistSessionLineageSummary(sessionId: string): Promise<void> {
  try {
    const summary = sessionLineageTracker.getSummary(sessionId);

    // Nothing to persist if no datasets were tracked
    if (summary.length === 0) {
      return;
    }

    console.log(`[lineage] Persisting lineage summary for session ${sessionId}: ${summary.length} datasets`);

    const amplifyClient = getConfiguredAmplifyClient();

    await amplifyClient.graphql(
      {
        query: updateChatSessionLineage,
        variables: {
          input: {
            id: sessionId,
            lineageSummary: JSON.stringify(summary),
          },
        },
      },
      { authMode: 'userPool' },
    );

    // Clear tracker state after successful persistence
    sessionLineageTracker.clear(sessionId);

    console.log(`[lineage] Successfully persisted lineage summary for session ${sessionId}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[lineage] Failed to persist lineage summary for session ${sessionId}: ${message}`);
    // Never throw — lineage persistence must not interrupt the request
  }
}
