# AG-UI-native AgentCore Runtime (`AguiAgent`)

Source: [`web/amplify/agentcore/AguiAgent/`](../web/amplify/agentcore/AguiAgent/).

Issue #176's premise: the harness's native handler (`MyHarness`) only emits Bedrock **Converse** events, so the frontend has to translate those into AG-UI events itself (`web/lib/converse-to-agui.ts`) to make [CopilotKit](https://www.copilotkit.ai/) / AG-UI-based UIs work with it. `AguiAgent` is a second, independent AgentCore Runtime that emits [AG-UI protocol](https://docs.ag-ui.com/introduction) events **natively** over the wire — no translation layer needed by a frontend built against it.

This does **not** replace anything:

- `MyHarness` (`web/amplify/agentcore/MyHarness/`) — the Bedrock Converse harness the `/chat` page uses today — is untouched.
- `ClaudeCode` (`web/amplify/agentcore/ClaudeCode/`) — the `@agentcore-claude` GitHub runtime — is untouched.

`AguiAgent` is registered as a third, additional entry in `agentcore.json`'s `runtimes[]` and in `web/amplify/backend.ts`'s runtime wiring, following the same additive pattern `ClaudeCode` uses.

## How it's built

Per [AWS's "Deploy AG-UI servers in AgentCore Runtime" guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) and the [CopilotKit Strands-TypeScript AgentCore deploy guide](https://docs.copilotkit.ai/strands-typescript/deploy-agentcore), the server wraps an [`@strands-agents/sdk`](https://www.npmjs.com/package/@strands-agents/sdk) `Agent` with [`@ag-ui/aws-strands`](https://www.npmjs.com/package/@ag-ui/aws-strands)'s `StrandsAgent`, which does the AG-UI protocol translation from Strands' native event stream.

| File | What it does |
|---|---|
| `server.ts` | Express server implementing the [AgentCore AG-UI proxy contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html#runtime-agui-how-agentcore-supports): `GET /ping` (health) + `POST /invocations` (parses a `RunAgentInput`, streams AG-UI events back as SSE via `@ag-ui/encoder`'s `EventEncoder`), on `0.0.0.0:8080` |
| `memory.ts` | Accumulates the AG-UI event stream (`TEXT_MESSAGE_*`, `TOOL_CALL_*`) into Bedrock Converse-shaped `ContentBlock[]` and writes it to AgentCore Memory via `CreateEvent` — see [Memory persistence](#memory-persistence) below |
| `Dockerfile` | `node:22-bookworm-slim`, forced `linux/arm64` (the runtime contract requires ARM64); `tsc` compiles `server.ts`/`memory.ts` to `dist/`, `CMD ["node", "dist/server.js"]` |
| `package.json` | `@strands-agents/sdk`, `@ag-ui/aws-strands`, `@ag-ui/core`, `@ag-ui/encoder`, `express`, `cors` |

`agentcore.json` sets `"protocol": "AGUI"` on the runtime entry — this is what tells AgentCore Runtime to proxy the container as an AG-UI server (SSE over `/invocations`) rather than a plain HTTP JSON handler.

The Bedrock model is `BEDROCK_MODEL_ID` (default `us.anthropic.claude-sonnet-5`), overridable via the runtime's `envVars` in `agentcore.json` — no code change to bump it.

## Memory persistence

`MyHarnessMemory` (the same AgentCore Memory resource `MyHarness` and `ClaudeCode` write to) is shared: `web/amplify/backend.ts` passes `AGENTCORE_MEMORY_ID`/`AGENTCORE_MEMORY_REGION` as runtime env vars and grants the runtime's execution role `bedrock-agentcore:CreateEvent` on that memory, mirroring the `ClaudeCode` wiring exactly.

`memory.ts`'s `AssistantTurnAccumulator` builds the same Converse-shaped `payload.conversational.content.text` JSON string the harness and `ClaudeCode` write, so a run through `AguiAgent` reads back through the exact same path the chat UI already uses: `web/amplify/functions/list-session-messages/handler.ts` parses it, `web/lib/converse-to-agui.ts` maps it to AG-UI messages.

## Invoking it

Like `ClaudeCode`, the authenticated Cognito Identity Pool role is granted `bedrock-agentcore:InvokeAgentRuntime` on this runtime's ARN (and its `runtime-endpoint/*` sub-resource — `InvokeAgentRuntime` authorizes against the endpoint, not the bare runtime ARN). Its ARN is exposed as an SSM parameter (`/agentcore/<stack>/agui_runtime_arn`) the same way `ClaudeCode`'s is, for scripts/tooling that need to resolve it outside CloudFormation.

**Frontend wiring to actually drive this runtime from the chat UI is intentionally out of scope for issue #176** — this PR is the runtime + backend registration only. A future issue covers pointing an AG-UI/CopilotKit client (e.g. via `@ag-ui/client`'s `HttpAgent`, as shown in AWS's guide) at it.

## Gateway-routed MCP tools (#339)

Whoever eventually invokes this runtime can give it gateway-routed, Cedar-gated MCP tools by including the caller's Cognito **access** token (not the ID token — #327) in the AG-UI `RunAgentInput.forwardedProps.cognitoAccessToken` field. When both that token and `AGENTCORE_GATEWAY_ENDPOINT` (wired to this runtime in `backend.ts`, mirroring `ClaudeCode`'s wiring) are present, `server.ts` builds a Strands `McpClient` pointed at the gateway with that token as `Authorization: Bearer`, and passes it into a fresh, per-request `Agent`. Cedar then authorizes each tool call against the caller's `cognito:groups`, identically to the browser `HarnessAgent` path (`buildTools` in `web/lib/harness-agent.ts`). With no token relayed — the expected case until a real invoker exists — the agent simply runs with no tools, same as before this issue.
