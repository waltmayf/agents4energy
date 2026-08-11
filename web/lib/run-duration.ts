// Human-readable run duration for the webhook final comment (issue #321).
//
// The Step Function passes the execution's ISO-8601 start time
// ($$.Execution.StartTime) to agent-webhook-post-comment, which diffs it
// against "now" and prepends a line like "Agent finished after 74 minutes"
// above the agent's final message. Kept pure (no clock, no AWS) so it's unit
// testable — the handler passes in both timestamps.

/** Round to a whole number and pick the correct singular/plural unit. */
function unit(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

/**
 * Format an elapsed duration (milliseconds) as a short human phrase:
 *   < 1 min      -> "42 seconds" / "1 second"
 *   < 1 hour     -> "37 minutes" / "1 minute"
 *   >= 1 hour    -> "2 hours 5 minutes" / "1 hour" (minutes omitted when 0)
 *
 * A non-finite or negative duration (clock skew, bad input) returns null so the
 * caller simply omits the line rather than posting nonsense.
 */
export function formatDurationMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return unit(totalSeconds, 'second');

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return unit(totalMinutes, 'minute');

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}

/**
 * Build the "Agent finished after N" prefix from an ISO-8601 start time and an
 * end time (ms epoch, injectable for tests; defaults to Date.now()). Returns
 * null when the start time is missing/unparseable or the duration is invalid,
 * so the caller can skip the line entirely.
 *
 * `label` lets the failure path say "Agent failed after …" instead.
 */
export function buildRunDurationLine(
  executionStartTime: string | undefined | null,
  nowMs: number = Date.now(),
  label = 'Agent finished after',
): string | null {
  if (!executionStartTime) return null;
  const startMs = new Date(executionStartTime).getTime();
  if (Number.isNaN(startMs)) return null;
  const phrase = formatDurationMs(nowMs - startMs);
  return phrase ? `${label} ${phrase}` : null;
}
