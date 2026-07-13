// Hook to poll AgentCore memory for new session messages
import { useEffect, useState, useRef } from 'react';
import type { UIMessage } from 'ai';
import { fetchSessionMessages } from './use-initial-messages';

/**
 * Polls `fetchSessionMessages` for the given `sessionId` at a regular interval.
 * Returns the latest list of messages from AgentCore memory.
 *
 * The polling stops when the document is hidden (tab inactive) or when no new
 * messages have been observed for a configurable number of consecutive polls.
 */
export function useSessionMessagePolling(
  sessionId: string | null,
  /**
   * The current messages produced by the live chat transport (e.g. streaming).
   * Used to detect when new remote messages appear.
   */
  liveMessages: UIMessage[],
  pollIntervalMs = 3000,
  maxIdlePolls = 5,
): UIMessage[] {
  const [polledMessages, setPolledMessages] = useState<UIMessage[]>([]);
  const idleCountRef = useRef(0);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setPolledMessages([]);
      return;
    }

    let cancelled = false;
    let intervalId: NodeJS.Timeout;

    const poll = async () => {
      // Pause polling when tab is hidden
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      try {
        const { messages } = await fetchSessionMessages(sessionId);
        if (cancelled) return;
        setPolledMessages(messages);
        // Determine if there are new messages compared to previous poll
        const newLength = messages.length;
        if (newLength === prevLengthRef.current) {
          idleCountRef.current += 1;
        } else {
          idleCountRef.current = 0;
        }
        prevLengthRef.current = newLength;
        // Stop polling after a period of idleness to avoid endless loops
        if (idleCountRef.current >= maxIdlePolls) {
          clearInterval(intervalId);
        }
      } catch (err) {
        console.error('[useSessionMessagePolling] error', err);
      }
    };

    // Initial immediate poll
    poll();
    intervalId = setInterval(poll, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [sessionId, pollIntervalMs, maxIdlePolls]);

  // Return the latest polled messages (may be empty if not polling)
  return polledMessages;
}
