/**
 * Deriving a human-readable chat-session title from its first user message
 * (issue #352). Pure + dependency-free so it's unit-testable and shared between
 * the auto-naming hook and anywhere else a title is needed.
 */

/** Placeholder name a session carries until its first message lands. */
export const DEFAULT_SESSION_NAME = 'New Chat';

/** Longest auto-derived title we keep before truncating with an ellipsis. */
export const MAX_TITLE_LENGTH = 60;

/**
 * True when `name` is empty/whitespace or still the untouched placeholder —
 * i.e. the session has never been given a real title, so auto-naming may claim
 * it. A user-renamed session (any other non-empty string) is left alone.
 */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  return trimmed === '' || trimmed === DEFAULT_SESSION_NAME;
}

/**
 * Turn a first user message into a compact session title: collapse all runs of
 * whitespace (including newlines) to single spaces, trim, and truncate to
 * `maxLength` on a word boundary where possible, appending an ellipsis. Returns
 * `null` when there's nothing usable so the caller can keep the placeholder.
 */
export function deriveSessionTitle(
  message: string,
  maxLength: number = MAX_TITLE_LENGTH,
): string | null {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;

  const clipped = normalized.slice(0, maxLength);
  // Prefer to cut at the last space so we don't truncate mid-word, but only if
  // that space isn't so early it throws away most of the title.
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > maxLength * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}
