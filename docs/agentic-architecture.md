# Agentic Architecture

This document covers how the AI agent actually runs: the harness, memory, MCP tools, and the path from a user message to a streamed response.

For cross-project deployment wiring (Amplify → AgentCore CDK) see [architecture.md](architecture.md).

---

## `agent/` Folder Structure

The `agent/` directory contains two things that are easy to confuse:

| Path | What it is |
|------|-----------|
| `agent/default/` | The AgentCore CLI project root. `agentcore.json` here is read at Amplify synth time for memories/gateways — the CLI itself (`agentcore dev`, `agentcore validate`) remains usable for local iteration, but `agentcore deploy` is no longer part of the production pipeline. |
| `agent/default/agentcore/agentcore.json` | Declarative source of truth for memories and gateways. Harness config is **not** read from here for the Amplify deploy path — see below. |
| `agent/default/app/MyHarness/system-prompt.md` | The harness's system prompt text, read from disk by `backend.ts`. Everything else about the harness (model, tools, memory link, truncation) is inlined as literal `CfnHarness`-shaped objects directly in `web/amplify/backend.ts` — there is no `harness.json`. |
| `agent/handler/` | Python source for the Strands agent container (FastAPI + uvicorn). **Not its own deploy unit** — it's referenced directly by `web/amplify/backend.ts` via `AgentCoreRuntimeWithBuild`. |

`web/amplify/backend.ts` builds both resources directly inside the `agentStack` CDK stack:

1. **`AgUiHandler` runtime** — `AgentCoreRuntimeWithBuild` builds `agent/handler/` into a Docker image, pushes to ECR, and creates the AgentCore runtime as a same-stack CDK resource. Used by the `/chat-handler` page via AppSync mutation → HTTP resolver.
2. **`MyHarness` harness** (plus `MyHarnessMemory` and the MCP gateway) — built by the `AgentCoreApplication` construct (`web/amplify/constructs/agentCoreApplication.ts`) from a `HarnessSpec` inlined literally in `backend.ts` (memory/gateway config still comes from `agentcore.json`). Used by the original `/chat` page via the SigV4 streaming transport.

Both share `MyHarnessMemory`, so both chat surfaces see the same conversation history. Because everything is same-stack, all ARNs are CDK tokens resolved at synth time — no post-deploy control-plane lookups are needed.

---

## Overview

The agent in this project is a **Bedrock AgentCore Harness** — a managed runtime that handles model invocation, memory, and tool execution. The frontend never talks to a model API directly; all inference flows through the harness.

```
Browser
  │  SigV4-signed InvokeHarnessCommand (Cognito Identity Pool credentials)
  ▼
bedrock-agentcore.{region}.amazonaws.com/harnesses/invoke
  │
  ▼
MyHarness (AgentCore Harness)
  ├── Model: OpenAI GPT-OSS-120B via Bedrock (chat completions format)
  ├── Memory: MyHarnessMemory (semantic + episodic)
  ├── Built-in tools: Browser, Code Interpreter
  └── Remote MCP tools: injected per-request from agent config
```

---

## Harness

The harness is configured directly in [`web/amplify/backend.ts`](../web/amplify/backend.ts) as a literal `HarnessSpec` (see `web/amplify/constructs/agentCoreApplication.ts`) — its system prompt text is read from [`agent/default/app/MyHarness/system-prompt.md`](../agent/default/app/MyHarness/system-prompt.md), everything else is inlined.

| Setting | Value |
|---------|-------|
| Model | `openai.gpt-oss-120b` via Bedrock, chat completions API format |
| Memory | `MyHarnessMemory` (persistent, per-user + per-session) |
| Built-in tools | `agentcore_browser`, `agentcore_code_interpreter` |
| Auth | AWS_IAM — every caller invokes via the SDK's `InvokeHarnessCommand`, SigV4-signed. Omitting `authorizerConfiguration` on the `CfnHarness` selects IAM. Callers are granted `bedrock-agentcore:InvokeHarness` on the harness ARN (`web/amplify/backend.ts`) |
| Context truncation | Summarization (preserves 10 most-recent messages, summarizes the rest) |

The harness runs as a hosted container on AgentCore infrastructure. Its ARN is exported via `backend.addOutput({ custom: { agentcore_harness_arn, ... } })` and read from `web/amplify_outputs.json` at build time by the frontend transport layer.

> **Auth history.** The harness was originally `CUSTOM_JWT`-authorized — every caller (browser, `invoke-agent` Lambda, webhook Lambda, `scripts/invoke.ts`) hand-rolled a `fetch` to `POST /harnesses/invoke` with a Cognito access token as a `Bearer` header, and decoded the binary event stream manually. It was switched to **AWS_IAM** so the GitHub/Jira webhook path could use the native `InvokeHarness` and `InvokeAgentRuntimeCommand` SDK operations, which are **SigV4-only** — this deleted the hand-rolled decoder in every caller and resolved a long-stream `TypeError: terminated` (#57) by letting the SDK own connection timeouts and retries. Because auth is a single per-harness property (JWT *or* IAM, not both), all four callers moved to SigV4 together: the Lambdas sign with their execution roles, the browser with Cognito Identity Pool credentials, and `scripts/invoke.ts` by exchanging the test user's Cognito login for Identity Pool credentials.

---

## Invocation Flow

### 1. Authentication

The harness authorizes with **AWS_IAM**, so callers invoke it with a SigV4-signed `InvokeHarnessCommand` rather than a Bearer JWT. In the browser, `web/lib/harness-agent.ts` constructs a `BedrockAgentCoreClient` whose credential provider calls `fetchAuthSession()` from `aws-amplify/auth` and returns the session's temporary **Cognito Identity Pool credentials** (`accessKeyId`/`secretAccessKey`/`sessionToken`). The SDK signs each request with those credentials; the Identity Pool's authenticated role is granted `bedrock-agentcore:InvokeHarness` on the harness ARN in `web/amplify/backend.ts`.

Server-side callers sign with their own IAM identity: the `invoke-agent` and `agent-webhook-invoke-agent` Lambdas use their execution-role credentials (each role granted `InvokeHarness`), and `scripts/invoke.ts` exchanges the test user's Cognito login for Identity Pool credentials via `fromCognitoIdentityPool`.

### 2. Request construction

`web/lib/harness-agent.ts` defines `HarnessAgent`, a client-side [AG-UI](https://github.com/ag-ui-protocol/ag-ui) agent (`AbstractAgent` subclass from `@ag-ui/client`) that the chat UI renders with CopilotKit's `<CopilotChat>`. On each message send (`HarnessAgent.run()`) it builds the invoke body:

```typescript
{
  runtimeSessionId: string,   // stable per-tab session; stored in sessionStorage
  messages: HarnessMessage[], // conversation history in Bedrock message format
  systemPrompt?: [...],       // from selected Agent's systemPromptText field
  model?: { bedrockModelConfig: { modelId } }, // from selected Agent's modelId field
  tools?: [                   // from selected Agent's mcpServers
    { type: "remote_mcp", name, config: { remoteMcp: { url, headers? } } },
    ...
  ],
}
```

`systemPrompt` and `model` use the harness's first-class override fields so the harness can apply them correctly rather than injecting them as message content.

### 3. Streaming response

The harness returns a binary AWS event stream (Smithy protocol). The SDK client decodes it into typed async-iterable events (`response.stream`), yielding:

- `messageStart` — signals the assistant turn has begun
- `contentBlockDelta` — text delta (streamed token by token)
- `contentBlockStop` — signals text block is complete
- `messageStop` — end of turn, includes `stopReason`
- `metadata` — token usage and latency metrics

`HarnessAgent.run()` translates `contentBlockDelta` events into AG-UI events (`TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT` deltas → `TEXT_MESSAGE_END`, bracketed by `RUN_STARTED`/`RUN_FINISHED`). `<CopilotChat>` consumes those events and renders the assistant turn incrementally — no AI SDK involved.

---

## Memory

`MyHarnessMemory` uses four complementary strategies, all namespaced per user:

| Strategy | Namespace | What it stores |
|----------|-----------|----------------|
| `SEMANTIC` | `/users/{actorId}/facts` | Durable facts extracted from conversation (preferences, stated facts) |
| `USER_PREFERENCE` | `/users/{actorId}/preferences` | Behavioral preferences inferred from interactions |
| `SUMMARIZATION` | `/summaries/{actorId}/{sessionId}` | Compressed summaries of old sessions |
| `EPISODIC` | `/episodes/{actorId}/{sessionId}` | Timestamped episode records; reflects to `/episodes/{actorId}` across sessions |

The harness reads relevant memory automatically before each inference call and writes new events after each turn. Memory events expire after 30 days.

### Viewing past sessions

The Amplify Lambda `list-session-messages` queries `ListEvents` on the memory ARN for a given session ID and parses each stored harness payload **once** into two fields per event: `text` (flattened plain text, for simple consumers) and `contentJson` (the full Bedrock Converse `ContentBlock[]` as a JSON string — text, `toolUse`, `toolResult`, `reasoningContent`).

The chat UI restores history through the AG-UI agent, not a bespoke render path. When `<CopilotChat>` mounts with an explicit `threadId` (the AgentCore session id), it calls `HarnessAgent.connect()`, which fetches those events, maps `contentJson` to role-discriminated AG-UI `Message[]` via `web/lib/converse-to-agui.ts` (assistant text + `toolCalls`, `tool` result messages, `reasoning` messages), and emits a single `MESSAGES_SNAPSHOT`. CopilotKit applies the snapshot to populate the transcript. Because the thread id *is* the AgentCore session id, live streaming and history share one identifier — no polling/merge step.

> The `contentJson` parse happens exactly once, in the Lambda. Clients map straight from Converse blocks to their render model rather than re-parsing ambiguous flattened strings — this replaced an earlier path that parsed twice (Lambda + client) and invented a non-standard `toolResult` message part.

`converse-to-agui.ts` also splits inline `<reasoning>…</reasoning>` tags out of assistant text blocks into their own `reasoning` messages (`splitInlineReasoning()`) — some models (e.g. `openai.gpt-oss-120b`) emit chain-of-thought this way instead of as a `reasoningContent` block, and without this split it renders as visible prose in the assistant bubble.

Tool activity (name, arguments, result) renders through CopilotKit's wildcard tool-call renderer, registered by `<ToolCallRenderer />` (`web/app/(with-auth)/chat/tool-call-renderer.tsx`, mounted inside `<CopilotKitProvider>` in `chat/page.tsx`) via `useDefaultRenderTool`. Without a registered renderer, `useRenderToolCall()` returns `null` for every tool call and CopilotKit's `AssistantMessage` renders nothing for it — standalone `role: "tool"` result messages are never rendered directly as bubbles; they're only consumed as the paired result of the matching assistant `toolCall` (matched by `toolCallId`) inside the renderer.

The separate `/chat-handler` page (the server-side AG-UI runtime flow — see [ag-ui-handler-pattern.md](ag-ui-handler-pattern.md)) still consumes the flattened `text` field via `use-initial-messages.ts`.

---

## MCP Tools

MCP (Model Context Protocol) tools let the agent call external APIs as tools. There are two ways they enter the system.

### Per-request injection (remote_mcp)

When the user selects an agent in the chat UI, the frontend reads the agent's `McpServer` records from AppSync and includes them in the invoke body as `remote_mcp` tool specs:

```typescript
{
  type: "remote_mcp",
  name: "my-tool-server",
  config: {
    remoteMcp: {
      url: "https://...",
      headers: { "Authorization": "Bearer ..." },
    },
  },
}
```

The harness calls the MCP server on demand using these exact credentials. This is the primary path for per-agent tool configuration.

### Gateway registration (optional)

MCP servers can also be registered as targets on the AgentCore Gateway. Registered targets benefit from gateway-level auth handling (workload identity, token exchange) rather than relying on raw header forwarding.

Registration happens via the `registerMcpTarget` GraphQL mutation → Amplify Lambda → `CreateGatewayTarget` API. The returned `gatewayTargetId` is saved on the `McpServer` record.

### Validating connectivity

Before saving an MCP server, the frontend can call the `listMcpTools` GraphQL query. This Lambda probes the server using the same `url` + `headers` that the harness would use (MCP `initialize` → `tools/list` sequence). If the query succeeds, the harness invocation will too.

---

## Agent Configuration

Agents are stored in DynamoDB via the Amplify `Agent` and `McpServer` models. The chat UI loads them and passes the selected agent's config into every harness invoke:

```
Agent record
  ├── name, slug
  ├── systemPromptText  → injected as systemPrompt override
  ├── modelId           → injected as model override (null = harness default)
  └── mcpServers (via AgentMcpServer join)
        └── McpServer: url, headers[]  → injected as remote_mcp tools
```

Agent configs are applied dynamically at invoke time — no redeployment required when an agent's prompt or tool list changes.

---

## Key ARNs

Exported via `backend.addOutput({ custom: {...} })` in `web/amplify/backend.ts` and read from `web/amplify_outputs.json`:

| Resource | Output key |
|----------|-----|
| Harness | `agentcore_harness_arn` |
| Memory | `agentcore_memory_arn` / `agentcore_memory_id` |
| MCP Gateway | `agentcore_gateway_arn` / `agentcore_gateway_id` / `agentcore_gateway_endpoint` |

> **Note**: The harness ARN uses the `harness/` resource type, not `runtime/`. These are different resources — the harness ARN is required by the `/harnesses/invoke` endpoint.

See [docs/architecture.md](architecture.md) for the full list of `custom` outputs.

---

## Data Flow Diagram

```
User types message
       │
       ▼
ChatView (React)
  <CopilotChat> → HarnessAgent (AG-UI AbstractAgent)
       │
       ▼
HarnessAgent.run()
  fetchAuthSession() → Cognito Identity Pool credentials
  BedrockAgentCoreClient.send(InvokeHarnessCommand{ messages, systemPrompt, model, tools })
       │
       ▼
POST /harnesses/invoke?harnessArn=...
  SigV4 signature (Identity Pool credentials)
       │
       ▼
AgentCore Harness (MyHarness)
  1. Validate SigV4 signature / IAM authorization (AWS_IAM auth)
  2. Load memory context for actorId + sessionId
  3. Build model request (history + system prompt + tools)
       │
       ▼
Bedrock: openai.gpt-oss-120b
  Streaming inference
       │  tool_use blocks
       ▼
AgentCore tool execution
  ├── agentcore_browser  (if invoked)
  ├── agentcore_code_interpreter  (if invoked)
  └── remote_mcp call to external server  (if invoked)
       │
       ▼
Streaming binary event stream response
       │
       ▼
SDK event-stream decode (response.stream)
  contentBlockDelta → AG-UI TEXT_MESSAGE_CONTENT
       │
       ▼
<CopilotChat> renders streamed text
```

### History restore (on session load)

```
<CopilotChat> mounts with threadId = AgentCore session id
       │
       ▼
HarnessAgent.connect()
  listSessionMessages query → Lambda (ListEvents, includePayloads)
    parse harness payload ONCE → { text, contentJson }
       │
       ▼
converse-to-agui.ts: contentJson (Converse ContentBlock[]) → AG-UI Message[]
  text → assistant/user content · toolUse → toolCalls
  toolResult → tool message · reasoningContent → reasoning message
       │
       ▼
emit MESSAGES_SNAPSHOT → CopilotKit populates transcript
```
