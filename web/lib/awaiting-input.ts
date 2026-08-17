/**
 * Recognizes the terminal "awaiting_input" marker turn that
 * `web/amplify/agentcore/ClaudeCode/memory.js`'s `buildAwaitingInputMarkerBlocks`
 * persists to AgentCore Memory when a Claude Code run ends asking the user a
 * question (issue #185). Mirrored here — not imported — since that file is
 * plain Node.js outside this TypeScript project.
 */
const NO_QUESTION_MARKER = '[awaiting_input] Run ended waiting for user input.';
const WITH_QUESTION_PREFIX = '[awaiting_input] Run ended waiting for user input: ';

/**
 * Returns the extracted question (possibly `''` when the run didn't capture
 * one) if `text` is an awaiting-input marker turn, or `null` if it isn't.
 */
export function parseAwaitingInputMarker(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === NO_QUESTION_MARKER) return '';
  if (trimmed.startsWith(WITH_QUESTION_PREFIX)) return trimmed.slice(WITH_QUESTION_PREFIX.length).trim();
  return null;
}
