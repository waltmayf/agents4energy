import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = process.env.NAMING_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Keep in sync with web/lib/session-title.ts MAX_TITLE_LENGTH — the client
// truncates its own derived title to the same bound.
const MAX_TITLE_LENGTH = 60;

const client = new BedrockRuntimeClient({ region: REGION });

interface NameChatSessionArgs {
  /** The first user message of the session. */
  firstMessage: string;
}

const SYSTEM_PROMPT =
  'You write short, specific titles for chat conversations. ' +
  'Given the user\'s first message, reply with a concise title of at most 6 words ' +
  'that captures the topic. Use Title Case. Do not use quotation marks, trailing ' +
  'punctuation, or any preamble — output only the title itself.';

/** Trim quotes/whitespace and clamp to the shared max length on a word boundary. */
function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // Drop a trailing period the model sometimes adds; keep ? and ! as meaningful.
  t = t.replace(/\.$/, '').trim();
  if (t.length <= MAX_TITLE_LENGTH) return t;
  const clipped = t.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > MAX_TITLE_LENGTH * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}

/**
 * Returns an LLM-generated title for the session, or `null` if naming failed
 * (empty input, model error, empty completion). Callers treat `null` as "keep
 * whatever title you already have" — the client-side derived title is the
 * fallback, so this must never throw into the chat flow.
 */
export const handler = async (
  event: { arguments: NameChatSessionArgs },
): Promise<string | null> => {
  const firstMessage = (event.arguments.firstMessage ?? '').trim();
  if (!firstMessage) return null;

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: firstMessage.slice(0, 4000) }] }],
        inferenceConfig: { maxTokens: 32, temperature: 0.2 },
      }),
    );
    const text = response.output?.message?.content?.find((b) => b.text)?.text ?? '';
    const title = cleanTitle(text);
    return title || null;
  } catch (err) {
    console.warn('[name-chat-session] naming failed', err);
    return null;
  }
};
