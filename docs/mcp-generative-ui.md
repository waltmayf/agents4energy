# MCP Generative UI

An MCP tool normally returns data that the chat UI dumps as a plain YAML block. This doc describes how a tool can instead return a **structured content block** that the chat renderer shows as a rich widget (a table, a metric grid, or sandboxed HTML) — and how to add support for a new widget type.

See [`docs/use-case-packs.md`](use-case-packs.md) for how a pack wires an agent to a tool in the first place; this doc is about what that tool *returns*.

## The structured-content contract

Bedrock Converse's `toolResult.content` items are always one of two shapes (there is no dedicated "UI" wire type):

```ts
interface RawToolResultItem {
  text?: string;
  json?: unknown;
}
```

The convention (defined in #473, decoded by the renderer in #475) is: a `json` item is treated as a **UI block** if — and only if — its value is a plain object with a **string** `mimeType` field:

```ts
type UiBlockValue = { mimeType: string; spec?: unknown; html?: string };
```

Everything else (a bare `text` string, or a `json` value with no `mimeType`) renders exactly as it always has — a YAML dump. This means a tool doesn't opt in to anything special to keep working as before; adding a widget is purely additive.

Concretely, for the Lambda-backed gateway-target pattern this repo uses (see `web/amplify/functions/s3-tools/handler.ts` for a real example), the Gateway passes your handler's return value straight through as that `json` field. So to render a widget, a handler's return value needs to look like:

```ts
return {
  // ...whatever plain fields you want the *model* to keep reasoning over...
  mimeType: 'application/vnd.agents4energy.ui+json', // COMPONENT_SPEC_MIME, web/lib/component-spec.ts
  spec: { type: 'table', columns: ['Name', 'Type'], rows: [['a.txt', 'file']] },
};
```

Two things worth calling out:

- **`mimeType` isn't enforced against a fixed value for the `spec` path.** The renderer only special-cases the literal string `text/html` (see below); any other string `mimeType` paired with a `spec` field is tried against the component-spec registry. `COMPONENT_SPEC_MIME` (`application/vnd.agents4energy.ui+json`, `web/lib/component-spec.ts`) is a *documented convention*, not something the code checks for — use it anyway, so a reader of the raw tool result can tell at a glance what produced it.
- **Extra fields beyond `mimeType`/`spec`/`html` are fine and are ignored by the renderer**, but they still reach the model on the next turn (the AG-UI encoding described below is a frontend-only concern — the actual Bedrock Converse call the model sees uses the Lambda's raw return value). This is why `handleListFiles` keeps its plain `entries` array *alongside* `mimeType`/`spec`: the model keeps an easy-to-reason-about shape, the renderer additionally gets a widget.

### `text/html` vs a JSON component-spec

Two shapes are recognized inside a UI block:

| `part.mimeType` | Field used | Rendered as |
|---|---|---|
| exactly `"text/html"` | `part.html: string` | a sandboxed `<iframe>` (below) |
| anything else | `part.spec: unknown` | looked up in the component-spec registry; unrecognized shapes fall back to YAML |

Both `spec` and `html` are capped at `MAX_SPEC_BYTES` / `MAX_HTML_BYTES` = 200,000 bytes each (`web/lib/component-spec.ts`) — an oversized block also falls back to a YAML dump of the raw part, so a runaway tool result can't blow up the DOM.

## How this reaches the browser

1. Your Lambda/handler returns the shape above; the AgentCore Gateway forwards it as Converse's `toolResult.content: [{ json: <your return value> }]`.
2. Both AG-UI translators — `web/lib/converse-to-agui.ts` (reload path) and `web/lib/harness-stream-to-agui.ts` (live streaming path) — detect the `mimeType` field via `toToolResultPart()`/`isUiBlockValue()` (`web/lib/tool-result-content.ts`) and, only when at least one part is a UI block, JSON-encode the whole content array behind a sentinel envelope (`{ __aguiToolResult: 'v1', parts: [...] }`) since AG-UI's `content` field is string-typed. Plain text/JSON results skip this and flatten exactly as before — no behavior change for existing tools.
3. The renderer (`web/app/(with-auth)/chat/tool-call-renderer.tsx`, `ToolResultView`/`ToolResultPartView`) detects the envelope, decodes it, and dispatches each part to either `SandboxedHtml` or `renderComponentSpec()`.

## Supported component-spec types

Defined in `web/lib/component-spec.ts`, rendered by `web/app/(with-auth)/chat/tool-widgets/registry.tsx`:

| `spec.type` | Shape | Component |
|---|---|---|
| `table` | `{ type: 'table', title?, columns: string[], rows: Array<Array<string\|number\|boolean\|null>> }` | `TableWidget` |
| `metric-grid` | `{ type: 'metric-grid', title?, metrics: Array<{ label: string, value: string\|number, unit?: string }> }` | `MetricGridWidget` |

### Adding a new widget type

1. Add the spec's TypeScript shape and a `parseXSpec(value): XSpec | null` type guard to `web/lib/component-spec.ts`, and add it to the `ComponentSpec` union and `parseComponentSpec()`'s dispatch chain. Keep this file React-free — it's unit-tested without a DOM (`component-spec.test.ts`).
2. Add the React component under `web/app/(with-auth)/chat/tool-widgets/`.
3. Add one entry to `WIDGET_REGISTRY` in `registry.tsx` mapping the new `type` discriminant to the component. Nothing else in the renderer needs to change.
4. Have a tool return `{ mimeType: COMPONENT_SPEC_MIME, spec: { type: '<your-type>', ... } }` to exercise it.

## Security: the HTML escape hatch

`text/html` blocks render inside a sandboxed `<iframe>` (`web/app/(with-auth)/chat/tool-widgets/sandboxed-html.tsx`) via `srcDoc`, **never** `dangerouslySetInnerHTML` into the app DOM. The sandbox attribute is deliberately the empty token list:

```html
<iframe sandbox="" srcDoc={html} />
```

That's every restriction on at once: no script execution, no form submission, no popups, no top-level navigation — and critically, no `allow-same-origin`. `srcDoc` already gives the frame an opaque `about:srcdoc` origin; `allow-same-origin` would let a future `allow-scripts` addition read this app's origin (cookies, `localStorage`). If a widget genuinely needs interactivity, add `allow-scripts` **alone** — never paired with `allow-same-origin` — and document why at the call site.

Practical guidance for tool authors:
- Prefer a component-spec over raw HTML whenever a supported widget type fits the data — it's rendered by trusted, reviewed React, not sandboxed guesswork.
- Reach for `text/html` only for layouts the registry doesn't support yet; treat the HTML as attacker-controlled the moment it includes any tool-influenced or user-influenced string (a filename, a query result), since a compromised or buggy upstream MCP server could return it.
- Don't rely on `mimeType` as a security boundary — it is a rendering hint the client trusts for *dispatch*, not a value the server enforces.

## Worked example: `ListFiles` in the S3 filesystem explorer pack

`web/amplify/functions/s3-tools/handler.ts`'s `ListFiles` tool (used by the `s3-filesystem-explorer` pack, [`docs/use-case-packs.md`](use-case-packs.md)) returns a `table` component-spec built from the same directory listing it always computed:

```ts
const tableSpec: TableSpec = {
  type: 'table',
  title: `Files in ${path ?? '/'}`,
  columns: ['Name', 'Type', 'Size (bytes)'],
  rows: entries.map((e) => [e.name, e.type, e.type === 'file' ? e.size : '']),
};

return { path: path ?? '/', entries, mimeType: COMPONENT_SPEC_MIME, spec: tableSpec };
```

Asking the `s3-filesystem-explorer` agent to list a directory now renders a table widget in chat instead of a YAML dump of `entries`, while the model still has the plain `entries` array to reason over on later turns.
