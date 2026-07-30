import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

// Data client using Cognito auth for reads (viewers are authenticated)
const dataClient = generateClient<Schema>({ authMode: 'userPool' });

export type ActiveRun = Awaited<ReturnType<typeof dataClient.models.ActiveRun.get>>['data'] | null;

/**
 * Fetch the ActiveRun record for a given session.
 * Returns null if no record exists.
 */
export async function fetchActiveRun(sessionId: string): Promise<ActiveRun> {
  // Query by sessionId field; assuming sessionId is the primary identifier.
  // Use list with filter to get the record.
  const res = await dataClient.models.ActiveRun.list({
    filter: { sessionId: { eq: sessionId } },
    limit: 1,
  });
  const rec = (res.data ?? [])[0];
  return rec ?? null;
}
