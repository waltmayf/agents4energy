'use client';
import { createContext, useContext } from 'react';
import type { AgentOption } from './use-agents';

/**
 * CopilotChat renders `input` with a fixed prop set (CopilotChatInputProps),
 * so the agent-picker state needed inside the composer toolbar (issue #371)
 * is threaded via context rather than through those slot props.
 */
export type AgentPickerContextValue = {
  agentId: string | null;
  selectedAgent: AgentOption | undefined;
  agents: AgentOption[];
  onAgentChange: (id: string | null) => void;
  isClaudeCode: boolean;
};

const AgentPickerContext = createContext<AgentPickerContextValue | null>(null);

export const AgentPickerProvider = AgentPickerContext.Provider;

export function useAgentPicker() {
  return useContext(AgentPickerContext);
}
