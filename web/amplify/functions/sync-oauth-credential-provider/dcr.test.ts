// Unit tests for the RFC 7591 Dynamic Client Registration helpers (#449).
// HTTP is mocked via an injected fetch, so these run offline with no AWS/network.
//
// Run: cd web && node --test --experimental-strip-types \
//   amplify/functions/sync-oauth-credential-provider/dcr.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRegistrationEndpoint,
  registerClient,
  deleteClientRegistration,
  type FetchLike,
} from './dcr.ts';

interface Call {
  url: string;
  init?: RequestInit;
}

// Minimal fetch stub: records calls and returns the queued Response.
function makeFetch(response: Response | ((call: Call) => Response)): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call: Call = { url: String(url), init };
    calls.push(call);
    return typeof response === 'function' ? response(call) : response;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('resolveRegistrationEndpoint returns the explicit endpoint without fetching', async () => {
  const { fetchImpl, calls } = makeFetch(jsonResponse(200, {}));
  const endpoint = await resolveRegistrationEndpoint({
    discoveryUrl: 'https://as.example.com/.well-known/openid-configuration',
    explicitEndpoint: 'https://as.example.com/oidc/register',
    fetchImpl,
  });
  assert.equal(endpoint, 'https://as.example.com/oidc/register');
  assert.equal(calls.length, 0, 'explicit endpoint must short-circuit discovery');
});

test('resolveRegistrationEndpoint reads registration_endpoint from the discovery doc', async () => {
  const { fetchImpl, calls } = makeFetch(
    jsonResponse(200, {
      issuer: 'https://as.example.com',
      registration_endpoint: 'https://as.example.com/oidc/register',
    }),
  );
  const endpoint = await resolveRegistrationEndpoint({
    discoveryUrl: 'https://as.example.com/.well-known/openid-configuration',
    fetchImpl,
  });
  assert.equal(endpoint, 'https://as.example.com/oidc/register');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://as.example.com/.well-known/openid-configuration');
});

test('resolveRegistrationEndpoint throws when the AS advertises no DCR endpoint', async () => {
  const { fetchImpl } = makeFetch(jsonResponse(200, { issuer: 'https://as.example.com' }));
  await assert.rejects(
    () => resolveRegistrationEndpoint({ discoveryUrl: 'https://as.example.com/.well-known/openid-configuration', fetchImpl }),
    /registration_endpoint/,
  );
});

test('resolveRegistrationEndpoint throws with neither endpoint nor discovery url', async () => {
  await assert.rejects(() => resolveRegistrationEndpoint({}), /oauthRegistrationEndpoint or oauthDiscoveryUrl/);
});

test('resolveRegistrationEndpoint throws on a non-OK discovery fetch', async () => {
  const { fetchImpl } = makeFetch(new Response('nope', { status: 404 }));
  await assert.rejects(
    () => resolveRegistrationEndpoint({ discoveryUrl: 'https://as.example.com/.well-known/openid-configuration', fetchImpl }),
    /discovery fetch failed: 404/,
  );
});

test('registerClient POSTs an RFC 7591 body and parses the response', async () => {
  const { fetchImpl, calls } = makeFetch(
    jsonResponse(201, {
      client_id: 'abc123',
      client_secret: 's3cr3t',
      registration_client_uri: 'https://as.example.com/oidc/register/abc123',
      registration_access_token: 'reg-tok',
    }),
  );
  const result = await registerClient({
    registrationEndpoint: 'https://as.example.com/oidc/register',
    request: {
      redirectUris: ['https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/uuid'],
      scope: 'openid profile',
      clientName: 'A4E Agent',
    },
    fetchImpl,
  });

  assert.equal(result.clientId, 'abc123');
  assert.equal(result.clientSecret, 's3cr3t');
  assert.equal(result.registrationClientUri, 'https://as.example.com/oidc/register/abc123');
  assert.equal(result.registrationAccessToken, 'reg-tok');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'POST');
  const sent = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(sent.redirect_uris, [
    'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/uuid',
  ]);
  assert.deepEqual(sent.grant_types, ['authorization_code']);
  assert.deepEqual(sent.response_types, ['code']);
  assert.equal(sent.scope, 'openid profile');
  assert.equal(sent.client_name, 'A4E Agent');
  assert.equal(sent.token_endpoint_auth_method, 'client_secret_post');
  // No initial access token => no Authorization header.
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test('registerClient attaches a Bearer initial access token when provided', async () => {
  const { fetchImpl, calls } = makeFetch(jsonResponse(201, { client_id: 'id' }));
  await registerClient({
    registrationEndpoint: 'https://as.example.com/oidc/register',
    request: { redirectUris: ['https://cb'] },
    initialAccessToken: 'iat-xyz',
    fetchImpl,
  });
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer iat-xyz');
});

test('registerClient throws on a non-2xx registration response', async () => {
  const { fetchImpl } = makeFetch(new Response('access denied', { status: 401 }));
  await assert.rejects(
    () =>
      registerClient({
        registrationEndpoint: 'https://as.example.com/oidc/register',
        request: { redirectUris: ['https://cb'] },
        fetchImpl,
      }),
    /registration failed: 401/,
  );
});

test('registerClient throws when the response omits client_id', async () => {
  const { fetchImpl } = makeFetch(jsonResponse(201, { client_secret: 'only-secret' }));
  await assert.rejects(
    () =>
      registerClient({
        registrationEndpoint: 'https://as.example.com/oidc/register',
        request: { redirectUris: ['https://cb'] },
        fetchImpl,
      }),
    /missing client_id/,
  );
});

test('deleteClientRegistration issues an authenticated DELETE (RFC 7592)', async () => {
  const { fetchImpl, calls } = makeFetch(new Response(null, { status: 204 }));
  await deleteClientRegistration({
    registrationClientUri: 'https://as.example.com/oidc/register/abc123',
    registrationAccessToken: 'reg-tok',
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://as.example.com/oidc/register/abc123');
  assert.equal(calls[0].init?.method, 'DELETE');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer reg-tok');
});
