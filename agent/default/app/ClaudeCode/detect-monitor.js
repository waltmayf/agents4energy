// Detect whether the Claude Code CLI's final message is requesting a
// **monitor handoff** — the run is waiting on an external async condition (a
// deploy, a CI run, a long job) rather than busy-waiting in-session, and wants
// the state machine to poll a check command on its behalf while the AgentCore
// microVM is reclaimed (issue #261, part 1/3 of the monitor-loop epic #260).
//
// Signal: a fenced ```monitor``` code block in the final message, containing a
// JSON object. Two shapes, both requiring `followUpPrompt`:
//
//   1. Condition poll — `checkCommand` present:
//      { "intervalSeconds": number, "maxIterations": number,
//        "checkCommand": string, "followUpPrompt": string }
//      The state machine polls `checkCommand` every `intervalSeconds` (up to
//      `maxIterations` times) and re-invokes once it exits 0.
//
//   2. Timed wait — no `checkCommand` (issue #377): a single, unconditional
//      wait, for when the orchestrator wants to pause for a self-specified
//      duration (e.g. "give workers ~3h to deliver") and doesn't need a
//      condition check at all.
//      { "waitSeconds": number, "followUpPrompt": string }
//      `waitSeconds` falls back to `intervalSeconds` if that's what's given
//      instead (both names are accepted so a run doesn't need to remember
//      which shape uses which field name).
//
// `followUpPrompt` is always required — a block missing it, or one with
// neither `waitSeconds` nor `intervalSeconds` resolving to a valid number, or
// one that isn't valid JSON, or no block at all, must fall through to normal
// completion (never strand the run on a malformed handoff request).
// The returned spec is tagged with `kind: 'condition' | 'timed'` so the state
// machine can route it without re-deriving which shape was used.
const MIN_INTERVAL_SECONDS = 30;
// The Step Functions `Wait` state accepts up to 99,999,999 seconds (~3.17
// years) via SecondsPath — issue #377 raises our own clamp to match it, so a
// monitor can request an arbitrarily long single wait/poll interval. Note
// this is NOT the practical ceiling: a Standard Workflow execution hard-fails
// at 1 year regardless (AWS quota, not adjustable) — see docs/monitor-loop.md.
const MAX_INTERVAL_SECONDS = 99999999;
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_MAX_ITERATIONS = 1;
const MAX_MAX_ITERATIONS = 40;
const DEFAULT_MAX_ITERATIONS = 10;

const MONITOR_BLOCK_RE = /```monitor\s*\n([\s\S]*?)```/;

function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(n, min), max);
}

export function detectMonitorRequest(resultText) {
  const text = typeof resultText === 'string' ? resultText.trim() : '';
  if (!text) return { monitor: false };

  const match = MONITOR_BLOCK_RE.exec(text);
  if (!match) return { monitor: false };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { monitor: false }; // Malformed JSON — fall through, don't strand the run.
  }
  if (!parsed || typeof parsed !== 'object') return { monitor: false };

  const { checkCommand, followUpPrompt, intervalSeconds, maxIterations, waitSeconds } = parsed;
  if (typeof followUpPrompt !== 'string' || !followUpPrompt.trim()) return { monitor: false };

  const hasCheckCommand = typeof checkCommand === 'string' && checkCommand.trim();

  if (hasCheckCommand) {
    return {
      monitor: true,
      spec: {
        kind: 'condition',
        intervalSeconds: clamp(intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS),
        maxIterations: clamp(maxIterations, MIN_MAX_ITERATIONS, MAX_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS),
        checkCommand: checkCommand.trim(),
        followUpPrompt: followUpPrompt.trim(),
      },
    };
  }

  // No checkCommand — a timed wait (issue #377). `waitSeconds` is the primary
  // field name; fall back to `intervalSeconds` for a run that reused the
  // condition-poll field name by habit.
  const rawWait = typeof waitSeconds === 'number' ? waitSeconds : intervalSeconds;
  return {
    monitor: true,
    spec: {
      kind: 'timed',
      waitSeconds: clamp(rawWait, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS),
      followUpPrompt: followUpPrompt.trim(),
    },
  };
}
