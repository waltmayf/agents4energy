'use client';
import { useCallback, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import { useCopilotKit } from '@copilotkit/react-core/v2';
import { useAwaitingInput } from './use-awaiting-input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2Icon, PauseIcon } from 'lucide-react';

/**
 * Surfaces a paused Claude Code run (issue #185): when the session's most
 * recent memory event is the "awaiting_input" marker `memory.js`'s
 * `persistAwaitingInputMarker` writes, this renders the stored question and a
 * dedicated answer box instead of leaving the user to notice it buried at the
 * bottom of a tool-call-heavy transcript.
 *
 * Submitting re-invokes the SAME agent instance the chat is already using —
 * `agent.addMessage` + `copilotkit.runAgent({ agent })` mirrors exactly what
 * CopilotChatInput does for a normal typed message — so the run reuses the
 * agent's unchanged `threadId`, which `ClaudeCodeAgent.run()` sends as
 * `runtimeSessionId`. That's the same id the paused run used, so the runtime
 * resumes against the same session-storage workspace clone and AgentCore
 * Memory conversation rather than starting fresh (see claude-code-agent.ts).
 */
export function AwaitingInputBanner({ agent }: { agent: AbstractAgent }) {
  const { awaiting, question } = useAwaitingInput(agent);
  const { copilotkit } = useCopilotKit();
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const value = answer.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setAnswer('');
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: value });
    try {
      await copilotkit.runAgent({ agent });
    } finally {
      setSubmitting(false);
    }
  }, [agent, answer, copilotkit, submitting]);

  if (!awaiting) return null;

  return (
    <div className="space-y-2 border-b bg-amber-50 px-3 py-2.5 dark:bg-amber-950/30">
      <div className="flex items-start gap-2 text-sm">
        <PauseIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <div className="font-medium text-amber-900 dark:text-amber-200">Paused — waiting for your input</div>
          {question && (
            <div className="mt-0.5 text-amber-800/90 dark:text-amber-300/90">{question}</div>
          )}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer…"
          disabled={submitting}
          className="flex-1 bg-background"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <Button size="sm" onClick={handleSubmit} disabled={submitting || !answer.trim()}>
          {submitting ? <Loader2Icon className="size-4 animate-spin" /> : 'Send'}
        </Button>
      </div>
    </div>
  );
}
