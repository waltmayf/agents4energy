# Chat session management (sidebar, auto-naming, delete)

The chat page (`web/app/(with-auth)/chat`) manages the signed-in user's chat
sessions — the `ChatSession` records are owner-authed, so every user sees only
their own. This doc covers the three session-management behaviours.

## Session history sidebar

The history sidebar (`session-sidebar.tsx`) lists past sessions
most-recently-updated first and lets you reopen, rename, or delete each one.

It is **hidden by default**. The chat pane shows a `PanelLeftOpen` toggle in its
top-left corner; clicking it reveals the sidebar, and the `PanelLeftClose`
button in the sidebar header hides it again. Open/closed state lives in the page
component (`page.tsx`) — it is per-mount (not persisted), so every fresh load
starts collapsed with the chat pane at full width.

## Auto-naming (two stages)

A fresh session is created with the `New Chat` placeholder (see
`use-chat-session.ts`). The first time the user sends a turn,
`use-auto-name-session.ts` names it in two stages:

1. **Instant, client-derived title.** `deriveSessionTitle` (`web/lib/session-title.ts`)
   takes the first few words of the first message (collapsed whitespace,
   truncated to 60 chars on a word boundary). This is applied immediately with
   no network round-trip, so the placeholder disappears at once.
2. **LLM-generated title.** The `nameChatSession` AppSync mutation calls the
   `name-chat-session` Lambda, which asks a small Bedrock model
   (**Claude Haiku 4.5** via the Converse API, `us.anthropic.claude-haiku-4-5-*`)
   for a concise Title-Case summary and upgrades the session name to it.

Both writes go through `renameIfAuto`, which only overwrites the name while the
session still carries an **auto-name** (the placeholder or the stage-1 derived
title). A **manual rename always wins** — once the user sets a name, neither
stage will clobber it. The LLM path is fully fire-and-forget: if the model call
fails or returns nothing, the stage-1 title stands and nothing surfaces in the
chat.

### The naming Lambda

`web/amplify/functions/name-chat-session/` — a short-timeout (15s) Lambda that
runs Bedrock Converse with a titling system prompt, then trims quotes/trailing
punctuation and clamps the result to the same 60-char bound as the client. It
returns `null` for empty input, a model error, or an empty completion — callers
treat `null` as "keep the title you already have".

- Model is overridable via the `NAMING_MODEL_ID` env var (`resource.ts`).
- Granted `bedrock:InvokeModel` on `foundation-model/*` **and**
  `inference-profile/*` in `backend.ts`, because the default model id is a
  cross-region inference profile (the `us.` prefix) that fans out to the
  underlying foundation model in several regions.
- The mutation is defined in `web/amplify/data/schemas/chat.schema.ts` with
  `allow.authenticated()`.

> Note: `claude-3-5-haiku` was the first choice but Bedrock now returns
> `ResourceNotFoundException: This model version has reached the end of its
> life` for it — hence Haiku 4.5.

## Deleting a session

Each sidebar row has a trash button. Clicking it opens a **confirmation splash**
(`DeleteSessionDialog`) naming the session; the delete only happens after the
user confirms. On confirm the row calls `ChatSession.delete`, drops the row from
the list optimistically, and — if the deleted session was the one being
viewed — navigates to a fresh `/chat` so the pane isn't left pointing at a
missing session. A failed delete leaves the dialog open to retry.

Message history itself lives in AgentCore Memory, not DynamoDB (see
`functions/list-session-messages`); deleting the `ChatSession` record removes it
from the sidebar but does not purge the underlying memory events.
