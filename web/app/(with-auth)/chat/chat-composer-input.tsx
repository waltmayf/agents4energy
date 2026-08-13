'use client';
import { useCallback, useState, type ComponentProps } from 'react';
import { CopilotChatInput, type CopilotChatInputProps } from '@copilotkit/react-core/v2';
import { ListPlusIcon, SquareIcon, WrenchIcon, Loader2Icon } from 'lucide-react';
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
import { CLAUDE_CODE_AGENT_ID } from '@/lib/claude-code-agent';
import { listMcpToolsForServer } from '@/lib/list-mcp-tools';
import { useCurrentUser } from '@/lib/use-current-user';
import { listAllToolGrants, isToolGrantedToAnyGroup, type ToolGrant } from '@/lib/tool-permissions';
import type { AgentOption, McpServerInfo } from './use-agents';
import { useAgentPicker } from './agent-picker-context';

/**
 * Shows the signed-in user's Cognito groups (issue #246) — the identity
 * foundation later UI work (#247) will use to hide unauthorized tools/agents.
 * Renders nothing until groups are loaded or when the user has none.
 */
function UserGroupsBadge() {
  const { groups, loading } = useCurrentUser();
  if (loading || groups.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground self-center" title="Your Cognito groups">
      {groups.join(', ')}
    </span>
  );
}

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
  const { groups: userGroups } = useCurrentUser();

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setResults(null);
    const grants = await listAllToolGrants().catch(() => [] as ToolGrant[]);
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
          const grantsForServer = grants.filter((g) => g.mcpServerId === server.id);
          // UX-only (non-authoritative, see #248): hide a tool once its server
          // is governed (any grant row exists) unless the user's groups are
          // explicitly allowed. Ungoverned servers show every tool.
          const tools = result.tools
            .filter((t): t is McpTool => t != null)
            .filter(
              (t) =>
                grantsForServer.length === 0 ||
                isToolGrantedToAnyGroup(grants, userGroups, server.id, t.name),
            );
          return { server, tools, error: result.error };
        } catch (err) {
          return { server, tools: [], error: String(err) };
        }
      }),
    );
    setResults(settled);
    setLoading(false);
  }, [agent, userGroups]);

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

/**
 * Agent picker + tools/groups controls, rendered inside the composer's
 * toolbar row (issue #371) instead of the detached footer strip it used to
 * live in. Reads the active session's agent state from context — see
 * `agent-picker-context.tsx` for why (CopilotChat's `input` slot gets a
 * fixed prop set, not this page's state).
 */
function ComposerAgentControls() {
  const picker = useAgentPicker();
  const [toolsDialogOpen, setToolsDialogOpen] = useState(false);
  if (!picker) return null;
  const { agentId, selectedAgent, agents, onAgentChange, isClaudeCode } = picker;

  return (
    <>
      <UserGroupsBadge />
      <Select
        value={agentId ?? '__default__'}
        onValueChange={(val) => onAgentChange(val === '__default__' ? null : val)}
      >
        <SelectTrigger className="h-8 w-auto min-w-32">
          <SelectValue>
            {isClaudeCode ? 'Claude Code' : selectedAgent?.name ?? 'Default agent'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="__default__">Default agent</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
          <SelectItem value={CLAUDE_CODE_AGENT_ID}>Claude Code</SelectItem>
        </SelectContent>
      </Select>
      {selectedAgent && (
        <>
          <Button
            type="button"
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
    </>
  );
}

/**
 * CopilotChatInput's built-in send button always calls `onStop` while a run
 * is in-flight, even when the box has queued text — only its Enter-key
 * handler already distinguishes "queue" (text present) from "interrupt" (box
 * empty), per `if (isProcessing && !canSend) onStop(); else send()` in the
 * library. This wrapper (issue #121) brings the mouse click in line with
 * that same rule and swaps the button's icon to match. `onSubmitMessage`
 * itself already defers to after the active run settles (CopilotChat's
 * `onSubmitInput` awaits `waitForActiveRunToSettle()`), so calling it while
 * running is already true queueing — no separate queue mechanism needed.
 *
 * The send button is overridden with a component (rather than a plain props
 * object) so the agent picker + tools controls (issue #371) can render as
 * siblings in the same toolbar row, next to the actual send button.
 */
function ChatComposerInputImpl(props: CopilotChatInputProps) {
  const { value = '', onChange, onSubmitMessage, onStop, isRunning } = props;
  const hasText = value.trim().length > 0;
  const willStop = isRunning && !hasText;

  const handleSendButtonClick = useCallback(() => {
    if (willStop) {
      onStop?.();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || !onSubmitMessage) return;
    onSubmitMessage(trimmed);
    onChange?.('');
  }, [willStop, value, onSubmitMessage, onChange, onStop]);

  const label = isRunning ? (hasText ? 'Queue message' : 'Stop response') : 'Send message';

  const ToolbarSendButton = useCallback(
    (sendButtonProps: ComponentProps<typeof CopilotChatInput.SendButton>) => (
      <>
        <ComposerAgentControls />
        <CopilotChatInput.SendButton
          {...sendButtonProps}
          onClick={handleSendButtonClick}
          disabled={willStop ? !onStop : !hasText || !onSubmitMessage}
          aria-label={label}
          title={label}
          children={
            isRunning
              ? hasText
                ? <ListPlusIcon className="cpk:size-[18px]" aria-hidden="true" />
                : <SquareIcon className="cpk:size-[18px] cpk:fill-current" aria-hidden="true" />
              : undefined
          }
        />
      </>
    ),
    [handleSendButtonClick, willStop, onStop, hasText, onSubmitMessage, label, isRunning],
  );

  return <CopilotChatInput {...props} sendButton={ToolbarSendButton} />;
}

// CopilotChat's `input` slot type is `SlotValue<typeof CopilotChatInput>`, which
// requires the replacement component to carry the same static sub-components
// (SendButton, TextArea, etc.) — even though this wrapper only overrides the
// send button, so it never reads them itself.
export const ChatComposerInput = Object.assign(ChatComposerInputImpl, CopilotChatInput);
