# Generative UI Authoring Guide

This document describes how **MCP tools** can return structured UI specifications that are rendered directly in the chat interface.

## Structured‑content contract
When an MCP tool wants to emit a UI widget, it should return a content block with the following shape:

```json
{
  "type": "ui_spec",
  "content": {
    "type": "<component-type>",
    "data": { /* component‑specific payload */ }
  }
}
```

* `type` must be `"ui_spec"` to signal the renderer that this block contains a component specification rather than plain text.
* `content.type` is the identifier of the widget. The built‑in registry currently supports:
  * `"image"` – displays an image.
  * `"chart"` – renders a simple chart.
  * `"html"` – sandboxed HTML snippet (rendered inside an iframe).
* `content.data` holds the JSON payload required by the component. For example, an image widget expects `{ "url": "https://example.com/img.png", "alt": "optional alt text" }`.

### Adding a new widget type
1. Implement the component in the frontend under `web/components/generative/`.
2. Register the component in `web/lib/generative-widget-registry.ts` by adding an entry mapping the `type` string to the React component.
3. Update the TypeScript union `GeneratedComponentSpec` in the same file to include the new payload shape.
4. Deploy – the UI will automatically be able to render the new type when a tool returns it.

## Security & sandboxing
* **HTML widgets** are rendered inside an isolated `<iframe sandbox>` with the following restrictions: `allow-scripts` is **not** granted, preventing execution of arbitrary JavaScript. Only safe HTML/CSS is allowed.
* All URLs used by widgets (e.g., image sources) are fetched via the browser; CORS policies apply.
* The content is never stored in the backend – it lives only in the transient chat UI, minimizing attack surface.

## Example tool implementation
Below is a minimal MCP tool that returns an `image` widget.

```ts
// packs/example-pack/tools/show‑logo.ts
import type { Handler } from 'aws-lambda';

export const handler: Handler = async () => {
  return {
    type: 'ui_spec',
    content: {
      type: 'image',
      data: {
        url: 'https://example.com/logo.png',
        alt: 'Example logo'
      }
    }
  };
};
```

When this tool is invoked, the chat UI will render the image inline.

---
For a full end‑to‑end example, see the **example‑pack** in the repository which includes a chart widget.
