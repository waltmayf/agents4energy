import { a } from '@aws-amplify/backend';
import { listSessionMessages } from '../../functions/list-session-messages/resource';
import { updateSessionSummary } from '../../functions/update-session-summary/resource';

export const agentcoreMemorySchema = a.schema({
  ConversationalEvent: a.customType({
    eventId: a.string().required(),
    role: a.string().required(),
    // Flattened plain text of the message (concatenated text blocks). Kept for
    // simple consumers (e.g. /chat-handler) that only render text.
    text: a.string().required(),
    // JSON string of the full Bedrock Converse `ContentBlock[]` for this message
    // (text / toolUse / toolResult / reasoningContent). Parsed ONCE here from the
    // harness's stored payload so clients can map it straight to their render
    // model (e.g. AG-UI Message[]) without re-parsing ambiguous text. Null when
    // the payload wasn't structured JSON.
    contentJson: a.string(),
    timestamp: a.string().required(),
  }),

  ListSessionMessagesResult: a.customType({
    events: a.ref('ConversationalEvent').array().required(),
    nextToken: a.string(),
    summary: a.string(),
    summaryTimestamp: a.string(),
    // AgentCore MemoryRecord ID for the summary — needed to call updateSessionSummary.
    summaryRecordId: a.string(),
  }),

  listSessionMessages: a
    .query()
    .arguments({
      sessionId: a.string().required(),
      actorId: a.string().required(),
      nextToken: a.string(),
    })
    .returns(a.ref('ListSessionMessagesResult'))
    .handler(a.handler.function(listSessionMessages))
    .authorization((allow) => [allow.authenticated()]),

  updateSessionSummary: a
    .mutation()
    .arguments({
      memoryRecordId: a.string().required(),
      text: a.string().required(),
    })
    .returns(a.boolean().required())
    .handler(a.handler.function(updateSessionSummary))
    .authorization((allow) => [allow.authenticated()]),
});
