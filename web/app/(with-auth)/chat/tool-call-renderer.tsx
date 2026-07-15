'use client';
import { useDefaultRenderTool } from '@copilotkit/react-core/v2';
import { useState } from 'react';
import { ChevronRightIcon, WrenchIcon, Loader2Icon } from 'lucide-react';

/**
 * Registers a wildcard (`name: "*"`) tool-call renderer for the chat.
 *
 * Without a registered renderer, CopilotKit's `renderToolCall` returns null, so
 * every tool call — and its result — renders as an empty bubble. This is very
 * visible when restoring a tool-heavy session (e.g. the GitHub webhook agent),
 * where most turns are `toolUse`/`toolResult` pairs. This component renders each
 * tool call as a collapsible row showing the tool name, arguments, and result.
 *
 * Mounted for its side effect only (the hook registers the renderer); it renders
 * nothing itself.
 */
export function ToolCallRenderer() {
  useDefaultRenderTool({
    render: ({ name, parameters, status, result }) => (
      <ToolCallCard name={name} parameters={parameters} status={status} result={result} />
    ),
  });
  return null;
}

function ToolCallCard({
  name,
  parameters,
  status,
  result,
}: {
  name: string;
  parameters: unknown;
  status: 'inProgress' | 'executing' | 'complete';
  result: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const argsText = formatJson(parameters);

  return (
    <div className="my-2 rounded-lg border bg-muted/30 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-testid="tool-call"
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {status === 'complete' ? (
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
        <span className="font-mono text-xs font-medium">{name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {status === 'complete' ? 'done' : status}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {argsText && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Arguments
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1 text-xs">
                {argsText}
              </pre>
            </div>
          )}
          {status === 'complete' && result != null && result !== '' && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Result
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1 text-xs">
                {formatJson(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Pretty-print JSON-ish values; fall back to the raw string. */
function formatJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
