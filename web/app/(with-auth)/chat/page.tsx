'use client';
import { CopilotKitProvider, CopilotChat } from '@copilotkit/react-core/v2';
import { HarnessAgent, type HarnessAgentConfig } from '@/lib/harness-agent';
import { ClaudeCodeAgent, CLAUDE_CODE_AGENT_ID } from '@/lib/claude-code-agent';
import { useChatSession } from './use-chat-session';
import { useSessionMessagePolling } from './use-session-message-polling';
import { useAgents } from './use-agents';
import { useMemo, useRef, useState } from 'react';
import type { AgentOption } from './use-agents';
import { Button } from '@/components/ui/button';
import { PanelLeftOpenIcon } from 'lucide-react';
import { ToolCallRenderer } from './tool-call-renderer';
import { UserMessageMarkdown } from './user-message-renderer';
import { AwaitingInputBanner } from './awaiting-input-banner';
import { ChatComposerInput } from './chat-composer-input';
import { AgentPickerProvider, type AgentPickerContextValue } from './agent-picker-context';
import { SessionSidebar } from './session-sidebar';
import { useAutoNameSession } from './use-auto-name-session';

function ChatView({
  sessionId,
  selectedAgent,
  agents,
  agentId,
  onAgentChange,
}: {
  sessionId: string;
  selectedAgent: AgentOption | undefined;
  agents: AgentOption[];
  agentId: string | null;
  onAgentChange: (id: string | null) => void;
}) {
  const isClaudeCode = agentId === CLAUDE_CODE_AGENT_ID;

  // Keep the latest selected agent readable from the agent's config callback
  // without recreating the HarnessAgent (which would drop the connection).
  const agentConfigRef = useRef<HarnessAgentConfig>({});
  agentConfigRef.current = {
    agentId: selectedAgent?.id ?? null,
    systemPromptText: selectedAgent?.systemPromptText ?? null,
    modelId: selectedAgent?.modelId ?? null,
    mcpServers: selectedAgent?.mcpServers.map((s) => ({
      name: s.name,
      url: s.url,
      headers: Object.fromEntries(
        (s.headers ?? [])
          .filter((h): h is { key: string; value: string } => !!h.key && !!h.value)
          .map((h) => [h.key, h.value]),
      ),
      gatewayTargetId: s.gatewayTargetId ?? undefined,
    })),
  };

  // One agent transport per session. threadId === AgentCore session id, so
  // CopilotChat resumes history via connect() and streams live turns via run().
  // Both transports write/read the same shared AgentCore Memory, so switching
  // the picker mid-session still resumes the same transcript.
  const harnessAgent = useMemo(
    () => new HarnessAgent({ threadId: sessionId, getConfig: () => agentConfigRef.current }),
    [sessionId],
  );
  const claudeCodeAgent = useMemo(
    () => new ClaudeCodeAgent({ threadId: sessionId }),
    [sessionId],
  );
  const activeAgent = isClaudeCode ? claudeCodeAgent : harnessAgent;

  const agentsMap = useMemo(() => ({ default: activeAgent }), [activeAgent]);

  // Poll AgentCore memory so turns written elsewhere (e.g. a webhook run on the
  // same session) render live, without a page reload. See issue #63.
  useSessionMessagePolling(activeAgent);

  // Auto-name the session from its first user message (issue #352).
  useAutoNameSession(activeAgent, sessionId);

  // Threaded to `ChatComposerInput` via context — CopilotChat's `input` slot
  // gets a fixed prop set, so the agent-picker controls it renders (issue
  // #371) can't receive this as ordinary props.
  const agentPickerValue = useMemo<AgentPickerContextValue>(
    () => ({ agentId, selectedAgent, agents, onAgentChange, isClaudeCode }),
    [agentId, selectedAgent, agents, onAgentChange, isClaudeCode],
  );

  return (
    <CopilotKitProvider selfManagedAgents={agentsMap}>
      {/* Registers a wildcard tool-call renderer so tool activity (name/args/result)
          renders as a collapsible card instead of an empty bubble. Side-effect only. */}
      <ToolCallRenderer />
      {/* The page shell (Page) now sets an explicit `h-dvh` on the flex row that
          wraps the sidebar + this view, so `h-full` resolves here and clips the
          message list to a scrollable region instead of growing the page. */}
      <AgentPickerProvider value={agentPickerValue}>
        <div className="flex flex-col h-full min-h-0">
          <AwaitingInputBanner agent={activeAgent} />
          <div className="flex-1 min-h-0">
            <CopilotChat
              agentId="default"
              threadId={sessionId}
              labels={{
                chatInputPlaceholder: 'Type a message…',
              }}
              messageView={{
                userMessage: { messageRenderer: UserMessageMarkdown },
              }}
              input={ChatComposerInput}
            />
          </div>
        </div>
      </AgentPickerProvider>
    </CopilotKitProvider>
  );
}

const Chat = function Page() {
  const { ready, sessionId, agentId, setAgentId } = useChatSession();
  const agentsState = useAgents();
  // Session history sidebar is hidden by default; the toggle reveals it.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const agents = agentsState.status === 'ready' ? agentsState.agents : [];
  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <div className="flex h-dvh min-h-0">
      {/* Chat history sidebar (issue #351) — lists/reopens/renames/deletes past
          sessions. Hidden by default; toggled via the button in the chat pane. */}
      {sidebarOpen && (
        <SessionSidebar activeSessionId={sessionId} onClose={() => setSidebarOpen(false)} />
      )}
      <div className="relative min-w-0 flex-1">
        {!sidebarOpen && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Show chat history"
            className="absolute left-2 top-2 z-10 bg-background/80 backdrop-blur"
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeftOpenIcon className="size-4" />
            <span className="sr-only">Show chat history</span>
          </Button>
        )}
        {ready && sessionId && (
          <ChatView
            key={sessionId}
            sessionId={sessionId}
            selectedAgent={selectedAgent}
            agents={agents}
            agentId={agentId}
            onAgentChange={setAgentId}
          />
        )}
      </div>
    </div>
  );
};

export default Chat;
