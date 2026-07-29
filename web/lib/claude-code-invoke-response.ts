/**
 * Extract the assistant-facing text from the ClaudeCode runtime's HTTP
 * response body. The synchronous path (agent/default/app/ClaudeCode/server.js,
 * no `taskToken`) replies with `{ result: string }` on success or
 * `{ error: string }` on failure (HTTP 500); anything else (non-JSON body) is
 * passed through verbatim. Kept in its own module (no AWS SDK / Amplify
 * imports) so it stays plain-Node-testable.
 */
export function parseInvokeResponseText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { result?: string; error?: string };
    return parsed.result ?? parsed.error ?? raw;
  } catch {
    return raw;
  }
}
