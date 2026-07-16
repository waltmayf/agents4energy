// Converts a raw harness/Bedrock failure cause (the `$.error.Cause` string the
// Step Function's InvokeHarness Catch surfaces) into a concise, actionable
// message to post on the issue/PR — instead of dumping the raw exception.
//
// The most important case is context-window overflow (issue #140): when the
// agent runs a command whose output is huge (e.g. repo-wide `pnpm lint`, which
// emits tens of thousands of lines), that output accumulates in the model's
// context and the next turn fails with:
//   "Input length (1163485) exceeds model's maximum context length (131072)."
// This happens inside the AWS-managed harness turn, so it can't be truncated at
// our transport layer — but we can at least explain it clearly rather than
// posting a raw Bedrock ValidationException that reads like an outage.

// `model's` may use a straight ('), curly (’), or no apostrophe depending on
// how Bedrock/Mantle formats the message.
const CONTEXT_OVERFLOW_RE =
  /Input length \((\d+)\) exceeds model['’]?s maximum context length \((\d+)\)/i;

/**
 * If `cause` is a recognized harness failure, return a human-friendly
 * explanation; otherwise return null (caller falls back to the raw cause).
 */
export function friendlyHarnessError(cause: string | undefined | null): string | null {
  if (!cause) return null;

  const overflow = cause.match(CONTEXT_OVERFLOW_RE);
  if (overflow) {
    const [, inputLen, maxLen] = overflow;
    return [
      `⚠️ The agent run was aborted: its context window overflowed ` +
        `(input ${Number(inputLen).toLocaleString()} tokens exceeded the model's ${Number(maxLen).toLocaleString()}-token limit).`,
      '',
      'This usually means a command produced far too much output — most often a ' +
        'repo-wide `pnpm lint` or a large file dump — which was fed back into the ' +
        "model's context. No changes were made.",
      '',
      'Try narrowing the task, or re-run after the output-heavy step is scoped down ' +
        '(e.g. lint/type-check only the changed files, or pipe output through `tail`).',
    ].join('\n');
  }

  return null;
}
