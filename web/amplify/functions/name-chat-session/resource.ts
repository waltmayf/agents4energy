import { defineFunction } from '@aws-amplify/backend';

/**
 * Generates a concise title for a chat session from its first user message
 * using a small/fast Bedrock model (issue #374). Invoked as a custom AppSync
 * mutation right after the client's cheap client-side derived title, so the
 * session name upgrades from "first-few-words…" to a real summary a moment
 * later. Kept short-timeout — a naming hiccup must never block the chat.
 */
export const nameChatSession = defineFunction({
  name: 'name-chat-session',
  entry: './handler.ts',
  timeoutSeconds: 15,
  environment: {
    // Small, fast, cheap model for one-line titling. Overridable at deploy time.
    NAMING_MODEL_ID: process.env.NAMING_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
});
