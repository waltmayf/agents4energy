# Agentic Architecture

This document covers how the AI agent actually runs: the harness, memory, MCP tools, and the path from a user message to a streamed response.

For cross-project deployment wiring (Amplify → AgentCore CDK) see [architecture.md](architecture.md). For the knowledge-graph data model and traversal tool contract, see [knowledge-graph.md](knowledge-graph.md).

---

## `web/amplify/agentcore/` Folder Structure

`agent/default/` (the standalone AgentCore CLI project) was deleted in #440 — all AgentCore sources now live under `web/amplify/agentcore/`, consumed directly by the Amplify backend at synth time. This directory contains two things that are easy to confuse:

| Path | What it is |
|------|-----------|
| `web/amplify/agentcore/agentcore.config.ts` | The real, typed config: `memories`, `runtimes`, `policyEngines`, `gateways` consts. `web/amplify/backend.ts` imports these and feeds them to the `AgentCoreApplication` CDK construct. This is the only source of truth for AgentCore resource config. |
| `web/amplify/agentcore/agentcore.json` | A near-empty, required-but-inert **sentinel** (`{ "name": "agentcore", "version": 1 }`). `@aws/agentcore-cdk`'s `findConfigRoot()` throws at synth unless a directory literally named `agentcore/` contains a file literally named `agentcore.json` — it only checks existence, never contents. It is **not** where memory/gateway/runtime config lives (see `agentcore.config.ts` above). |
| `web/amplify/agentcore/MyHarness/system-prompt.md` | The harness's system prompt text, read from disk by `backend.ts`. Everything else about the harness (model, tools, memory link, truncation) is inlined as a literal `HarnessSpec` directly in `web/amplify/backend.ts` — there is no `harness.json`. |

`web/amplify/backend.ts` builds the AgentCore resources directly inside the `agentStack` CDK stack, via a single Amplify deploy (`npx ampx sandbox --once`) — there is no separate `agentcore deploy` step:

- **`MyHarness` harness** (plus `MyHarnessMemory` and the MCP gateway) — built by the `AgentCoreApplication` construct (`web/amplify/constructs/agentCoreApplication.ts`) from a `HarnessSpec` inlined literally in `backend.ts` (memory/gateway config comes from `agentcore.config.ts`). It is the **sole harness**, used by the `/chat` page via the SigV4 streaming transport. The same construct also builds the `ClaudeCode` and `AguiAgent` AgentCore Runtimes from `agentcore.config.ts`'s `runtimes` — see [claude-code-agentcore-runtime.md](claude-code-agentcore-runtime.md) and [agui-runtime.md](agui-runtime.md).

> The former `AgUiHandler` runtime (`AgentCoreRuntimeWithBuild` building the Python `agent/handler/` container, plus the `/chat-handler` page and `invokeHandler`/`publishAgentEvent`/`onAgentEvent` AppSync wiring) was **retired in #33**. See [ag-ui-handler-pattern.md](ag-ui-handler-pattern.md) for the historical design — not to be confused with the current `AguiAgent` AgentCore Runtime.

Because everything is same-stack, all ARNs are CDK tokens resolved at synth time — no post-deploy control-plane lookups are needed.

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
  ├── Built-in tools: Browser
  └── Remote MCP tools: injected per-request from agent config
```

---

## Harness

The harness is configured directly in [`web/amplify/backend.ts`](../web/amplify/backend.ts) as a literal `HarnessSpec` (see `web/amplify/constructs/agentCoreApplication.ts`) — its system prompt text is read from [`web/amplify/agentcore/MyHarness/system-prompt.md`](../web/amplify/agentcore/MyHarness/system-prompt.md), everything else is inlined.

| Setting | Value |
|---------|-------|
| Model | `openai.gpt-oss-120b` via Bedrock, chat completions API format |
| Memory | `MyHarnessMemory` (persistent, per-user + per-session) |
| Built-in tools | `agentcore_browser` (the `agentcore_code_interpreter` sandbox was removed — see #191; the agent runs shell commands in the harness runtime session instead) |
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

### Actor scoping — per-user memory with cross-surface visibility (issue #256)

The `actorId` in every namespace above determines *whose* memory a read or write touches. Two actor scopes coexist:

- **Browser harness chats scope to the signed-in user's Cognito `sub`.** Both invoke paths — the browser (`web/lib/harness-agent.ts`) and the `invoke-agent` Lambda — pass `InvokeHarnessCommand.actorId = <sub>`, which overrides the actor for *all* memory ops (events, `SEMANTIC`, `USER_PREFERENCE`, and `SUMMARIZATION`). So one user's chats, facts, and summaries are isolated from another's.
- **Webhook-initiated runs keep a shared actor (`"default"`).** A `@agentcore-claude` run (ClaudeCode/AguiAgent runtimes) has no browser `sub` to attribute to, so it writes under the shared `SHARED_ACTOR_ID` constant (`web/lib/caller-identity.ts`; the two runtime writers hard-code the same string since they're separate Docker artifacts).

To keep GitHub-dispatched runs visible in the chat UI, `HarnessAgent.loadHistory` **dual-reads**: it queries `list-session-messages` for both the caller's own `sub` namespace *and* the shared `"default"` namespace, then merges (the two event sets are disjoint by construction; the existing sort+dedupe handles it). Trade-off (Option A of #256): the shared namespace is readable by any signed-in user — acceptable because webhook runs aren't attributable to a browser user anyway. Old sessions written under `"default"` before this change remain readable through the shared read-leg.

`list-session-messages` **authorizes the requested `actorId` server-side** against the verified Cognito `sub` on `event.identity` (`isActorAuthorized`): a caller may read only their own `sub` namespace or the shared one. This closes a prior hole where `actorId` was a caller-supplied argument, letting any authenticated user read any actor's memory by passing an arbitrary value.

### Viewing past sessions

The Amplify Lambda `list-session-messages` queries `ListEvents` on the memory ARN for a given session ID and parses each stored harness payload **once** into two fields per event: `text` (flattened plain text, for simple consumers) and `contentJson` (the full Bedrock Converse `ContentBlock[]` as a JSON string — text, `toolUse`, `toolResult`, `reasoningContent`).

The chat UI restores history through the AG-UI agent, not a bespoke render path. When `<CopilotChat>` mounts with an explicit `threadId` (the AgentCore session id), it calls `HarnessAgent.connect()`, which fetches those events, maps `contentJson` to role-discriminated AG-UI `Message[]` via `web/lib/converse-to-agui.ts` (assistant text + `toolCalls`, `tool` result messages, `reasoning` messages), and emits a single `MESSAGES_SNAPSHOT`. CopilotKit applies the snapshot to populate the transcript. Because the thread id *is* the AgentCore session id, live streaming and history share one identifier.

`connect()` only runs when the thread (re)mounts, so turns written to the session **after** load — e.g. by a webhook harness run on the same session, or a second tab — would otherwise appear only on reload. `web/app/(with-auth)/chat/use-session-message-polling.ts` closes that gap: it polls `HarnessAgent.refreshHistory()`, which re-fetches history and, when it has grown, calls the agent's `setMessages()` to update the transcript live (CopilotKit re-renders off the resulting `onMessagesChanged`). Polling pauses on a hidden tab, backs off to a slow interval once a session goes quiet, no-ops while a local turn is streaming, and only grows the transcript — so it never clobbers optimistic/streamed messages. This is what makes the webhook deep link (`/chat?sessionId=<runId>`) show the agent working in near-real-time (issue #63). No `ChatSession` row needs to exist for that `runId` — `useChatSession()` only creates one when the URL has no `sessionId` at all — so the webhook path and this polling path are the only two pieces that matter for the deep link; see "Verified end-to-end" in [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md#verified-end-to-end-chat-link--live-messages-issue-64) and its e2e coverage (issue #64).

> The `contentJson` parse happens exactly once, in the Lambda. Clients map straight from Converse blocks to their render model rather than re-parsing ambiguous flattened strings — this replaced an earlier path that parsed twice (Lambda + client) and invented a non-standard `toolResult` message part.

`converse-to-agui.ts` also splits inline `<reasoning>…</reasoning>` tags out of assistant text blocks into their own `reasoning` messages (`splitInlineReasoning()`) — some models (e.g. `openai.gpt-oss-120b`) emit chain-of-thought this way instead of as a `reasoningContent` block, and without this split it renders as visible prose in the assistant bubble.

**The Claude Code AgentCore Runtime writes to this same memory.** `@agentcore-claude` runs aren't a harness invocation, but `web/amplify/agentcore/ClaudeCode/server.js` calls `CreateEvent` on `MyHarnessMemory` itself (under the shared `"default"` actor, same Converse-shaped payload) as the CLI streams its turns, so those runs restore through this exact path too — and the browser's dual-read (see "Actor scoping" above) is what surfaces them alongside the viewer's own per-`sub` chats. See [`docs/claude-code-agentcore-runtime.md`](./claude-code-agentcore-runtime.md#memory-persistence-agentcore-claude-turns-in-the-chat-ui) (issue #186).

**A `@agentcore-claude` run can hand off to a monitor loop instead of finishing.** Ending a turn with a fenced ```monitor``` block pauses the webhook Step Function in a `Wait → RunMonitorCheck → Choice` loop (same `MyHarnessMemory` session, reclaimed microVM between checks) that re-invokes the runtime once the check passes. See [`docs/monitor-loop.md`](./monitor-loop.md).

**A third runtime, `AguiAgent`, emits AG-UI events natively instead of Converse.** Unlike `MyHarness`/`ClaudeCode`, it doesn't need `converse-to-agui.ts`'s translation — it speaks the AG-UI wire protocol directly, via `@ag-ui/aws-strands` — but it writes to the same `MyHarnessMemory` in the same Converse-shaped format so its runs restore through this same path too. See [`docs/agui-runtime.md`](./agui-runtime.md) (issue #176). Frontend wiring to invoke it from the chat UI is a separate follow-up.

**Built-in tool calls (shell/browser/file) don't persist structured blocks.** Unlike MCP-server tool calls, the managed harness stores built-in tool turns as flattened text rather than Converse `toolUse`/`toolResult` blocks — so `contentJson` is absent for them (same Harmony-decoding gap as #105/#149, surfacing at the memory-persist step instead of the webhook final-comment step). Full reconstruction is impossible because the tool call's *arguments* are never persisted in this format — only a leaked "Use functions.\<name\>." sentence and a separate bare-JSON result turn. `converse-to-agui.ts` detects that specific pair and reconstructs a degraded tool card (name + result, no arguments) instead of showing the raw JSON as a plain user bubble (issue #117). Fixing this at the source would require a change to the AWS-managed harness's own persistence behavior, which this repo doesn't own.

Tool activity (name, arguments, result) renders through CopilotKit's wildcard tool-call renderer, registered by `<ToolCallRenderer />` (`web/app/(with-auth)/chat/tool-call-renderer.tsx`, mounted inside `<CopilotKitProvider>` in `chat/page.tsx`) via `useDefaultRenderTool`. Without a registered renderer, `useRenderToolCall()` returns `null` for every tool call and CopilotKit's `AssistantMessage` renders nothing for it — standalone `role: "tool"` result messages are never rendered directly as bubbles; they're only consumed as the paired result of the matching assistant `toolCall` (matched by `toolCallId`) inside the renderer.

**A tool result can carry structured UI content instead of plain text.** Both translators (`converse-to-agui.ts` and `harness-stream-to-agui.ts`) run each `toolResult` content item through `web/lib/tool-result-content.ts`'s `toToolResultPart()`; a `json` item whose value has a string `mimeType` field is treated as a UI block (`{ mimeType, spec?, html? }`) and, if any part in the result is a UI block, the whole result is JSON-encoded behind a sentinel envelope (`encodeToolResultParts` / `decodeToolResultContent`) so it survives the string-typed AG-UI `content` field. `tool-call-renderer.tsx` decodes that envelope and branches per part: a `text/html` block renders inside a fully sandboxed `<iframe>` (`srcDoc` + `sandbox=""`, never `dangerouslySetInnerHTML` — see `chat/tool-widgets/sandboxed-html.tsx`); a `spec` matching a known shape (validated in `web/lib/component-spec.ts`) renders through the widget registry in `chat/tool-widgets/registry.tsx`; anything else — plain text, an unrecognized `spec`, or an oversized block — falls back to the original YAML card unchanged (issue #475).

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

### Gateway registration is mandatory (browser HarnessAgent path)

Every `McpServer` must be registered as a target on the AgentCore Gateway before it can be assigned to an agent — there is no direct-URL connection option from the browser chat path anymore (#338). Registered targets get gateway-level auth handling (the `CUSTOM_JWT` authorizer + Cedar) instead of raw header forwarding.

Registration happens automatically: `register-mcp-target-stream` (a DynamoDB-stream Lambda on the `McpServer` table) calls `CreateGatewayTarget` within seconds of a server being created and saves the returned `gatewayTargetId` back onto the record. (The `registerMcpTarget` GraphQL mutation → Amplify Lambda does the same `CreateGatewayTarget` call for a caller that wants to register synchronously and handle the result itself — no UI currently calls it directly.) `web/app/(with-auth)/agents/page.tsx` blocks assigning an `McpServer` to an `Agent` until `gatewayTargetId` is set (disabled picker row + a save-time check), rather than trying to register again at assignment time and racing the stream Lambda.

**`HarnessAgent.buildTools` (`web/lib/harness-agent.ts`) requires a `gatewayTargetId` for every tool it builds.** A server without one is dropped (with a `console.warn`), never direct-connected. Every remaining tool's `remoteMcp.url` is the gateway endpoint — not the server's own URL — with the caller's Cognito **access token** attached as `Authorization: Bearer` (the ID token 403s at the `CUSTOM_JWT` authorizer with `insufficient_scope`, #327). The gateway's Cedar policy engine then authoritatively **permits or denies each call by the signed-in user's `cognito:groups`**, running in `ENFORCE` mode. See [`docs/tool-governance.md`](./tool-governance.md) for the identity/permission model and a two-user demo.

`web/amplify/functions/invoke-agent/handler.ts` (the webhook-invoked `invokeAgent` mutation path) still has a direct-URL fallback for a server without a `gatewayTargetId` — bringing that path under mandatory gateway routing too is tracked separately as part of the webhook machine-identity work (#337/#340), since it needs its own relayed-JWT design first.

### Gateway registration for ClaudeCode and AguiAgent (#339)

The `ClaudeCode` (`web/amplify/agentcore/ClaudeCode/`) and `AguiAgent` (`web/amplify/agentcore/AguiAgent/`) runtimes route their own MCP tool access through the same gateway, using the same relayed-access-token pattern as `buildTools` above — but each speaks a different native MCP client, so the wiring is per-runtime rather than a shared function:

- **ClaudeCode**: `web/lib/claude-code-agent.ts` relays the signed-in caller's Cognito access token as a `cognitoAccessToken` field on the `InvokeAgentRuntime` payload. `gateway-mcp.js` turns that into a `.mcp.json` server entry (`{"type": "http", "url": AGENTCORE_GATEWAY_ENDPOINT, "headers": {"Authorization": "Bearer <token>"}}`) that `mcp-config.js` merges with the AgentCore Browser tool's entry (`browser-mcp.js`) into one file, so the `claude` CLI's `--mcp-config` flag sees both. Either entry is dropped independently if it isn't available for a given run (e.g. no token on the webhook path, #340; no browser session).
- **AguiAgent**: `server.ts` reads the token from `RunAgentInput.forwardedProps.cognitoAccessToken` (the AG-UI-native carrier for per-request extras — untyped/`z.any()` in `@ag-ui/core`, so no schema change was needed) and builds a **per-request** Strands `Agent` + `McpClient` pointed at the gateway. It's rebuilt fresh per request rather than cached per-thread, for the same reason `buildTools` is called fresh on every harness invocation: the token belongs to whichever user is calling *this* request, not whichever user happened to call first on a cached thread.

Neither runtime fabricates a `{sub, groups}` claims blob for the gateway — both simply relay the real JWT the browser already holds, so Cedar's `cognito:groups` tag match (see [`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md)) behaves identically to the harness path. `AguiAgent` currently has no chat-UI or webhook invoker of its own (see [`docs/agui-runtime.md`](./agui-runtime.md)) — this wiring makes its container ready for whichever caller invokes it next, without waiting on that separate frontend-integration work.

### Validating connectivity

Before saving an MCP server, the frontend can call the `listMcpTools` GraphQL query. This Lambda probes the server using the same `url` + `headers` that the harness would use (MCP `initialize` → `tools/list` sequence). If the query succeeds, the harness invocation will too.

### Lambda-backed gateway target: S3 filesystem tools

The `s3-tools` Lambda (`web/amplify/functions/s3-tools/`) is the first **Lambda-backed** gateway target in the repo — the gateway invokes it directly (no outbound HTTP/MCP JSON-RPC hop) rather than proxying to an HTTP MCP endpoint like the two paths above. It backs four tools exposed to any agent that has its gateway `McpServer` assigned: `ApplyDiff`, `ListFiles`, `ReadFile`, `DeleteFile`. See [`docs/agent-filesystem.md`](./agent-filesystem.md) for the tool contracts and path-resolution rules.

Wiring, all in `web/amplify/backend.ts`:
- **Storage**: `web/amplify/storage/resource.ts` defines an Amplify Storage bucket (`agentWorkspace`). The Lambda's execution role is granted `s3:GetObject`/`PutObject`/`DeleteObject`/`ListBucket` scoped to the bucket's `files/*` prefix — there is no direct browser/Cognito access to this bucket.
- **Target registration**: the `S3ToolsGatewayTarget` custom resource (`web/amplify/constructs/s3ToolsGatewayTarget/`) calls `CreateGatewayTarget` with `targetConfiguration.mcp.lambda` (an inline `ToolSchema` describing the four tools), listing existing targets by name first so redeploys update in place instead of erroring on "already exists".
- **Demo wiring**: the `S3ToolsMcpServerSeed` custom resource (`web/amplify/constructs/s3ToolsMcpServerSeed/`) idempotently creates a demo `Agent` + `McpServer` (pointing at the gateway endpoint) + `AgentMcpServer` join row, so the tools are reachable end-to-end from the chat UI without manual setup. It signs AppSync requests directly with SigV4 (the custom-resource Lambda is an IAM principal, not a Cognito user) — the same approach `web/amplify/agentcore/ClaudeCode/active-run.js` uses for its server-side `ActiveRun` writes.
- Both custom resources live in their own CDK stack (`backend.createStack('s3-tools')`), not `agentStack`, because they reference tokens from both the function stack and the data stack — nesting them in `agentStack` would form the same nested-stack dependency cycle documented next to `AgentWebhookStack`'s own stack placement.

### Lambda-backed gateway target: knowledge-graph tools

A second Lambda-backed gateway target, `graph-traverse`, exposes three tools — `TraverseGraph`, `UpsertNode`, `UpsertEdge` — backed by a single Lambda (`web/amplify/functions/graph-traverse/handler.ts`) that reads/writes the `Node`/`Edge` models over AppSync instead of DynamoDB directly, so the storage layer can later change without changing the agent-facing tools. See [`docs/knowledge-graph.md`](./knowledge-graph.md) for the data model, the traversal contract, and the design rationale for bounded-depth frontier expansion over a graph database.

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

### Live updates (after load)

```
use-session-message-polling.ts (interval, paused when tab hidden)
       │
       ▼
HarnessAgent.refreshHistory()  — skipped while a local turn streams
  loadHistory() → listSessionMessages query (same path as connect)
       │
       ▼ (only if fetched message count grew)
setMessages(history) → onMessagesChanged → CopilotKit re-renders live
```
