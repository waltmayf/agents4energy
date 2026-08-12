import { a } from '@aws-amplify/backend';
import { nameChatSession } from '../../functions/name-chat-session/resource';

/**
 * Chat Schema
 * Models for managing chat sessions. Message history is persisted in
 * AgentCore memory (see functions/list-session-messages), not DynamoDB.
 */
export const chatSchema = a.schema({

  // Generate a concise session title from its first user message via a small
  // Bedrock model (issue #372). The client applies a cheap derived title
  // immediately, then upgrades to this LLM-generated one when it resolves.
  nameChatSession: a
    .mutation()
    .arguments({ firstMessage: a.string().required() })
    .returns(a.string())
    .handler(a.handler.function(nameChatSession))
    .authorization((allow) => [allow.authenticated()]),

  ChatSession: a.model({
    name: a.string(),
    // Slug of the Agent this session is scoped to. Drives model + system prompt + gateway tools.
    agentId: a.string(),
    mapBounds: a.json(), // Optional: store last view bounds as [west, south, east, north]
    lineageSummary: a.json(), // Optional: consolidated list of datasets accessed during the session
  })
    .authorization((allow) => [allow.owner(), allow.authenticated(), allow.guest()]),

  ActiveRun: a.model({
    sessionId: a.id().required(),
    messageId: a.string().required(),
    accumulatedText: a.string(),
    status: a.string().required(),
    updatedAt: a.datetime(),
  })
    // Every producer/consumer path looks the row up by sessionId. Without this
    // GSI, `.list({ filter: { sessionId } })` is a full-table Scan-with-filter;
    // the index turns it into an O(1) key query. Exposed as
    // `listActiveRunBySession(sessionId)` on the client + GraphQL API.
    .secondaryIndexes((index) => [index('sessionId').queryField('listActiveRunBySession')])
    .authorization((allow) => [allow.owner(), allow.authenticated(), allow.guest()]),

  Settings: a.model({
    name: a.string(),
    value: a.string(),
  })
    .authorization((allow) => [allow.owner(), allow.authenticated()]),
});
