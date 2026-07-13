#!/usr/bin/env tsx
// Invoke the deployed AgentCore harness from the command line.
//
// Usage:
//   npx tsx scripts/invoke.ts "Your prompt here"
//
// Auth credentials are read from scripts/.env.local (TEST_USER_EMAIL / TEST_USER_PASSWORD).
// Harness ARN is read from web/amplify_outputs.json (custom.agentcore_harness_arn).
//
// MyHarness authorizes with AWS_IAM, so we sign the request with SigV4: log in
// as the test user to get a Cognito ID token, exchange it for Identity Pool
// credentials, and let the SDK's InvokeHarnessCommand sign + stream. (The pool's
// authenticated role is granted bedrock-agentcore:InvokeHarness in backend.ts.)
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env.local
const envPath = resolve(root, 'scripts/.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const email = env.TEST_USER_EMAIL;
const password = env.TEST_USER_PASSWORD;
if (!email || !password) {
  console.error('Missing TEST_USER_EMAIL or TEST_USER_PASSWORD in scripts/.env.local');
  process.exit(1);
}

// Load Cognito config
const amplifyOutputs = JSON.parse(readFileSync(resolve(root, 'web/amplify_outputs.json'), 'utf8'));
const { user_pool_id: userPoolId, user_pool_client_id: clientId, identity_pool_id: identityPoolId, aws_region: authRegion } = amplifyOutputs.auth;

// Load harness ARN
const harnessArn: string = amplifyOutputs.custom?.agentcore_harness_arn;
if (!harnessArn) {
  console.error('No harness ARN in web/amplify_outputs.json (custom.agentcore_harness_arn) — run `pnpm deploy` first');
  process.exit(1);
}
const region = harnessArn.split(':')[3];

// Authenticate — get an ID token to exchange for Identity Pool credentials.
const cognito = new CognitoIdentityProviderClient({ region: authRegion });
const authResult = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }),
);
const idToken = authResult.AuthenticationResult?.IdToken;
if (!idToken) {
  console.error('Authentication failed — no ID token returned');
  process.exit(1);
}

// Exchange the ID token for temporary SigV4 credentials via the Identity Pool.
const cognitoLogin = `cognito-idp.${authRegion}.amazonaws.com/${userPoolId}`;
const credentials = fromCognitoIdentityPool({
  clientConfig: { region: authRegion },
  identityPoolId,
  logins: { [cognitoLogin]: idToken as string },
});

// Build message from CLI args
const text = process.argv.slice(2).join(' ') || 'Hello!';
console.log(`Prompt: ${text}\n`);

// Invoke harness — the SDK signs with SigV4 and decodes the event stream.
const agentCore = new BedrockAgentCoreClient({ region, credentials });
const response = await agentCore.send(
  new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: randomUUID(),
    messages: [{ role: 'user', content: [{ text }] }],
  }),
);

for await (const event of response.stream ?? []) {
  if (event.validationException || event.internalServerException || event.runtimeClientError) {
    const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
    console.error(`\nHarness stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    process.exit(1);
  }
  const delta = event.contentBlockDelta?.delta?.text;
  if (delta) process.stdout.write(delta);
}
process.stdout.write('\n');
