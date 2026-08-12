'use client';
import { useCallback, useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

export interface SessionListItem {
  id: string;
  name: string | null;
  agentId: string | null;
  updatedAt: string; // ISO — Amplify's system `updatedAt`
}

export type SessionListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; sessions: SessionListItem[] };

/**
 * Loads the signed-in user's chat sessions for the history sidebar (issue #351).
 * `ChatSession` is owner-authed, so `list()` under `userPool` auth returns only
 * the caller's own sessions — no extra backend/authz work. Results are sorted
 * most-recently-updated first (client-side; the model has no sort key on time).
 *
 * The list is paged to a bounded number of the most recent sessions — a chat
 * history sidebar doesn't need the full lifetime of a heavy user, and an
 * unbounded scan would grow without limit.
 */
export function useSessionList(reloadKey = 0): {
  state: SessionListState;
  reload: () => void;
  patch: (id: string, name: string) => void;
  remove: (id: string) => void;
} {
  const [state, setState] = useState<SessionListState>({ status: 'loading' });
  const [localKey, setLocalKey] = useState(0);

  const reload = useCallback(() => setLocalKey((k) => k + 1), []);

  // Optimistically patch a renamed session in place so the sidebar updates
  // without a full refetch (rename UI updates the name immediately).
  const patch = useCallback((id: string, name: string) => {
    setState((prev) =>
      prev.status === 'ready'
        ? { status: 'ready', sessions: prev.sessions.map((s) => (s.id === id ? { ...s, name } : s)) }
        : prev,
    );
  }, []);

  // Optimistically drop a deleted session from the list so it disappears
  // immediately (the delete mutation is issued by the caller).
  const remove = useCallback((id: string) => {
    setState((prev) =>
      prev.status === 'ready'
        ? { status: 'ready', sessions: prev.sessions.filter((s) => s.id !== id) }
        : prev,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const { data, errors } = await amplifyClient.models.ChatSession.list({ limit: 200 });
        if (cancelled) return;
        if (errors?.length) {
          setState({ status: 'error', message: errors[0].message });
          return;
        }
        const sessions: SessionListItem[] = (data ?? [])
          .map((s) => ({
            id: s.id,
            name: s.name ?? null,
            agentId: s.agentId ?? null,
            updatedAt: s.updatedAt,
          }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setState({ status: 'ready', sessions });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load sessions' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, localKey]);

  return { state, reload, patch, remove };
}
