import {
  BedrockAgentCoreClient,
  ListEventsCommand,
  ListMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new BedrockAgentCoreClient({ region: REGION });

interface ListSessionMessagesArgs {
  sessionId: string;
  actorId: string;
  nextToken?: string | null;
}

interface ConversationalEvent {
  eventId: string;
  role: string;
  text: string;
  // JSON string of the Bedrock Converse ContentBlock[] for this message, or null
  // when the stored payload wasn't structured JSON. Parsed once, here.
  contentJson: string | null;
  timestamp: string;
}

/**
 * The harness stores each message's payload text as a JSON string. It's usually
 * a Converse message ({ role, content: ContentBlock[] }) or a bare
 * ContentBlock[]. Normalize to the content-block array, or return null when the
 * text isn't structured JSON (plain-text fallback).
 */
function extractContentBlocks(rawText: string): any[] | null {
  try {
    const parsed = JSON.parse(rawText);
    const msg = parsed?.message ?? parsed;
    const content = Array.isArray(msg) ? msg : msg?.content;
    return Array.isArray(content) ? content : null;
  } catch {
    return null;
  }
}

/** Flatten Converse content blocks to plain text (text + reasoning + toolResult text). */
function flattenBlocksToText(blocks: any[]): string {
  const collect = (item: any): string => {
    if (!item || typeof item !== 'object') return '';
    if (typeof item.text === 'string') return item.text;
    if (item.reasoningContent?.reasoningText?.text) return item.reasoningContent.reasoningText.text;
    if (item.toolResult?.content) return item.toolResult.content.map(collect).join(' ');
    if (Array.isArray(item.content)) return item.content.map(collect).join(' ');
    return '';
  };
  return blocks.map(collect).filter(Boolean).join(' ').trim();
}

interface ListSessionMessagesResult {
  events: ConversationalEvent[];
  nextToken?: string | null;
  // Session summary produced asynchronously by AgentCore's SUMMARIZATION strategy.
  // Null when no summary has been generated yet (new or short sessions).
  summary?: string | null;
  // ISO timestamp of when the summary was created. Use this to filter events to
  // only those that occurred after the last compaction.
  summaryTimestamp?: string | null;
  // The AgentCore MemoryRecord ID for the summary record — needed to update it.
  summaryRecordId?: string | null;
}

async function fetchSessionSummary(
  sessionId: string,
  actorId: string,
): Promise<{ summary: string; summaryTimestamp: string; summaryRecordId: string } | null> {
  // AgentCore stores managed summaries under /summaries/{actorId}/{sessionId}.
  const namespace = `/summaries/${actorId}/${sessionId}`;
  try {
    const output = await client.send(
      new ListMemoryRecordsCommand({
        memoryId: MEMORY_ID,
        namespace,
        maxResults: 1,
      }),
    );
    const record = output.memoryRecordSummaries?.[0];
    if (!record?.content?.text) return null;
    return {
      summary: record.content.text,
      summaryTimestamp: record.createdAt?.toISOString() ?? '',
      summaryRecordId: record.memoryRecordId ?? '',
    };
  } catch {
    // No summary yet — not an error.
    return null;
  }
}

export const handler = async (
  event: { arguments: ListSessionMessagesArgs },
): Promise<ListSessionMessagesResult> => {
  const { sessionId, actorId, nextToken } = event.arguments;

  // Fetch summary and raw events in parallel.
  const [summaryResult, eventsOutput] = await Promise.all([
    fetchSessionSummary(sessionId, actorId),
    client.send(
      new ListEventsCommand({
        memoryId: MEMORY_ID,
        sessionId,
        actorId,
        includePayloads: true,
        ...(nextToken ? { nextToken } : {}),
      }),
    ),
  ]);

  const summaryTs = summaryResult?.summaryTimestamp
    ? new Date(summaryResult.summaryTimestamp)
    : null;

  const events: ConversationalEvent[] = [];

  for (const e of eventsOutput.events ?? []) {
    // Skip events that predate the last summary — they're already captured in it.
    if (summaryTs && e.eventTimestamp && e.eventTimestamp <= summaryTs) continue;

    for (const payload of e.payload ?? []) {
      if (!payload.conversational) continue;
      const { role, content } = payload.conversational;
      if (!role) continue;

      // The harness SDK stores the full Converse message as a JSON string in the
      // text field. Parse it ONCE into content blocks here: `contentJson` carries
      // the structured blocks (for rich rendering), `text` is the flattened
      // plain text (for simple consumers). Fall back to raw text when unparseable.
      const rawText = content?.text ?? '';
      const blocks = rawText ? extractContentBlocks(rawText) : null;
      const text = blocks ? flattenBlocksToText(blocks) : rawText;

      // Keep messages that have renderable text OR structured blocks (a pure
      // toolUse/toolResult message has no flattened text but is still meaningful).
      if (!text && !blocks) continue;
      events.push({
        eventId: e.eventId!,
        role: role.toLowerCase(),
        text,
        contentJson: blocks ? JSON.stringify(blocks) : null,
        timestamp: e.eventTimestamp?.toISOString() ?? '',
      });
    }
  }

  return {
    events,
    nextToken: eventsOutput.nextToken ?? null,
    summary: summaryResult?.summary ?? null,
    summaryTimestamp: summaryResult?.summaryTimestamp ?? null,
    summaryRecordId: summaryResult?.summaryRecordId ?? null,
  };
};
