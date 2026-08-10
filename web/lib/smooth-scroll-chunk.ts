/**
 * Buffered-reply chunking for smooth auto-scroll (issue #268).
 *
 * The ClaudeCode runtime is a *buffered* path — it returns its whole answer at
 * once (see claude-code-agent.ts). Emitting that as a single TEXT_MESSAGE_CONTENT
 * makes the message node grow in one large layout step, which escapes
 * CopilotChat's use-stick-to-bottom smooth pin (it animates toward a target that
 * jumps in one frame), so the view fails to auto-scroll and appears to jump
 * around. Replaying the reply as a bounded set of incremental deltas — with a
 * yield between them — lets the scroll container observe each resize and stay
 * pinned to the bottom, matching the token-stream path's behaviour.
 *
 * Kept in its own module (no JSON/SDK imports) so it stays unit-testable.
 */

/** Max deltas to split a reply into. */
export const SCROLL_CHUNK_TARGET = 24;
/** Don't bother chunking below this many chars — replay as one delta. */
export const SCROLL_CHUNK_MIN_SIZE = 40;
/** Delay between deltas (~one animation frame) so React commits + re-pins. */
export const SCROLL_CHUNK_DELAY_MS = 16;

/**
 * Split `text` into a small, roughly even set of chunks for incremental
 * emission. Short replies pass through as a single chunk (no perceptible delay);
 * longer ones are broken at character boundaries into at most SCROLL_CHUNK_TARGET
 * pieces. Concatenating the result always reproduces `text` exactly.
 */
export function chunkForSmoothScroll(text: string): string[] {
  if (text.length <= SCROLL_CHUNK_MIN_SIZE) return [text];
  const size = Math.max(SCROLL_CHUNK_MIN_SIZE, Math.ceil(text.length / SCROLL_CHUNK_TARGET));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
