import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { invokeAgent } from '../functions/invoke-agent/resource';
import { writeActiveRun } from '../functions/write-active-run/resource';

// Import modular schemas
import { chatSchema } from './schemas/chat.schema';
import { agentcoreMemorySchema } from './schemas/agentcoreMemory.schema';
import { agentConfigSchema } from './schemas/agentConfig.schema';
import { githubSchema } from './schemas/github.schema';

// Grant the invoke-agent Lambda function read access to the agent config models.
// allow.resource() must be applied to an individual schema, not a.combine().
const agentConfigSchemaWithFunctionAccess = agentConfigSchema.authorization((allow) => [
  allow.resource(invokeAgent).to(['query']),
]);

// Grant the write-active-run Lambda function create/update/delete access to
// the chat schema's models (it only touches ActiveRun). Slice A of #15's
// server-side producer — nothing invokes this function yet.
const chatSchemaWithFunctionAccess = chatSchema.authorization((allow) => [
  allow.resource(writeActiveRun).to(['mutate']),
]);

// Combine all schemas
const schema = a.combine([
  chatSchemaWithFunctionAccess,
  agentcoreMemorySchema,
  agentConfigSchemaWithFunctionAccess,
  githubSchema,
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});