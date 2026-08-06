// Detect whether the Claude Code CLI's final message contains a ````monitor```` fenced block
// defining a monitoring specification. This enables the runtime to hand off
// control so the microVM can be released while the monitor polls an external
// condition.
//
// The block should be a JSON object with the following fields (all required
// unless otherwise noted):
//   intervalSeconds: number (clamped to [30, 900], default 30)
//   maxIterations:   number (clamped to [1, 40],   default 1)
//   checkCommand:    string (required)
//   followUpPrompt:  string (required)
//
// If the block is missing, malformed, or required fields are absent, the function
// returns { monitor: false } – the caller should fall back to normal final comment
// handling. When valid, it returns { monitor: true, spec: { intervalSeconds,
// maxIterations, checkCommand, followUpPrompt } }.

export function detectMonitorRequest(finalText) {
  if (typeof finalText !== 'string') return { monitor: false };
  const text = finalText.trim();
  // Look for a fenced code block with language identifier "monitor"
  const monitorBlockMatch = /```monitor\n([\s\S]*?)```/.exec(text);
  if (!monitorBlockMatch) return { monitor: false };
  let parsed;
  try {
    parsed = JSON.parse(monitorBlockMatch[1]);
  } catch (e) {
    return { monitor: false };
  }
  const { intervalSeconds, maxIterations, checkCommand, followUpPrompt } = parsed ?? {};
  // Required fields must be non-empty strings
  if (typeof checkCommand !== 'string' || !checkCommand.trim()) return { monitor: false };
  if (typeof followUpPrompt !== 'string' || !followUpPrompt.trim()) return { monitor: false };
  // Clamp numeric values, applying defaults if missing or not a number
  let interval = typeof intervalSeconds === 'number' ? intervalSeconds : 30;
  let maxIter = typeof maxIterations === 'number' ? maxIterations : 1;
  // Apply clamping bounds
  interval = Math.min(Math.max(interval, 30), 900);
  maxIter = Math.min(Math.max(maxIter, 1), 40);
  return {
    monitor: true,
    spec: {
      intervalSeconds: interval,
      maxIterations: maxIter,
      checkCommand: checkCommand.trim(),
      followUpPrompt: followUpPrompt.trim(),
    },
  };
}
