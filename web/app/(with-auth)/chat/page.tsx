'use client';
import { CopilotKitProvider, CopilotChat } from '@copilotkit/react-core/v2';
import { HarnessAgent, type HarnessAgentConfig } from '@/lib/harness-agent';
import { useChatSession } from './use-chat-session';
import { useAgents } from './use-agents';
import { useMemo, useRef, useState, useCallback } from 'react';
import type { AgentOption, McpServerInfo } from './use-agents';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WrenchIcon, Loader2Icon } from 'lucide-react';
import { listMcpToolsForServer } from '@/lib/list-mcp-tools';

type McpTool = {
  name: string;
  description?: string | null;
  inputSchema?: string | null;
};

type ServerToolsResult = {
  server: McpServerInfo;
  tools: McpTool[];
  error?: string | null;
};

function AgentToolsDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentOption;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [results, setResults] = useState<ServerToolsResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setResults(null);
    const settled = await Promise.all(
      agent.mcpServers.map(async (server): Promise<ServerToolsResult> => {
        try {
          const serverWithHeaders = {
            ...server,
            headers: (server.headers ?? []).filter(
              (h): h is { key: string; value: string } => !!h.key && !!h.value,
            ),
          };
          const result = await listMcpToolsForServer(serverWithHeaders);
          return {
            server,
            tools: result.tools.filter((t): t is McpTool => t != null),
            error: result.error,
          };
        } catch (err) {
          return { server, tools: [], error: String(err) };
        }
      }),
    );
    setResults(settled);
    setLoading(false);
  }, [agent]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (next) fetchTools();
    },
    [onOpenChange, fetchTools],
  );

  const totalTools = results?.reduce((n, r) => n + r.tools.length, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Tools — {agent.name}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-1">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2Icon className="size-4 animate-spin" />
              Loading tools…
            </div>
          )}

          {results && results.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No MCP servers configured for this agent.
            </p>
          )}

          {results?.map((r) => (
            <div key={r.server.id}>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {r.server.name}
                </span>
                <span className="text-xs text-muted-foreground">({r.server.url})</span>
              </div>

              {r.error && (
                <p className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2 mb-2">
                  {r.error}
                </p>
              )}

              {r.tools.length === 0 && !r.error && (
                <p className="text-xs text-muted-foreground pl-1">No tools returned.</p>
              )}

              <ul className="space-y-1.5">
                {r.tools.map((tool) => (
                  <li key={tool.name} className="rounded-lg border bg-muted/30 px-3 py-2">
                    <div className="text-sm font-medium font-mono">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">{tool.description}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {results && (
          <DialogFooter showCloseButton>
            <span className="text-xs text-muted-foreground mr-auto self-center">
              {totalTools} tool{totalTools !== 1 ? 's' : ''} across {results.length} server{results.length !== 1 ? 's' : ''}
            </span>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
  const [toolsDialogOpen, setToolsDialogOpen] = useState(false);

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
    })),
  };

  // One HarnessAgent per session. threadId === AgentCore session id, so
  // CopilotChat resumes history via connect() and streams live turns via run().
  const harnessAgent = useMemo(
    () => new HarnessAgent({ threadId: sessionId, getConfig: () => agentConfigRef.current }),
    [sessionId],
  );

  const agentsMap = useMemo(() => ({ default: harnessAgent }), [harnessAgent]);

  return (
    <CopilotKitProvider selfManagedAgents={agentsMap}>
      <div className="flex flex-col h-full min-h-0">
        <div className="flex-1 min-h-0">
          <CopilotChat
            agentId="default"
            threadId={sessionId}
            labels={{
              chatInputPlaceholder: 'Type a message…',
            }}
          />
        </div>

        <div className="flex items-center justify-end gap-1 border-t px-3 py-2">
          {agents.length > 0 && (
            <Select
              value={agentId ?? '__default__'}
              onValueChange={(val) => onAgentChange(val === '__default__' ? null : val)}
            >
              <SelectTrigger className="h-8 w-auto min-w-40">
                <SelectValue>{selectedAgent?.name ?? 'Default agent'}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="__default__">Default agent</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedAgent && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                title="View agent tools"
                onClick={() => setToolsDialogOpen(true)}
              >
                <WrenchIcon />
                <span className="sr-only">View agent tools</span>
              </Button>
              <AgentToolsDialog
                agent={selectedAgent}
                open={toolsDialogOpen}
                onOpenChange={setToolsDialogOpen}
              />
            </>
          )}
        </div>
      </div>
    </CopilotKitProvider>
  );
}

const Chat = function Page() {
  const { ready, sessionId, agentId, setAgentId } = useChatSession();
  const agentsState = useAgents();

  const agents = agentsState.status === 'ready' ? agentsState.agents : [];
  const selectedAgent = agents.find((a) => a.id === agentId);

  if (!ready || !sessionId) return null;

  return (
    <ChatView
      sessionId={sessionId}
      selectedAgent={selectedAgent}
      agents={agents}
      agentId={agentId}
      onAgentChange={setAgentId}
    />
  );
};

export default Chat;
