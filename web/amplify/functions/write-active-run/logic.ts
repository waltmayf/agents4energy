export interface WriteActiveRunEvent {
  sessionId: string;
  messageId: string;
  accumulatedText: string;
  status: 'streaming' | 'done';
  clear?: boolean;
}

export interface WriteActiveRunResult {
  ok: boolean;
  id?: string;
}

/** Minimal shape of the ActiveRun model client this handler needs — kept narrow so tests can fake it without a real Amplify Data client. */
export interface ActiveRunModelClient {
  models: {
    ActiveRun: {
      list: (input: { filter: { sessionId: { eq: string } }; limit?: number }) => Promise<{
        data: Array<{ id: string }>;
        errors?: Array<{ message: string }>;
      }>;
      create: (input: {
        sessionId: string;
        messageId: string;
        accumulatedText: string;
        status: string;
        updatedAt: string;
      }) => Promise<{ data?: { id: string } | null; errors?: Array<{ message: string }> }>;
      update: (input: {
        id: string;
        messageId: string;
        accumulatedText: string;
        status: string;
        updatedAt: string;
      }) => Promise<{ data?: { id: string } | null; errors?: Array<{ message: string }> }>;
      delete: (input: { id: string }) => Promise<{ data?: { id: string } | null; errors?: Array<{ message: string }> }>;
    };
  };
}

/**
 * Core upsert/clear logic — byte-for-byte consistent with web/lib/active-run.ts
 * (one ActiveRun row per session) so browser- and server-produced snapshots
 * are interchangeable for the consumer. Takes the data client as an argument
 * so it can be unit tested without a real Amplify backend.
 */
export async function writeActiveRunWithClient(
  client: ActiveRunModelClient,
  event: WriteActiveRunEvent,
): Promise<WriteActiveRunResult> {
  try {
    const listRes = await client.models.ActiveRun.list({
      filter: { sessionId: { eq: event.sessionId } },
      limit: 10,
    });
    const existing = listRes.data ?? [];

    if (event.status === 'done' || event.clear) {
      for (const row of existing) {
        await client.models.ActiveRun.delete({ id: row.id });
      }
      return { ok: true };
    }

    const updatedAt = new Date().toISOString();
    const first = existing[0];
    if (first) {
      const res = await client.models.ActiveRun.update({
        id: first.id,
        messageId: event.messageId,
        accumulatedText: event.accumulatedText,
        status: event.status,
        updatedAt,
      });
      if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
      return { ok: true, id: res.data?.id ?? first.id };
    }

    const res = await client.models.ActiveRun.create({
      sessionId: event.sessionId,
      messageId: event.messageId,
      accumulatedText: event.accumulatedText,
      status: event.status,
      updatedAt,
    });
    if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
    if (!res.data?.id) return { ok: false };
    return { ok: true, id: res.data.id };
  } catch (err) {
    console.error('Failed to write ActiveRun for session', event.sessionId, err);
    return { ok: false };
  }
}
