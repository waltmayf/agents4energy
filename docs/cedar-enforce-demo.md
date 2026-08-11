# Cedar ENFORCE demo — a real gateway tool DENY → ALLOW

This is a captured, live demonstration that `default-gateway`'s Cedar policy
engine runs in **`ENFORCE`** mode (#280): the *same* user calling the *same*
tool is **denied** with no matching grant and **allowed** the moment an admin
adds one `GroupToolGrant` row — with nothing else changing. It also documents
the two bugs that made ENFORCE silently deny *everything* until #325 fixed them.

If you just want the model (data model, admin UI, generation, sync), read
[`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md) first — this doc is
the evidence, plus the gotchas you need to reproduce it.

## TL;DR

| Step | Grant present? | `tools/call s3-tools-web-main-sandbox___ReadFile` | Verdict |
|---|---|---|---|
| 1 | none | JSON-RPC `-32002` "Tool Execution Denied … policy enforcement [No policy applies to the request (denied by default).]" | **DENY** |
| 2 | admin creates `ALLOW reservoir-eng → S3.ReadFile` | sync Lambda pushes a Cedar policy; it reaches `ACTIVE` within ~10s | — |
| 3 | active | `{"result":{"isError":false,"content":[{"type":"text","text":"{\"error\":\"File not found: \\\"README.md\\\"\"}"}]}}` | **ALLOW** |

The ALLOW response is the *tool's own* output — a tool-level "File not found" for
a path that doesn't exist. That still proves **ALLOW at the authorization
layer**: Cedar let the call through to the target Lambda. Deleting the grant
tears the policy back down (`list-policies` → `[]`), and step 1's DENY returns.

## Reproducing it

The scripted version is [`scripts/cedar-enforce-demo.ts`](../scripts/cedar-enforce-demo.ts)
(`npx tsx scripts/cedar-enforce-demo.ts`). It authenticates a test user, probes
the tool (DENY), creates the grant, polls the policy to `ACTIVE`, re-probes
(ALLOW), and cleans up. The manual `curl` path below is what the transcript
above was captured with — useful when the poll timing or a fresh sandbox
recreate throws the script off.

```bash
# 1. Access token for a user in a Cognito group (NOT the ID token — see gotchas).
ACCESS_TOKEN=$(...InitiateAuth USER_PASSWORD_AUTH... .AuthenticationResult.AccessToken)

# 2. The fully-qualified gateway tool name is <targetName>___<tool>. Resolve the
#    target name from the McpServer's gatewayTargetId:
aws bedrock-agentcore-control list-gateway-targets \
  --gateway-identifier <gatewayId> \
  --query "items[?targetId=='<gatewayTargetId>'].name" --output text
# → s3-tools-web-main-sandbox

# 3. Call the tool. -32002 = DENY; a `result` = ALLOW.
curl -s -X POST "$GATEWAY_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"s3-tools-web-main-sandbox___ReadFile",
                 "arguments":{"path":"README.md"}}}'

# 4. Add / remove the grant via the admin GraphQL path (SigV4/IAM):
./scripts/graphql.sh \
  'mutation C($i:CreateGroupToolGrantInput!){createGroupToolGrant(input:$i){id}}' \
  '{"i":{"group":"reservoir-eng","mcpServerId":"<id>","toolName":"ReadFile","effect":"ALLOW"}}'

# 5. Watch the generated policy converge:
aws bedrock-agentcore-control list-policies --policy-engine-id <engineId> \
  --query "policies[?starts_with(name,'Grant_')].{name:name,status:status}"
```

## The ACTIVE policy the sync produced

Dumped straight from the engine — it matches `web/lib/cedar-policy-generation.ts`
byte-for-byte:

```cedar
permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"s3-tools-web-main-sandbox___ReadFile",
  resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:796988593450:gateway/default-default-gateway-web-main-sandbox-fnkvv5zxsr"
) when {
  principal.hasTag("cognito:groups") && principal.getTag("cognito:groups") like "*\"reservoir-eng\"*"
};
```

## The two bugs #325 fixed (why ENFORCE denied *everything* first)

Flipping the engine to `ENFORCE` initially denied every call even *with* a
matching ALLOW grant, because the generated policy never reached `ACTIVE`. Two
independent root causes, both confirmed live:

### 1. `cognito:groups` is a String tag, not a Cedar `Set`

The gateway's `CUSTOM_JWT` authorizer surfaces every JWT claim as a **tag** on
the `AgentCore::OAuthUser` principal. Cognito's `cognito:groups` is a JSON array
(`["reservoir-eng"]`), but AgentCore surfaces the tag as the **JSON string of
that array**, *not* as a `Set<String>`. So the natural-looking
`principal.getTag("cognito:groups").contains("reservoir-eng")` — a Set op — is
rejected at policy validation (`expected Set<...> but saw String`); the policy
lands `CREATE_FAILED`/`UPDATE_FAILED`, never goes `ACTIVE`, and ENFORCE denies by
default.

**Fix** (`web/lib/cedar-policy-generation.ts`): a **string** `like` on the group
wrapped in its surrounding JSON quotes —
`principal.getTag("cognito:groups") like "*\"reservoir-eng\"*"`. The quotes are
the delimiter, so `reservoir-eng` matches a distinct array element and cannot
spuriously match `reservoir-engineering`. (Cognito group names allow only
`A-Za-z0-9+=,.@_-`, none of which are Cedar `like` metacharacters, so no further
escaping is needed.)

### 2. The sync Lambda's role needs `ListGatewayTargets` + `InvokeGateway`

Once the statement was valid, `CreatePolicy`/`UpdatePolicy` *still* failed. Cedar
**synchronously validates** each policy whose `action` is target-scoped
(`AgentCore::Action::"<target>___<tool>"`) at create/update time — and it does so
under the **sync Lambda's own calling principal**, not the gateway execution
role. CloudTrail confirmed the `AccessDenied` was on
`…/SyncCedarPoliciesHandler-…`, not the gateway role. Validation:

1. resolves the action name against the gateway's registered targets →
   needs `bedrock-agentcore:ListGatewayTargets` (without it:
   *"Insufficient permissions to list targets on gateway …"*), then
2. confirms it can reach the gateway →
   needs `bedrock-agentcore:InvokeGateway` (with only #1:
   *"Insufficient permissions to call gateway …"*).

> `InvokeGateway` is the correct action — `CallGateway` is **not** a real action
> and keeps failing.

**Fix** (`web/amplify/constructs/syncCedarPolicies.ts`): both actions granted on
the sync Lambda's role, scoped to the gateway ARN. An earlier attempt to grant
`ListGatewayTargets` to the *gateway execution* role from `backend.ts` was wrong
(CloudTrail pointed at the Lambda role) and was removed. **IAM propagation lag:**
AgentCore caches the role's permissions; after this grant lands, allow ~45–60s
before a re-triggered sync sees it (short waits produced false failures during
testing — but on a clean deploy the policy reached `ACTIVE` within ~10s).

## Gotchas worth repeating

- **Use the ACCESS token, not the ID token.** The `CUSTOM_JWT` authorizer 403s
  the ID token with `insufficient_scope` *before* Cedar even runs. The access
  token carries `scope: aws.cognito.signin.user.admin`; both tokens carry
  `cognito:groups`. (The frontend forwarding the wrong token is tracked in #327.)
- **The authoritative signal is a real `tools/call`, not `tools/list`.**
  `tools/list` is not Cedar-gated per-tool — it returns `200 {tools:[…]}`
  regardless. Only `tools/call` returns the `-32002` policy-enforcement DENY.
- **A wedged policy stays wedged.** If a policy is stuck in `UPDATE_FAILED`,
  re-triggering the sync only re-runs `UpdatePolicy` on it. Delete the grant
  (which deletes the policy) and re-create it to force a clean `CreatePolicy`.
- **`gatewayTargetId` can be null after a fresh recreate.** The seeded S3 /
  graph-traverse targets are registered via CDK custom resources, and the value
  isn't always written back onto the `McpServer` record. The sync skips grants
  whose server has no resolvable `gatewayTargetId`, so link it before demoing.

## Key identifiers (main sandbox, at capture time)

| Thing | Value |
|---|---|
| Policy engine | `default_web_mainsandbox_DefaultCedar-8himebbcts` |
| Gateway | `default-default-gateway-web-main-sandbox-fnkvv5zxsr` |
| Sync Lambda role | `amplify-web-mainsandbox-s-SyncCedarPoliciesHandlerS-…` |
| S3 McpServer / target | `5b5acadb-…` / `s3-tools-web-main-sandbox` (`LX7MCYBMSY`) |
| Test user / group | `e2e-test-web-main@agentcore.dev` / `reservoir-eng` |
