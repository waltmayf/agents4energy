// The webhook harness is backed by `openai.gpt-oss-120b`, which is trained on
// OpenAI's "Harmony" chat-response format. That format wraps tool calls and
// channel routing (analysis / commentary / final) in special tokens like
// `<|channel|>`, `<|message|>`, `<|start|>`, `<|end|>`, and role/recipient
// headers such as `commentary to=functions.shell`. Bedrock's invokeHarness
// Converse decoding normally parses these into structured blocks, but they can
// leak into the plain-text content block instead (issue #105) — e.g. the final
// GitHub comment on #62 was posted verbatim as:
//
//   Now cd repo.</assistant<|channel|>commentary to=functions.shell   <|message|>{"command":"cd agents4energy && pnpm install","timeout": 1000000}
//
// `sanitizeHarmony` strips these artifacts so the comment we post reads as the
// natural-language response the model intended. It is deliberately conservative:
// it removes Harmony control markup and any content routed to the non-final
// (analysis / commentary) channels, and keeps ordinary prose untouched.

// The Harmony special tokens. `<|constrain|>` and `<|return|>` are included for
// completeness even though they're rarer in leaked text.
const HARMONY_TOKENS = [
  '<|start|>',
  '<|end|>',
  '<|message|>',
  '<|channel|>',
  '<|constrain|>',
  '<|return|>',
];

// A leaked shell tool-call payload — the JSON the model emits to invoke the
// built-in `functions.shell` tool — that ended up in the plain-text channel
// instead of a structured tool-use block (issue #149). Seen with NO Harmony
// delimiters at all, e.g. the final comment on #31 was verbatim:
//   Now commit.{"command":"cd agents4energy && git commit -m ...","timeout":100000}
// Matches a `{ ... }` object containing a "command" key and optionally a
// "timeout" key. Anchored to the JSON object so surrounding prose is preserved.
const SHELL_TOOL_CALL_JSON = /\{\s*"(?:command|cmd)"\s*:\s*"[^]*?"(?:\s*,\s*"timeout"\s*:\s*\d+)?\s*\}/g;

/** True if `text` contains any Harmony special token, a stray role/close tag, or a leaked shell tool-call JSON. */
export function looksLikeHarmony(text: string): boolean {
  if (HARMONY_TOKENS.some((t) => text.includes(t))) return true;
  // A leaked bare tool-call payload (no delimiters) is another tell (#149).
  SHELL_TOOL_CALL_JSON.lastIndex = 0;
  if (SHELL_TOOL_CALL_JSON.test(text)) return true;
  // A stray `</assistant` / `<|assistant|>`-style role marker (no proper close)
  // is another tell seen in leaked output.
  return /<\/?\|?(assistant|user|system|developer|tool)\|?>?/i.test(text);
}

/**
 * Strip Harmony formatting artifacts from a model text response.
 *
 * Strategy:
 *  1. Drop any content on the `analysis` / `commentary` channels (chain-of-thought
 *     and tool-call scaffolding the user should never see), keeping only the
 *     `final` channel's message when channel markers are present.
 *  2. Remove any remaining Harmony control tokens and role/recipient headers.
 *  3. Collapse the whitespace the removals leave behind.
 *
 * If the input has no Harmony markers it is returned unchanged (aside from a
 * trim), so clean responses are never altered.
 */
export function sanitizeHarmony(input: string): string {
  if (!input) return input;
  if (!looksLikeHarmony(input)) return input.trim();

  let text = input;

  // 1. Prefer the final channel. Harmony encodes channels as
  //    `<|channel|>final<|message|>...` (optionally with a `to=...` recipient
  //    before `<|message|>`). If a `final` channel message exists, keep only
  //    its content and discard analysis/commentary entirely.
  const finalChannel = /<\|channel\|>\s*final\b[^]*?<\|message\|>([^]*?)(?=<\|(?:channel|start|end|return)\|>|$)/i;
  const finalMatch = text.match(finalChannel);
  if (finalMatch) {
    text = finalMatch[1];
  } else {
    // No explicit final channel — remove whole analysis/commentary segments
    // (header through the end of that segment) so their scaffolding doesn't
    // survive as loose text.
    text = text.replace(
      /<\|channel\|>\s*(?:analysis|commentary)\b[^]*?(?=<\|channel\|>|<\|start\|>|<\|end\|>|<\|return\|>|$)/gi,
      '',
    );
  }

  // 2. Strip role/recipient headers like `commentary to=functions.shell`,
  //    `assistant`, and any stray `</assistant` / `<|assistant|>` role tags,
  //    then remove the remaining control tokens.
  text = text
    .replace(/\b(?:analysis|commentary|final)\s+to=[^\s<|]+/gi, '')
    // Bare role header wedged between control tokens, e.g. `<|start|>assistant<|message|>`.
    .replace(/(<\|start\|>)\s*(?:assistant|user|system|developer|tool)\s*(?=<\|)/gi, '$1')
    .replace(/<\/?\|?(?:assistant|user|system|developer|tool)\|?>?/gi, '')
    .replace(/\bto=functions\.[^\s<|{]+/gi, '');
  for (const token of HARMONY_TOKENS) {
    text = text.split(token).join('');
  }

  // Strip any leaked shell tool-call JSON payload (#149) — it can appear with no
  // Harmony delimiters, so it survives the token removal above.
  text = text.replace(SHELL_TOOL_CALL_JSON, '');

  // 3. Tidy whitespace left behind by the removals.
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
