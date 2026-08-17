// Detect whether the Claude Code CLI's final message is asking the user for
// input (a question / a choice among options) rather than reporting completed
// work (issue #185, increment 1 — detection only; not wired into server.js's
// run path yet, and does not touch memory.js or the SFN contract).
//
// Signal keyed on: the caller passes `resultText`, the `result` field of the
// CLI's `--output-format json` final object (this is exactly the string
// `runClaudeCode` in server.js resolves via `parsed.result` as the run's
// final text). The CLI output has no distinct "asking for input" event today
// — an ask-for-input turn is just a normal assistant text block — so the only
// concrete, always-present signal available post-hoc is the final message's
// own text ending in a question mark. This is a
// heuristic (it will miss a question that isn't the very last sentence, and
// could rarely misfire on a rhetorical closing question) but it's cheap,
// requires no CLI/model cooperation, and errs toward false negatives (a
// missed ask-for-input just behaves as today: the run completes normally)
// rather than false positives.
//
// The extracted `question` is the final non-empty line of the text, which
// covers the common shape of a numbered/bulleted list of options followed by
// a one-line question (see detect-awaiting-input.test.mjs for both cases).
export function detectAwaitingInput(resultText) {
  const text = typeof resultText === 'string' ? resultText.trim() : '';
  if (!text || !text.endsWith('?')) return { awaiting: false };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return { awaiting: true, question: lines[lines.length - 1] };
}
