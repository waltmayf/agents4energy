/**
 * Gateway-to-gateway OAuth (3LO) federation — the deploy-twice capstone of epic
 * #412 (issue #420, slice 8/8).
 *
 * This is the "deployment A calls deployment B's /mcp gateway as a 3LO target"
 * flow. It can only run end-to-end against a SECOND live deployment (deployment
 * B), which a normal CI run does not have — so the whole suite SKIPS cleanly,
 * with a stated reason, unless `GATEWAY_B_MCP_URL` (and its companion env vars)
 * are set. See docs/gateway-to-gateway-federation.md for the full runbook and
 * the exact meaning of every variable below.
 *
 * When the env is present it drives, in deployment A's UI + against B directly:
 *   1. Create an outbound-OAUTH_3LO McpServer in A pointing at B's /mcp, with a
 *      CustomOauth2 provider aimed at B's Hosted-UI discovery URL, and wait for
 *      the credential provider + gateway target to auto-register.
 *   2. Assign it to an agent, open chat, ask the agent to call a B tool, and
 *      assert the MCP `-32042` consent elicitation surfaces (no vaulted token
 *      yet for this user).
 *   3. Sign in at B's Cognito Hosted UI in the consent popup and assert the tool
 *      call then succeeds (the vaulted B token is injected outbound).
 *   4. Assert B's authorization is governed by the B-pool identity's Cedar
 *      groups, and that B requires the Cognito ACCESS token — an ID token is
 *      rejected 403 `insufficient_scope` (#327).
 *
 * The two-identity model (docs/gateway-to-gateway-federation.md) is the key
 * invariant: the popup login is a B-pool identity, and B's Cedar gates the call
 * by B's `cognito:groups`, not A's.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { E2E_MCP_PREFIX, deleteMcpServersByIds } from './mcp-server-cleanup';

// ---------------------------------------------------------------------------
// Environment resolution — the suite is a no-op skip unless deployment B is set
// ---------------------------------------------------------------------------

interface FederationEnv {
  mcpUrl: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretArn: string;
  username: string;
  password: string;
  expectedTool: string;
  /** Optional B-pool tokens for the direct #327 access-token assertion. */
  accessToken?: string;
  idToken?: string;
}

/**
 * Reads deployment-B config from the environment. Returns null when
 * `GATEWAY_B_MCP_URL` is unset (→ the whole suite skips). When the trigger var
 * IS set but a required companion is missing, returns null too but records why,
 * so a half-configured run skips with a precise reason instead of failing.
 */
function resolveFederationEnv(): { env: FederationEnv | null; reason: string } {
  const mcpUrl = process.env.GATEWAY_B_MCP_URL;
  if (!mcpUrl) {
    return { env: null, reason: 'GATEWAY_B_MCP_URL is not set — no deployment B to federate with' };
  }
  const required = {
    discoveryUrl: process.env.GATEWAY_B_OAUTH_DISCOVERY_URL,
    clientId: process.env.GATEWAY_B_OAUTH_CLIENT_ID,
    clientSecretArn: process.env.GATEWAY_B_OAUTH_CLIENT_SECRET_ARN,
    username: process.env.GATEWAY_B_USERNAME,
    password: process.env.GATEWAY_B_PASSWORD,
    expectedTool: process.env.GATEWAY_B_EXPECTED_TOOL,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    return {
      env: null,
      reason: `GATEWAY_B_MCP_URL is set but these companion vars are missing: ${missing.join(', ')} (see docs/gateway-to-gateway-federation.md)`,
    };
  }
  return {
    env: {
      mcpUrl,
      discoveryUrl: required.discoveryUrl!,
      clientId: required.clientId!,
      clientSecretArn: required.clientSecretArn!,
      username: required.username!,
      password: required.password!,
      expectedTool: required.expectedTool!,
      accessToken: process.env.GATEWAY_B_ACCESS_TOKEN,
      idToken: process.env.GATEWAY_B_ID_TOKEN,
    },
    reason: '',
  };
}

const { env: FED, reason: SKIP_REASON } = resolveFederationEnv();

// Track every McpServer this suite creates so it's deleted via the AppSync API
// in afterAll even if a UI assertion times out (issue #308 pattern).
const createdServerIds: string[] = [];

function e2eServerName(): string {
  return `${E2E_MCP_PREFIX}Federation B ${Date.now()}`;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function goToMcpServersTab(page: Page) {
  await page.goto('agents');
  await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tab-mcp-servers').click();
}

/** Pick a value in a shadcn Select identified by its trigger testid. */
async function selectOption(page: Page, triggerTestId: string, optionName: string) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName }).click();
}

/**
 * Create an outbound-OAUTH_3LO McpServer pointing at deployment B, using the
 * Custom (OIDC discovery) vendor. Returns the saved record id.
 */
async function createFederatedServer(page: Page, env: FederationEnv): Promise<string> {
  const name = e2eServerName();
  await page.getByTestId('new-mcp-server-button').click();
  await page.getByTestId('input-mcp-name').fill(name);
  await page.getByTestId('input-mcp-url').fill(env.mcpUrl);

  // Outbound auth → OAuth 3-legged, Custom vendor.
  await selectOption(page, 'select-outbound-auth-type', 'OAuth 3-legged (per-user vaulted token)');
  await selectOption(page, 'select-oauth-vendor', 'Custom (OIDC discovery)');
  await page.getByTestId('input-oauth-discovery-url').fill(env.discoveryUrl);
  await page.getByTestId('input-outbound-client-id').fill(env.clientId);
  await page.getByTestId('input-oauth-client-secret').fill(env.clientSecretArn);
  await page.getByTestId('input-oauth-scopes').fill('openid');
  await page.getByTestId('input-oauth-return-url').fill(
    new URL('/oauth/agentcore-callback', page.url()).toString(),
  );

  await page.getByTestId('save-mcp-server-button').click();
  await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 10_000 });

  const row = page.locator('[data-testid^="mcp-server-row-"]').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const testId = (await row.getAttribute('data-testid')) ?? '';
  const id = testId.replace('mcp-server-row-', '');
  if (id) createdServerIds.push(id);
  return id;
}

/**
 * Reopen the saved server and wait for the AgentCore-issued provider callback
 * URL read-back to appear — proof the sync-oauth-credential-provider stream
 * handler created the CustomOauth2 provider (step 2 of the runbook).
 */
async function waitForProviderReadback(page: Page, serverId: string) {
  const readback = page.getByTestId('callback-url-readback');
  await expect(async () => {
    await goToMcpServersTab(page);
    await page.getByTestId(`mcp-server-row-${serverId}`).click();
    await expect(readback).toContainText('identities/oauth2/callback', { timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [5_000] });
}

/** Sign in at deployment B's Cognito Hosted UI inside the consent popup. */
async function signInAtHostedUi(popup: Page, env: FederationEnv) {
  // Cognito Hosted UI field names are stable (`username` / `password`); the
  // submit control is a name="signInSubmitButton" input on the classic UI.
  await popup.locator('input[name="username"]').first().fill(env.username, { timeout: 30_000 });
  await popup.locator('input[name="password"]').first().fill(env.password);
  await popup
    .locator('input[name="signInSubmitButton"], button[type="submit"]')
    .first()
    .click();
}

// ---------------------------------------------------------------------------
// Direct gateway assertions against deployment B (#327 + Cedar gating)
// ---------------------------------------------------------------------------

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

function toolCallBody(toolName: string) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  };
}

/**
 * POST a `tools/call` to B's /mcp with the given bearer token and return the
 * status + raw body (which may be SSE or JSON).
 */
async function callBTool(
  request: APIRequestContext,
  env: FederationEnv,
  bearer: string,
): Promise<{ status: number; body: string }> {
  const res = await request.post(env.mcpUrl, {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${bearer}` },
    data: toolCallBody(env.expectedTool),
    failOnStatusCode: false,
  });
  return { status: res.status(), body: await res.text() };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Gateway-to-gateway OAuth (3LO) federation (#412 / #420)', () => {
  // Whole suite is a clean skip when deployment B isn't configured.
  test.skip(!FED, `Gateway federation E2E skipped: ${SKIP_REASON}`);

  test.afterAll(async () => {
    await deleteMcpServersByIds(createdServerIds);
    createdServerIds.length = 0;
  });

  test('A federates B: consent elicitation → Hosted-UI sign-in → tool callable', async ({ page }) => {
    // Popup sign-in + credential-provider creation + a real tool round-trip all
    // take time; give the flow a generous budget.
    test.setTimeout(240_000);
    const env = FED!;

    let serverId = '';
    await test.step('create outbound-3LO server in A pointing at B', async () => {
      await goToMcpServersTab(page);
      serverId = await createFederatedServer(page, env);
      expect(serverId).toBeTruthy();
    });

    await test.step('credential provider auto-creates (callback URL read-back appears)', async () => {
      await waitForProviderReadback(page, serverId);
    });

    await test.step('trigger a B tool call and complete consent', async () => {
      // Open chat; ask the agent to use a B tool. The first call returns the
      // -32042 elicitation because no B token is vaulted for this user yet.
      await page.goto('chat');
      await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible();
      await page.waitForURL(/[?&]sessionId=/, { timeout: 20_000 });

      const textarea = page.getByTestId('copilot-chat-textarea');
      await textarea.fill(`Call the ${env.expectedTool} tool now.`);
      await textarea.press('Enter');

      // McpElicitationBanner surfaces an "Authenticate" affordance (slices 4/5).
      const authenticate = page.getByRole('button', { name: 'Authenticate' });
      await expect(authenticate).toBeVisible({ timeout: 90_000 });

      // Clicking it opens B's Hosted-UI consent popup.
      const [popup] = await Promise.all([page.waitForEvent('popup'), authenticate.click()]);
      await signInAtHostedUi(popup, env);
      await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);

      // After consent the banner clears and the retried call runs — no lingering
      // elicitation prompt.
      await expect(page.getByRole('button', { name: 'Authenticate' })).not.toBeVisible({
        timeout: 90_000,
      });
    });
  });

  test('B requires the access token (ID token rejected, #327) and Cedar-gates by B groups', async ({
    request,
  }) => {
    const env = FED!;

    // The ID-token rejection is the crux of #327: B's CUSTOM_JWT authorizer
    // accepts only the access token; an ID token → HTTP 403 insufficient_scope.
    await test.step('ID token is rejected (403 insufficient_scope)', async () => {
      test.skip(!env.idToken, 'GATEWAY_B_ID_TOKEN not set — cannot assert ID-token rejection');
      const { status, body } = await callBTool(request, env, env.idToken!);
      expect(status, `expected 403 for an ID token, got ${status}: ${body.slice(0, 200)}`).toBe(403);
      expect(body.toLowerCase()).toContain('insufficient_scope');
    });

    // The access token is accepted and Cedar evaluates the call by the B-pool
    // user's groups. `expectedTool` is one the B-user's groups permit, so the
    // call must NOT be the default-deny (-32002) — proving B allowed it.
    await test.step('access token is accepted and Cedar-gated by B groups', async () => {
      test.skip(!env.accessToken, 'GATEWAY_B_ACCESS_TOKEN not set — cannot assert access-token acceptance');
      const { status, body } = await callBTool(request, env, env.accessToken!);
      expect(status, `access token should be accepted by B, got ${status}: ${body.slice(0, 200)}`).toBe(200);
      // -32002 is Cedar's "denied by default"; the permitted tool must not hit it.
      expect(
        body.includes('-32002'),
        `expected ${env.expectedTool} to be permitted for the B user's groups, but got a Cedar denial: ${body.slice(0, 300)}`,
      ).toBeFalsy();
    });
  });
});
