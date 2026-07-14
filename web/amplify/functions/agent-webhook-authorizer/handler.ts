import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';

// GitHub's signature format: `sha256=<64 lowercase hex chars>` — see
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const GITHUB_SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

// HTTP API REQUEST authorizer in front of agent-webhook-receiver (issue #83):
// a fast signature-FORMAT gate so the route can be AuthorizationType.CUSTOM
// instead of NONE. It can't verify the HMAC itself — Lambda authorizers never
// receive the request body, and GitHub's HMAC is computed over the raw body
// (see the AWS "Sending and receiving webhooks" reference architecture) — so
// the real cryptographic check stays in the receiver Lambda
// (crypto.timingSafeEqual against the shared secret). Non-GitHub requests
// (Jira, whose auth is a query-param shared secret checked by the receiver)
// pass this gate unconditionally. Caching is disabled on the CDK authorizer
// construct (TTL=0) since every payload has a unique signature.
export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> => {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  const isGithub = headers['x-github-event'] !== undefined || headers['x-hub-signature-256'] !== undefined;
  if (!isGithub) {
    return { isAuthorized: true };
  }

  const signature = headers['x-hub-signature-256'];
  return { isAuthorized: typeof signature === 'string' && GITHUB_SIGNATURE_RE.test(signature) };
};
