// RFC 7591 Dynamic Client Registration + OIDC discovery helpers (issue #449).
//
// Deliberately dependency-free (no AWS SDK, no sibling runtime imports) so the
// HTTP/registration logic can be unit-tested against a mocked `fetch` in
// isolation, and so handler.ts can import it with an extensionless specifier
// (amplify/tsconfig has no `allowImportingTsExtensions`) while the test imports
// it with a `.ts` extension (required by `node --test --experimental-strip-types`).

export type FetchLike = typeof fetch;

export interface RegistrationRequest {
  /** Redirect URIs to register — for the 3LO flow this is AgentCore's callbackUrl. */
  redirectUris: string[];
  /** Defaults to ['authorization_code']. */
  grantTypes?: string[];
  /** Space-delimited scope string. Omitted from the request when empty. */
  scope?: string;
  /** RFC 7591 `client_name`. */
  clientName?: string;
  /** RFC 7591 `software_statement` (signed JWT). */
  softwareStatement?: string;
  /** RFC 7591 `token_endpoint_auth_method`. Defaults to 'client_secret_post'. */
  tokenEndpointAuthMethod?: string;
}

export interface RegistrationResult {
  clientId: string;
  clientSecret?: string;
  /** RFC 7592 management URI for later update/delete of this registration. */
  registrationClientUri?: string;
  /** RFC 7592 bearer token authorizing calls to registrationClientUri. */
  registrationAccessToken?: string;
  /** The full parsed response, for callers that need extra fields. */
  raw: Record<string, unknown>;
}

/**
 * Resolve the RFC 7591 registration endpoint. Prefers an explicitly-configured
 * endpoint; otherwise fetches the OIDC discovery document and reads
 * `registration_endpoint`. Throws if neither is available (the AS does not
 * advertise DCR).
 */
export async function resolveRegistrationEndpoint(opts: {
  discoveryUrl?: string;
  explicitEndpoint?: string;
  fetchImpl?: FetchLike;
}): Promise<string> {
  if (opts.explicitEndpoint) return opts.explicitEndpoint;
  if (!opts.discoveryUrl) {
    throw new Error('DCR requires either oauthRegistrationEndpoint or oauthDiscoveryUrl');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.discoveryUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`OIDC discovery fetch failed: ${res.status} for ${opts.discoveryUrl}`);
  }
  const doc = (await res.json()) as { registration_endpoint?: string };
  if (!doc.registration_endpoint) {
    throw new Error(
      'OIDC discovery document has no registration_endpoint — the authorization server does not support RFC 7591 DCR',
    );
  }
  return doc.registration_endpoint;
}

/**
 * POST an RFC 7591 client registration request and parse the response.
 * Attaches `Authorization: Bearer <initialAccessToken>` when provided.
 */
export async function registerClient(opts: {
  registrationEndpoint: string;
  request: RegistrationRequest;
  initialAccessToken?: string;
  fetchImpl?: FetchLike;
}): Promise<RegistrationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    redirect_uris: opts.request.redirectUris,
    grant_types: opts.request.grantTypes ?? ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: opts.request.tokenEndpointAuthMethod ?? 'client_secret_post',
  };
  if (opts.request.scope) body.scope = opts.request.scope;
  if (opts.request.clientName) body.client_name = opts.request.clientName;
  if (opts.request.softwareStatement) body.software_statement = opts.request.softwareStatement;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.initialAccessToken) headers.Authorization = `Bearer ${opts.initialAccessToken}`;

  const res = await fetchImpl(opts.registrationEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // RFC 7591 mandates 201 Created; tolerate 200 for lenient servers.
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`RFC 7591 registration failed: ${res.status} ${text.slice(0, 500)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('RFC 7591 registration returned a non-JSON body');
  }
  const clientId = parsed.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('RFC 7591 registration response is missing client_id');
  }
  return {
    clientId,
    clientSecret: typeof parsed.client_secret === 'string' ? parsed.client_secret : undefined,
    registrationClientUri:
      typeof parsed.registration_client_uri === 'string' ? parsed.registration_client_uri : undefined,
    registrationAccessToken:
      typeof parsed.registration_access_token === 'string' ? parsed.registration_access_token : undefined,
    raw: parsed,
  };
}

/**
 * Best-effort RFC 7592 DELETE of a dynamic registration. Never throws — callers
 * use this on row teardown and must not block deletion on the AS being reachable.
 */
export async function deleteClientRegistration(opts: {
  registrationClientUri: string;
  registrationAccessToken?: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (opts.registrationAccessToken) headers.Authorization = `Bearer ${opts.registrationAccessToken}`;
  await fetchImpl(opts.registrationClientUri, { method: 'DELETE', headers });
}
