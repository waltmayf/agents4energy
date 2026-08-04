# Chat Session List Page — Design

## Goal

Add a page that lists the current user's chat sessions, and back it with a
DynamoDB secondary index so "my sessions" is a key **Query** rather than a
full-table **Scan-with-filter**.

## Route & Navigation

- New route: `web/app/(with-auth)/sessions/page.tsx` (top-level, sibling to
  `/chat` and `/agents`).
- `BackButton` derives "up" by dropping the last path segment, so `/sessions`
  → `/` (landing) for free — no extra wiring.
- Add a third action link ("Your sessions") to the landing page
  (`web/app/page.tsx`) alongside "Open the console" and "Agent Builder", so the
  page is reachable.

## Secondary Index (the efficiency requirement)

`ChatSession` currently uses the implicit `allow.owner()` rule, which creates an
`owner` field but **no index** — `.list()` is a table Scan that Amplify filters
down to the caller's rows. Make the owner field explicit and index it, mirroring
the existing `ActiveRun` GSI pattern directly below it in the same schema file.

```ts
ChatSession: a.model({
  name: a.string(),
  // Slug of the Agent this session is scoped to. Drives model + system prompt + gateway tools.
  agentId: a.string(),
  owner: a.string(),          // was implicit; now explicit so it can be indexed
  mapBounds: a.json(),
  lineageSummary: a.json(),
})
  // Turns "my sessions" from a full-table Scan into an O(1) key Query.
  // Exposed as listChatSessionByOwner(owner) on the client + GraphQL API.
  .secondaryIndexes((index) => [index('owner').queryField('listChatSessionByOwner')])
  .authorization((allow) => [allow.ownerDefinedIn('owner'), allow.authenticated(), allow.guest()]),
```

Notes:
- Field name stays `owner`, so existing records keep working — **no data
  migration**.
- Switch `allow.owner()` → `allow.ownerDefinedIn('owner')` so the explicit
  field is used as the ownership field (the default implicit rule expects a
  managed field). The other rules (`authenticated`, `guest`) are pre-existing
  and left untouched.
- During implementation, verify the exact stored owner-string value against a
  real record via `scripts/graphql.sh` so the client passes the correct key to
  `listChatSessionByOwner`.
- Sessions per user are modest — sort by recency client-side (on `createdAt`)
  rather than adding a sort key to the index.

## Page

Single-column list styled to match the agents page conventions:

- Client: `generateClient<Schema>({ authMode: 'userPool' })` (as in the chat
  code).
- Load via `listChatSessionByOwner(owner)`, paginate with a `listAll`-style
  helper following `nextToken` (same shape as the agents page). Sort results by
  `createdAt` descending client-side.
- Loading spinner and empty state mirror the agents page.
- `data-testid` attributes on rows and controls, matching agents-page style.

Each session row supports:

1. **Open** — row click navigates to `/chat?sessionId=<id>` (resumes via the
   existing `useChatSession`).
2. **Rename** — inline edit of the `name` field (sessions default to
   "New Chat"); persists with `ChatSession.update`.
3. **Delete** — confirm dialog reusing the agents page's `DeleteConfirmDialog`
   pattern, then `ChatSession.delete`, then remove the row from local state.

Header controls:

- **New chat** button → navigates to `/chat` (starts a fresh session via the
  existing bootstrap flow).

## Out of Scope

- The pre-existing broad `allow.authenticated()` / `allow.guest()` read rules on
  `ChatSession` are not changed — this work only makes the owner-scoped query
  efficient and adds the listing UI. Row-level security tightening is a separate
  concern.
- No sort-key / GSI-side ordering; recency sort is client-side.

## Testing

- Type-check with `npx tsc --noEmit` before pushing.
- Manual verification: create sessions in `/chat`, confirm they appear in
  `/sessions`, and that open / rename / delete / new-chat all behave.
- Confirm the generated GraphQL exposes `listChatSessionByOwner` (via
  `scripts/graphql.sh`) after the schema change deploys.
