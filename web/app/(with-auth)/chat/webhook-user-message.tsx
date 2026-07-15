'use client';
import { CopilotChatUserMessage } from '@copilotkit/react-core/v2';
import type { ComponentProps } from 'react';
import { splitInjectedBlocks } from '@/lib/split-injected-blocks';
import { MessageResponse } from '@/components/ai-elements/message';

type CopilotChatUserMessageProps = ComponentProps<typeof CopilotChatUserMessage>;

/**
 * Custom `userMessage` slot for `<CopilotChat>` (see `page.tsx`). Webhook runs
 * (agent-webhook-invoke-agent/handler.ts) prepend `<agents_md>` /
 * `<github_context>` / `<github_access>` blocks to the first user turn —
 * Bedrock's Converse API requires that turn to stay `Role: user`, so the
 * model-facing role can't change. Splitting and rendering the injected blocks
 * here (assistant Markdown styling) instead of leaving them in the plain user
 * bubble is purely a transcript-display concern (issue #120).
 */
function WebhookAwareUserMessageComponent(props: CopilotChatUserMessageProps) {
  const { message } = props;
  const flattened = typeof message.content === 'string' ? message.content : '';
  const { blocks, remainder } = splitInjectedBlocks(flattened);

  if (blocks.length === 0) {
    return <CopilotChatUserMessage {...props} />;
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {blocks.map((block, i) => (
        <div key={`${message.id}-${block.tag}-${i}`} className="w-full max-w-full rounded-lg border bg-muted/30 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {block.label}
          </div>
          <MessageResponse>{block.content}</MessageResponse>
        </div>
      ))}
      {remainder && <CopilotChatUserMessage {...props} message={{ ...message, content: remainder }} />}
    </div>
  );
}

// CopilotChatMessageView's `userMessage` slot type is `SlotValue<typeof
// CopilotChatUserMessage>`, which (per WithSlots) only accepts the exact
// default component, a className string, or a partial-props object — not an
// arbitrary replacement component. The slot resolver (resolveSlotComponent /
// isReactComponentType) accepts any function component at runtime, so this
// cast is the supported escape hatch for swapping the whole component.
export const WebhookAwareUserMessage =
  WebhookAwareUserMessageComponent as unknown as typeof CopilotChatUserMessage;
