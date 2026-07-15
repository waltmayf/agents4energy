'use client';
import { useEffect } from 'react';
import type { HarnessAgent } from '@/lib/harness-agent';

/**
 * Polls AgentCore memory so the chat renders messages as they arrive, not just
 * on reload. Restores the behavior originally added for issue #63, adapted to
 * the CopilotKit / AG-UI architecture: instead of merging into a `useChat`
 * message array, we ask the HarnessAgent to refresh its own transcript
 * (`refreshHistory()` → `setMessages` → `onMessagesChanged` → live re-render).
 *
 * The webhook case is the motivation: a harness run writes to the same session
 * the browser is viewing. `HarnessAgent.connect()` only runs on (re)mount, so
 * without this hook new turns appear only after a manual refresh.
 *
 * Backoff/pause rules (documented, so we neither poll forever at full rate nor
 * stall a long-running view):
 *  - Paused while the tab is hidden (`document.hidden`) — the biggest cost sink
 *    is background tabs, and a hidden tab re-syncs the moment it's shown again.
 *  - Polls at `activeIntervalMs` while messages are still arriving; after
 *    `idleThreshold` consecutive no-change polls it *slows* to `idleIntervalMs`
 *    rather than stopping. A webhook run that produces output minutes apart
 *    still surfaces live; a truly quiet session just polls infrequently.
 *  - `refreshHistory()` itself no-ops while a local turn is streaming and only
 *    grows the transcript, so polling can never clobber optimistic messages.
 */
export function useSessionMessagePolling(
  agent: HarnessAgent | null,
  activeIntervalMs = 3000,
  idleIntervalMs = 15000,
  idleThreshold = 5,
): void {
  useEffect(() => {
    if (!agent) return;

    let cancelled = false;
    let idleCount = 0;
    let lastCount = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (cancelled) return;
      // Pause while the tab is hidden — don't fetch, re-check again shortly.
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(activeIntervalMs);
        return;
      }
      try {
        const count = await agent.refreshHistory();
        if (cancelled) return;
        if (count === lastCount) {
          idleCount += 1;
        } else {
          idleCount = 0;
          lastCount = count;
        }
      } catch (err) {
        console.error('[useSessionMessagePolling] error', err);
      }
      schedule(idleCount >= idleThreshold ? idleIntervalMs : activeIntervalMs);
    };

    schedule(activeIntervalMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agent, activeIntervalMs, idleIntervalMs, idleThreshold]);
}
