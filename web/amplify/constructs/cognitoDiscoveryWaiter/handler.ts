import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

// The MCP Gateway's AgentCredentialProvider validates its JWT authorizer by
// fetching the Cognito user pool's OpenID discovery document
// (`/.well-known/openid-configuration`) at create time. On a brand-new user
// pool that endpoint is not immediately live — CloudFormation reports the pool
// CREATE_COMPLETE, but the public discovery URL can still return HTTP 400/404
// for a short window while it propagates. When the gateway is created in the
// same deployment as the pool (every first-ever branch/sandbox deploy), it
// races that window and fails to stabilize:
//
//   Failed to create gateway dependencies: Failed to fetch discovery document
//   from: https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/openid-configuration
//   (Service: AgentCredentialProvider, Status Code: 400) … HandlerErrorCode: NotStabilized
//
// which rolls back the entire agent stack. `main` never hit this because its
// pool already existed from a prior deploy. This custom resource polls the
// discovery URL until it returns 200, so a `node.addDependency` from the
// AgentCore app makes the gateway wait until the endpoint is actually live.

interface ResourceProperties {
  DiscoveryUrl: string;
}

const MAX_ATTEMPTS = 40; // ~40 * 3s ≈ 2 min, well under the CR Lambda timeout
const DELAY_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDiscoveryDoc(url: string): Promise<void> {
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'GET' });
      lastStatus = res.status;
      if (res.ok) {
        // Confirm it parses as the expected OIDC document, not an error body
        // served with a 200.
        const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
        if (doc.issuer && doc.jwks_uri) {
          console.log(`Discovery document live after ${attempt} attempt(s): ${url}`);
          return;
        }
        lastError = 'response missing issuer/jwks_uri';
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(DELAY_MS);
  }
  throw new Error(
    `Cognito discovery document at ${url} not live after ${MAX_ATTEMPTS} attempts ` +
      `(last HTTP ${lastStatus}${lastError ? `, ${lastError}` : ''})`,
  );
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  // Only the discovery endpoint's readiness matters, and only on create/update.
  // Delete is a no-op (nothing to tear down).
  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    await waitForDiscoveryDoc(props.DiscoveryUrl);
  }

  return { PhysicalResourceId: `cognito-discovery-waiter:${props.DiscoveryUrl}` };
};
