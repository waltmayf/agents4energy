'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import { DEFAULT_SESSION_NAME } from '@/lib/session-title';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

export type ChatSessionResult = {
  ready: boolean;
  sessionId: string | null;
  sessionIdRef: React.RefObject<string | null>;
  agentId: string | null;
  setAgentId: (id: string | null) => void;
};

export function useChatSession(): ChatSessionResult {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionIdParam = searchParams.get('sessionId');
  const agentIdParam = searchParams.get('agentId');

  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(sessionIdParam);
  const sessionIdRef = useRef<string | null>(sessionIdParam);
  const [agentId, setAgentIdState] = useState<string | null>(agentIdParam);

  function setAgentId(id: string | null) {
    setAgentIdState(id);
    const params = new URLSearchParams(searchParams.toString());
    if (id) {
      params.set('agentId', id);
    } else {
      params.delete('agentId');
    }
    router.replace(`?${params.toString()}`);
  }

  // Keyed on `sessionIdParam` (not mount) so client-side navigation between
  // sessions — the history sidebar's links and its "New chat" button, both of
  // which change the URL without remounting the page — re-bootstraps correctly:
  // an explicit id resumes that session; a bare /chat creates a fresh one.
  useEffect(() => {
    let cancelled = false;
    setReady(false);

    async function bootstrap() {
      if (!sessionIdParam) {
        const { data: session, errors } = await amplifyClient.models.ChatSession.create({
          name: DEFAULT_SESSION_NAME,
          agentId: agentIdParam ?? undefined,
        });
        if (errors || !session) {
          console.error('[useChatSession] failed to create session', errors);
          return;
        }
        if (cancelled) return;
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        const params = new URLSearchParams(searchParams.toString());
        params.set('sessionId', session.id);
        router.replace(`?${params.toString()}`);
        setReady(true);
      } else {
        sessionIdRef.current = sessionIdParam;
        setSessionId(sessionIdParam);
        // Fetch existing session to get its agentId if not in URL
        if (!agentIdParam) {
          const { data: session } = await amplifyClient.models.ChatSession.get({ id: sessionIdParam });
          if (!cancelled && session?.agentId) {
            setAgentIdState(session.agentId);
          }
        }
        if (!cancelled) setReady(true);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdParam]);

  return { ready, sessionId, sessionIdRef, agentId, setAgentId };
}
