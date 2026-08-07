// Detect whether the Claude Code CLI's final message is requesting a
// **monitor handoff** — the run is waiting on an external async condition (a
// deploy, a CI run, a long job) rather than busy-waiting in-session, and wants
// the state machine to poll a check command on its behalf while the AgentCore
// microVM is reclaimed (issue #261, part 1/3 of the monitor-loop epic #260).
//
// Signal: a fenced ```monitor``` code block in the final message, containing a
// JSON object:
//   { "intervalSeconds": number, "maxIterations": number,
//     "checkCommand": string, "followUpPrompt": string }
//
// `checkCommand` and `followUpPrompt` are required — a block missing either,
// or one that isn't valid JSON, or no block at all, must fall through to
// normal completion (never strand the run on a malformed handoff request).
// `intervalSeconds`/`maxIterations` are optional; when present they're clamped
// into a safe range, and default to a moderate value when absent so a run that
// forgets them still gets a sane poll cadence rather than being rejected.
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 900;
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

  const { checkCommand, followUpPrompt, intervalSeconds, maxIterations } = parsed;
  if (typeof checkCommand !== 'string' || !checkCommand.trim()) return { monitor: false };
  if (typeof followUpPrompt !== 'string' || !followUpPrompt.trim()) return { monitor: false };

  return {
    monitor: true,
    spec: {
      intervalSeconds: clamp(intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS),
      maxIterations: clamp(maxIterations, MIN_MAX_ITERATIONS, MAX_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS),
      checkCommand: checkCommand.trim(),
      followUpPrompt: followUpPrompt.trim(),
    },
  };
}
