// Unit test for detectMonitorRequest (issue #260, part 1)
//
// Run: node --test agent/default/app/ClaudeCode/detect-monitor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMonitorRequest } from './detect-monitor.js';

function mkBlock(obj) {
  return `\n\`\`\`monitor\n${JSON.stringify(obj)}\n\`\`\``;
}

test('valid monitor block is detected with clamping and defaults', () => {
  const finalText = mkBlock({
    intervalSeconds: 1200, // above max, should clamp to 900
    maxIterations: 0, // below min, clamp to 1
    checkCommand: "echo done",
    followUpPrompt: "All done",
  }) + '\nExtra text after';
  const result = detectMonitorRequest(finalText);
  assert.deepEqual(result, {
    monitor: true,
    spec: {
      intervalSeconds: 900,
      maxIterations: 1,
      checkCommand: 'echo done',
      followUpPrompt: 'All done',
    },
  });
});

test('missing required fields results in no monitor', () => {
  const finalText = mkBlock({ intervalSeconds: 60, maxIterations: 5 });
  assert.deepEqual(detectMonitorRequest(finalText), { monitor: false });
});

test('malformed JSON yields no monitor', () => {
  const finalText = '`monitor\n{bad json}\n```';
  assert.deepEqual(detectMonitorRequest(finalText), { monitor: false });
});

test('no monitor block yields no monitor', () => {
  assert.deepEqual(detectMonitorRequest('Just some text'), { monitor: false });
});
