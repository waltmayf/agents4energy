'use client';
import { useCallback } from 'react';
import { CopilotChatInput, type CopilotChatInputProps } from '@copilotkit/react-core/v2';
import { ListPlusIcon, SquareIcon } from 'lucide-react';

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
 */
function ChatComposerInputImpl(props: CopilotChatInputProps) {
  const { value = '', onChange, onSubmitMessage, onStop, isRunning } = props;
  const hasText = value.trim().length > 0;
  const canStop = !!onStop;

  const handleSendButtonClick = useCallback(() => {
    if (isRunning && !hasText) {
      onStop?.();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || !onSubmitMessage) return;
    onSubmitMessage(trimmed);
    onChange?.('');
  }, [isRunning, hasText, value, onSubmitMessage, onChange, onStop]);

  const label = isRunning ? (hasText ? 'Queue message' : 'Stop response') : 'Send message';

  return (
    <CopilotChatInput
      {...props}
      sendButton={{
        onClick: handleSendButtonClick,
        disabled: isRunning ? !canStop : !hasText || !onSubmitMessage,
        'aria-label': label,
        title: label,
        children: isRunning
          ? hasText
            ? <ListPlusIcon className="cpk:size-[18px]" aria-hidden="true" />
            : <SquareIcon className="cpk:size-[18px] cpk:fill-current" aria-hidden="true" />
          : undefined,
      }}
    />
  );
}

// CopilotChat's `input` slot type is `SlotValue<typeof CopilotChatInput>`, which
// requires the replacement component to carry the same static sub-components
// (SendButton, TextArea, etc.) — even though this wrapper only overrides the
// send button, so it never reads them itself.
export const ChatComposerInput = Object.assign(ChatComposerInputImpl, CopilotChatInput);
