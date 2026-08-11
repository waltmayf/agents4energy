/**
 * Regression test for issue #328: the AgentCore gateway's OAuth discovery
 * chain must resolve end-to-end to a usable Cognito Hosted-UI authorize
 * endpoint on every deployment.
 *
 * Background: a gateway's CUSTOM_JWT `discoveryUrl` / `allowedClients` are read
 * by CloudFormation only when the gateway is first CREATED — an already-existing
 * gateway is never re-read (see the #128 note in web/amplify/backend.ts). On the
 * long-lived `main` deployment that left the gateway frozen on a Cognito user
 * pool that had since been deleted. Its `.well-known/oauth-protected-resource`
 * still advertised that dead pool as the authorization server, so:
 *   - the pool's OIDC document 404'd ("User pool ... does not exist"), and
 *   - MCP clients that derive the authorize URL from the issuer ORIGIN fell back
 *     to `https://cognito-idp.<region>.amazonaws.com/authorize` — the Cognito
 *     control-plane API, which has no /authorize op → `BadRequest`.
 *
 * This test walks the same discovery chain the real client uses
 * (web/lib/mcp-auth.ts `discover()`) against the *deployed* gateway and asserts
 * the two invariants that were violated:
 *   1. The advertised authorization server's OIDC document resolves (HTTP 200).
 *   2. Its `authorization_endpoint` is a Cognito Hosted-UI domain
 *      (`*.auth.<region>.amazoncognito.com/oauth2/authorize`), NOT the
 *      `cognito-idp.*` control-plane origin.
 *
 * A frozen/deleted-pool gateway fails invariant 1 (OIDC 404); a gateway with no
 * hosted-UI domain configured fails invariant 2. Both are the #328 failure mode.
 *
 * Gateway URLs are read straight from AppSync (SigV4-signed) rather than scraped
 * from the UI, so the assertion runs against the real deployed gateway instead
 * of vacuously skipping when the UI row isn't rendered.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { listGatewayMcpServerUrls } from './mcp-server-cleanup';

/** Strip a trailing slash so `${base}/.well-known/...` never doubles up. */
function trimSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

/**
 * Walk the discover() chain for one gateway URL and assert the #328 invariants.
 * `request` is Playwright's API context (no auth needed — these are the
 * unauthenticated .well-known endpoints).
 */
async function assertHostedUiDiscovery(request: APIRequestContext, gatewayUrl: string) {
  const origin = new URL(gatewayUrl).origin;

  // --- RFC 9728: protected-resource metadata names the authorization server ---
  const prRes = await request.get(`${origin}/.well-known/oauth-protected-resource`);
  expect(prRes.ok(), `oauth-protected-resource fetch failed (HTTP ${prRes.status()}) for ${origin}`).toBeTruthy();
  const prData = (await prRes.json()) as { authorization_servers?: string[] };
  const asUrl = prData.authorization_servers?.[0];
  expect(asUrl, `no authorization_servers advertised by ${origin}`).toBeTruthy();

  // --- OIDC discovery: this is the hop that 404'd on the deleted pool (#328) ---
  const asOrigin = trimSlash(asUrl!);
  const oidcRes = await request.get(`${asOrigin}/.well-known/openid-configuration`);
  expect(
    oidcRes.ok(),
    `authorization server OIDC doc did not resolve (HTTP ${oidcRes.status()}) for ${asOrigin} — ` +
      `the gateway is likely frozen on a deleted Cognito pool (see #328/#128)`,
  ).toBeTruthy();

  const oidc = (await oidcRes.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
  };
  expect(oidc.authorization_endpoint, `OIDC doc missing authorization_endpoint at ${asOrigin}`).toBeTruthy();
  expect(oidc.token_endpoint, `OIDC doc missing token_endpoint at ${asOrigin}`).toBeTruthy();

  // --- The core #328 assertion: authorize must live on the Hosted-UI domain ---
  const authorizeHost = new URL(oidc.authorization_endpoint!).host;
  // The control-plane API host is exactly where the broken flow ended up.
  expect(
    authorizeHost.startsWith('cognito-idp.'),
    `authorization_endpoint points at the Cognito control-plane host (${authorizeHost}); ` +
      `no Hosted-UI domain is wired up — clients will hit .../authorize and get BadRequest (#328)`,
  ).toBeFalsy();
  expect(
    authorizeHost.endsWith('.amazoncognito.com'),
    `expected a Cognito Hosted-UI domain (*.auth.<region>.amazoncognito.com), got ${authorizeHost}`,
  ).toBeTruthy();
  expect(new URL(oidc.authorization_endpoint!).pathname).toBe('/oauth2/authorize');

  // --- Belt-and-braces: the authorize endpoint actually answers (not 404) ---
  // A bare GET without OAuth params returns the Hosted-UI login page (200), a
  // redirect (302/303), or a 400 "invalid_request"; any of those proves the
  // endpoint EXISTS. The regression produced a JSON BadRequest from the
  // control-plane API instead.
  const probe = await request.get(oidc.authorization_endpoint!, { maxRedirects: 0 });
  expect(
    [200, 302, 303, 400].includes(probe.status()),
    `authorize endpoint returned unexpected HTTP ${probe.status()} — expected a Hosted-UI response`,
  ).toBeTruthy();
}

test.describe('MCP gateway OAuth discovery (#328)', () => {
  test('every deployed gateway advertises a Hosted-UI authorize endpoint, not the control-plane origin', async ({
    request,
  }) => {
    const gatewayUrls = await listGatewayMcpServerUrls();
    test.skip(gatewayUrls.length === 0, 'No AgentCore gateway MCP server configured in this environment');

    for (const url of gatewayUrls) {
      await test.step(`discovery chain for ${new URL(url).host}`, async () => {
        await assertHostedUiDiscovery(request, url);
      });
    }
  });
});
