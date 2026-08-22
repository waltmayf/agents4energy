/**
 * Shared structured-tool-result encoding used by both AG-UI translators —
 * `converse-to-agui.ts` (reload path) and `harness-stream-to-agui.ts` (live
 * path). AG-UI's `TOOL_CALL_RESULT.content` / role:'tool' message `content`
 * are string-typed, so a structured payload (a JSON UI-spec, a mimeType-
 * tagged block) is JSON-encoded behind a sentinel tag a structured-aware
 * renderer (#475) can detect and decode.
 *
 * Bedrock Converse only ever sends `text` or `json` for toolResult content
 * (see `HarnessToolResultContentBlock` in the AgentCore SDK types) — there is
 * no dedicated "UI block" wire type. The convention here is: a `json` content
 * item whose value is a plain object with a string `mimeType` field is a UI
 * block; every other `text`/`json` item is plain content, flattened exactly
 * as before so today's renderer shows it unchanged (no visual regression).
 */

/** One raw Converse toolResult content item — Bedrock only sends `text` or `json`. */
export interface RawToolResultItem {
  text?: string;
  json?: unknown;
}

/** One decoded tool-result content part. */
export type ToolResultPart =
  | { kind: 'text'; text: string }
  | { kind: 'ui'; mimeType: string; spec?: unknown; html?: string };

const ENVELOPE_TAG = '__aguiToolResult';

interface ToolResultEnvelope {
  __aguiToolResult: 'v1';
  parts: ToolResultPart[];
}

/** True if a decoded `json` content value is a UI block: `{ mimeType, spec?, html? }`. */
function isUiBlockValue(value: unknown): value is { mimeType: string; spec?: unknown; html?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).mimeType === 'string'
  );
}

/** Convert one raw Converse toolResult content item into a typed part, or null if empty/unparseable. */
export function toToolResultPart(item: RawToolResultItem): ToolResultPart | null {
  if (typeof item?.text === 'string' && item.text) return { kind: 'text', text: item.text };
  if (item?.json != null) {
    if (isUiBlockValue(item.json)) {
      const { mimeType, spec, html } = item.json;
      return {
        kind: 'ui',
        mimeType,
        ...(spec !== undefined ? { spec } : {}),
        ...(html !== undefined ? { html } : {}),
      };
    }
    try {
      return { kind: 'text', text: JSON.stringify(item.json) };
    } catch {
      return null;
    }
  }
  return null;
}

/** True if any part carries structured (non-text) content that needs the envelope. */
export function hasStructuredPart(parts: ToolResultPart[]): boolean {
  return parts.some((p) => p.kind === 'ui');
}

/**
 * JSON-encode parts behind a sentinel tag. Only called when `hasStructuredPart`
 * is true — the non-structured path keeps each translator's original plain-
 * string flattening untouched.
 */
export function encodeToolResultParts(parts: ToolResultPart[]): string {
  const envelope: ToolResultEnvelope = { __aguiToolResult: 'v1', parts };
  return JSON.stringify(envelope);
}

/** Decode a `content` string possibly produced by encodeToolResultParts; null if it's plain (non-enveloped) text. */
export function decodeToolResultContent(content: string): ToolResultPart[] | null {
  if (!content || content[0] !== '{') return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed[ENVELOPE_TAG] === 'v1' && Array.isArray(parsed.parts)) {
      return parsed.parts as ToolResultPart[];
    }
  } catch {
    // plain text / non-JSON content — nothing to decode
  }
  return null;
}
