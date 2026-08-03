import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

// Data client using Cognito auth (both viewers and the browser producer are
// Cognito principals under allow.authenticated()).
const dataClient = generateClient<Schema>({ authMode: 'userPool' });

export type ActiveRun = Awaited<ReturnType<typeof dataClient.models.ActiveRun.get>>['data'] | null;

/**
 * Fetch the ActiveRun record for a given session.
 * Returns null if no record exists.
 */
export async function fetchActiveRun(sessionId: string): Promise<ActiveRun> {
  // Key query against the sessionId GSI (listActiveRunBySession) rather than a
  // Scan-with-filter — see the secondaryIndexes() note in chat.schema.ts.
  const res = await dataClient.models.ActiveRun.listActiveRunBySession({
    sessionId,
  }, { limit: 1 });
  const rec = (res.data ?? [])[0];
  return rec ?? null;
}

export interface UpsertActiveRunInput {
  sessionId: string;
  messageId: string;
  accumulatedText: string;
  status: 'streaming' | 'done';
}

/**
 * Write a throttled snapshot of the in-flight assistant message for a session.
 * Creates the session's row on first write, updates it (by id) thereafter.
 * Returns the row id on success (so the caller can update-by-id on later
 * throttles without re-listing), or null if the write failed — a snapshot
 * write must never break the live stream, so errors are logged and swallowed.
 */
export async function upsertActiveRun(input: UpsertActiveRunInput, existingId?: string | null): Promise<string | null> {
  try {
    const updatedAt = new Date().toISOString();
    if (existingId) {
      const res = await dataClient.models.ActiveRun.update({
        id: existingId,
        messageId: input.messageId,
        accumulatedText: input.accumulatedText,
        status: input.status,
        updatedAt,
      });
      if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
      return res.data?.id ?? existingId;
    }

    const listRes = await dataClient.models.ActiveRun.listActiveRunBySession({
      sessionId: input.sessionId,
    }, { limit: 1 });
    const existing = (listRes.data ?? [])[0];
    if (existing) {
      const res = await dataClient.models.ActiveRun.update({
        id: existing.id,
        messageId: input.messageId,
        accumulatedText: input.accumulatedText,
        status: input.status,
        updatedAt,
      });
      if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
      return res.data?.id ?? existing.id;
    }

    const res = await dataClient.models.ActiveRun.create({
      sessionId: input.sessionId,
      messageId: input.messageId,
      accumulatedText: input.accumulatedText,
      status: input.status,
      updatedAt,
    });
    if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
    return res.data?.id ?? null;
  } catch (err) {
    console.error('Failed to upsert ActiveRun for session', input.sessionId, err);
    return null;
  }
}

/** Delete the session's ActiveRun row(s), swallowing errors — best-effort cleanup. */
export async function clearActiveRun(sessionId: string): Promise<void> {
  try {
    const res = await dataClient.models.ActiveRun.listActiveRunBySession({
      sessionId,
    }, { limit: 10 });
    for (const row of res.data ?? []) {
      await dataClient.models.ActiveRun.delete({ id: row.id });
    }
  } catch (err) {
    console.error('Failed to clear ActiveRun for session', sessionId, err);
  }
}
