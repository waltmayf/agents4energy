import { a } from '@aws-amplify/backend';

/**
 * Chat Schema
 * Models for managing chat sessions. Message history is persisted in
 * AgentCore memory (see functions/list-session-messages), not DynamoDB.
 */
export const chatSchema = a.schema({
  
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
