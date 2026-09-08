# Spike #533 — AgentCore Gateway on a standalone AWS Blocks app: findings

Throwaway spike for the standalone gateway-platform epic (#532). This directory is not meant
to be merged or maintained; see the verdict posted on #533 and #532 for the actual go/no-go
decision. This file is the working log behind that verdict. General AWS-Blocks-viability
findings (local dev, typed RPC, `fromExisting`, sandbox deploy mechanics) are **not** re-derived
here — see spike #514's `FINDINGS.md` (PR #519) for those; this spike only covers the
gateway-platform-specific risks #514 did not touch.

All criteria below were exercised against **real deployed AWS infrastructure** (not just
`cdk synth`): a real Cognito pool, a real `AWS::BedrockAgentCore::Gateway` with two live
targets, a real test user, real JWTs, and real HTTP calls to the deployed gateway — then
destroyed cleanly afterward (verified no orphaned stack).

## Per-criterion result

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Backend-only Blocks app scaffolds, `npm run dev`/`sandbox` viable | ✅ PASS | `npm create @aws-blocks/blocks-app@latest --template backend` (a first-class template, not something hand-stripped from `default`); `npm run dev` + `npm run test:e2e` ran fully local, zero AWS creds |
| 2 | AgentCore Gateway + CUSTOM_JWT authorizer synth+deploy as raw CDK inside the Blocks app | ✅ PASS | `aws-blocks/gateway-experiment.cdk.ts`; `cdk synth` produced a real `AWS::BedrockAgentCore::Gateway` with `AuthorizerType: CUSTOM_JWT` wired to a real Cognito discovery URL; **deployed** to `gwspike533-spike-gateway-3xx19bik6h`, live and callable |
| 3 | Gateway id/endpoint/ARN published to and read from SSM | ✅ PASS | Raw `ssm.StringParameter` (not the `AppSetting` block — see below) under `/agentcore/<stack>/gateway`; read back with a **plain `aws ssm get-parameter` call** (a genuinely separate process, no Blocks/CDK context) and got the exact resolved values |
| 4 | Lambda tool target discoverable + callable via gateway MCP with a Cognito JWT | ✅ PASS | `tools/list` returned `echoTool___echo`; `tools/call` with a real Cognito **access token** returned `{"echoed":"hello from spike 533"}`; a request with no token got HTTP 401 |
| 5 | `resources/list`/`resources/read` from an MCP-server target | ✅ PASS, with two undocumented gateway-side gotchas | `resources/list` → the steering-doc resource; `resources/read` → its markdown content, both over the gateway's aggregated MCP endpoint (not the target's raw endpoint) |
| — | Written verdict on Blocks preview stability | Below | — |

## Criterion 1 — backend-only Blocks app

`npx create-blocks-app --help` lists `--template backend` as a first-class scaffold
("Backend-only — Blocks API + CDK, no frontend, bring your own client") — no hand-stripping of
the `default` template needed, and no frontend build step (`vite`, `index.html`, `src/`) is even
generated. `npm run dev` starts the mock server fully local; `npm run test:e2e` passed against it
with zero AWS credentials, matching #514's criterion-1 finding for the `default` template.

## Criterion 2 — AgentCore Gateway + CUSTOM_JWT as raw CDK

Built `aws-blocks/gateway-experiment.cdk.ts`, added to the `cdk.App` in `index.cdk.ts` alongside
`BlocksStack.create(...)` (gated behind `AGENTCORE_GATEWAY_EXPERIMENT=1`, mirroring #514's
`agentcore-synth-experiment.cdk.ts` pattern so it never runs during normal `dev`/`sandbox`).

Unlike #514 (which reused the whole `AgentCoreApplication` L3 construct for a synth-only check),
this spike uses `AgentCoreMcp` **directly and standalone** — `agentCoreApplication` is an
*optional* prop, so a gateway can exist with no memories/harnesses/runtimes at all. That's a good
sign for #532's actual architecture: the gateway platform genuinely doesn't need the rest of
`AgentCoreApplication` dragged in.

Two of `web/`'s known `@aws/agentcore-cdk` constraints applied unchanged in the Blocks app:

- **`createRequire` workaround** — the package only declares a `"require"` export condition, so
  a static `import` of its value bindings (not just types) fails under ESM. Same
  `const require = createRequire(import.meta.url)` pattern from `agentCoreApplication.ts` was
  needed verbatim.
- **`agentcore.json` sentinel** — `AgentCoreMcp`'s constructor calls `findConfigRoot()`
  *unconditionally* and throws if it can't find a directory literally named `agentcore/`
  containing `agentcore.json` (contents never read). Added
  `aws-blocks/agentcore/agentcore.json` + `setSessionProjectRoot(__dirname)` pointed at
  `aws-blocks/`, mirroring `backend.ts`'s `web/amplify/agentcore/agentcore.json`.

New finding **not** covered by #514 (which only synth-tested memories/runtimes/policy engines,
never a Lambda-backed gateway target): the declarative `targetType: 'lambda'` compute path
(`McpLambdaCompute`) **only supports Python** — `implementation.language: 'TypeScript'` throws
`"Lambda bundling only supports Python currently"` at synth time. This explains why `web/`'s own
`S3ToolsGatewayTarget`/etc. register Node.js Lambda targets via a custom resource
(`CreateGatewayTarget`) instead of this declarative path — it's not a discoverability gap, the
declarative path is Python-only today. A TypeScript/Node Lambda target is still reachable via the
`targetType: 'lambdaFunctionArn'` variant (raw CDK `Function` + an ARN + a `toolSchemaFile`), which
is effectively what `web/`'s custom-resource approach does by hand. **#536 (migrating the
Node.js Lambda tool targets) should plan on `lambdaFunctionArn` + raw CDK functions, not the
inline `compute.host: 'Lambda'` path**, unless AgentCore adds TypeScript support first.

CDK version pinning (the caveat #514 flagged for `AgentCoreApplication`) was **not** an issue here
— the `backend` template's scaffold already pins `aws-cdk-lib@2.257.0`/`constructs@^10.6.0`, close
enough to `web/`'s `^2.248.0` that `@aws/agentcore-cdk@0.1.0-alpha.46` (the exact version pinned in
`web/package.json`) installed and type-checked cleanly with no manual override.

## Criterion 3 — SSM sharing

Used a raw `ssm.StringParameter` rather than the `AppSetting` Building Block. Not a limitation of
`AppSetting` — it's a scoping mismatch: `AppSetting` is designed to hang off a Blocks `Scope`
inside `aws-blocks/index.ts` (the shared backend-definition file, loaded under both local-mock and
real-AWS conditions), so its runtime `.get()`/`.put()` API works identically in dev and deploy. The
gateway's `attrGatewayIdentifier`/`attrGatewayArn`/`attrGatewayUrl` are CDK tokens from a
**separate, bare `cdk.Stack`** with no Blocks `Scope` construct in its tree, so there's nothing to
hang an `AppSetting` off inside that file. `AppSetting.fromExisting(scope, id, { name })` inside
`index.ts` *would* let the Blocks backend's own RPC layer read this same parameter — not built
here (time-boxed), but it's exactly the read-side half of the "gateway is a separate deployment,
Amplify reads its SSM params" story #532 describes, and the write side (raw `ssm.StringParameter`,
literal `/agentcore/<stack>/...` path — same convention `web/` already uses) needed no framework
help at all. **Recommend #534 use raw SSM for the write side (gateway stack → SSM) and, only if a
Blocks-hosted consumer needs to read it from inside a `Scope`, `AppSetting.fromExisting` for the
read side** — there's no forcing function to route the write through `AppSetting` when the source
values live in a different construct tree.

Verified the read side works from a genuinely separate process — not another Blocks API call —
with a plain `aws ssm get-parameter --name /agentcore/gateway-blocks-poc-experiment/gateway`,
which returned the exact JSON-encoded `{gatewayId, gatewayArn, gatewayUrl}` with all three CDK
tokens resolved to their real deployed values.

## Criterion 4 — Lambda tool target end-to-end

`echoTool` (Python, inline `compute.host: 'Lambda'`, `toolDefinitions` → confirmed this maps
1:1 to `ToolSchema.InlinePayload` in the synthesized `AWS::BedrockAgentCore::GatewayTarget`,
exactly the mechanism named in the issue). Full round trip against the **live deployed gateway**:

1. Created a real Cognito user in the spike's own pool, signed in via `USER_PASSWORD_AUTH`.
2. `initialize` against the gateway's MCP endpoint with the user's **access token** (not the ID
   token — the gateway's `AllowedClients` check matches the access token's `client_id` claim, not
   an ID token's `aud`) → succeeded.
3. `tools/list` → `echoTool___echo` and `steeringDocsServer___get_steering_doc`, both correctly
   namespaced `<targetName>___<toolName>`.
4. `tools/call` on `echoTool___echo` → `{"echoed":"hello from spike 533"}`.
5. Negative control: the same `tools/list` call with **no** `Authorization` header → HTTP 401.

## Criterion 5 — MCP-server target (steering docs)

`targetType: 'mcpServer'` with a plain `endpoint` (an external MCP server URL) is a **first-class,
already-supported** target type in this version of `@aws/agentcore-cdk` — no custom resource or
workaround needed, unlike the Lambda-target TypeScript gap above. Pointed it at a minimal MCP
JSON-RPC server (Lambda Function URL, `aws-blocks/mock-mcp-server-handler.ts`) implementing just
enough of the protocol to serve one steering-doc-shaped resource.

Two real, undocumented-as-far-as-I-found gotchas in AgentCore's target-validation crawl (the
control plane calls the target's own MCP endpoint at `CreateGatewayTarget` time to verify it's a
real server before marking the target `STABLE`) — both are directly relevant to #538/#539's design:

1. **A resources-only MCP server target is rejected outright**: `"MCP server ... has no tools"`.
   The target must expose at least one real tool via `tools/list`, even if the whole point of the
   target is to serve a resource. This is a forcing function, not a footnote — it means **#538
   (steering-doc resource) cannot ship without #539 (the `get_steering_doc` tool fallback)
   already in place**, at least for an MCP-server-type target; the epic's own planned sequencing
   (538 then 539) will hit this validation failure on 538 alone unless the tool ships first or
   the two land together.
2. **`resources/templates/list` returning a JSON-RPC "method not found" error is treated as
   fatal**, not "optional MCP method, skip it" — even though `resources/templates` is an optional
   sub-capability of the `resources` capability per the MCP spec. A server that just implements
   `resources/list`/`resources/read` (skipping the optional templates variant, which is reasonable
   for a fixed, non-parameterized doc set) fails target validation with `"Failed to connect and
   fetch tools from the provided MCP target server. Error - Method not found:
   resources/templates/list"` unless it also stubs `resources/templates/list → {resourceTemplates: []}`.

Once both were added, the target deployed and stabilized, and against the live gateway:
`resources/list` returned the steering-doc resource (URI, name, `mimeType: text/markdown`,
`annotations.audience`/`priority` all passed through unchanged); `resources/read` returned its
markdown content — confirming the exact aggregation model #532 needs: resources/tools from a
`mcpServer`-type target surface through the **gateway's own MCP endpoint**, not just the target's
raw endpoint, with the same Cognito JWT used for tool calls.

**No fallback needed** — MCP-server targets are feasible from a Blocks app, full stop, though
#539's `get_steering_doc` tool now looks like a hard synth-time dependency of #538, not a
nice-to-have fallback for tool-only clients as originally scoped.

## AWS Blocks preview-stability verdict

Two real friction points hit during this spike, both **environment/tooling**, not the Blocks
framework's own APIs:

1. **`cdk deploy`/`cdk synth --debug` under this specific sandbox's non-EC2 container credential
   source needs `AWS_EC2_METADATA_DISABLED=false` set explicitly.** The bundled `aws-cdk` CLI
   auto-detects "not an EC2 instance" and sets `AWS_EC2_METADATA_DISABLED=true` unless that var is
   already set, which breaks credential resolution when the container's credentials actually come
   through an IMDS-compatible endpoint despite not being literal EC2. A one-line env var fixes it,
   but the failure mode (`"Unable to resolve AWS account to use"`) gives no hint toward the real
   cause — cost about 20 minutes of debugging via reading the CDK CLI's own bundled source. Not
   Blocks-specific (this is `aws-cdk` CLI behavior), but it's exactly the kind of sharp edge that
   costs real time in a CI/agent sandbox and should go in #534's runbook.
2. **`uv` (Python packaging) isn't preinstalled** and is a hard dependency of `@aws/agentcore-cdk`'s
   Python Lambda bundling (`McpLambdaCompute`) even for a TypeScript-only Blocks app — needed
   installing it out-of-band. Minor, but another thing #534 should document as a prerequisite.

Everything **actually attributable to Blocks itself** worked as documented: the `backend` template,
local mock dev, RPC typing, and `cdk synth`/`cdk deploy` mechanics were all solid, matching #514's
overall verdict. No Blocks API threw an unexpected error, needed an undocumented workaround, or
behaved differently between mock and real-AWS — the two real gotchas above were both on
AgentCore's side (Lambda-target language support, target-validation crawl requirements), not
Blocks'. **Preview-stability judgment: stable enough to build on for #532.** The friction found
here is the kind that gets fixed once and documented in a runbook, not signal of an unstable
foundation.

## Rough effort estimate for #532's remaining child issues

Given what this spike surfaced:

- **#534** (scaffold + CI synth gate + SSM plumbing): **~2-3 days.** Mostly mechanical — apply
  this spike's `createRequire`/sentinel/CDK-pinning pattern for real, wire the credential-provider
  env var and `uv` prerequisite into the synth-gate script, decide the `AppSetting`-vs-raw-SSM
  split from criterion 3 above.
- **#535** (move gateway + JWT authorizer out of Amplify): **~3-5 days.** The mechanics are
  proven end-to-end by this spike; the work is re-pointing the CUSTOM_JWT authorizer at whichever
  Cognito pool the platform ends up using (its own, per this spike, vs. importing Amplify's) and
  updating every consumer's SSM-read path.
- **#536** (migrate Lambda-backed tool targets): **~1 week, plan on `lambdaFunctionArn`** (raw CDK
  `NodejsFunction` + ARN + `toolSchemaFile`) per the Python-only finding above, **not** the
  declarative `compute.host: 'Lambda'` path — this is a real, previously-unknown constraint that
  changes #536's approach, not just its estimate.
