// Local integration test for the runtime cancel path (issue #182).
//
// Runs the REAL server.js as a child process, but:
//   - puts a fake `claude` on PATH that sleeps (so we can cancel mid-run),
//   - points the SFN SDK at a local mock via AWS_ENDPOINT_URL, capturing whether
//     each run resolves as SendTaskSuccess or SendTaskFailure (+ its cause).
//
// Verifies: (A) a cancel kills the in-flight run and reports it superseded,
// (B) cancelling an unknown runId is a clean no-op, (C) the happy path still
// resolves as SendTaskSuccess.
//
// Run: node agent/default/app/ClaudeCode/test-cancel.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 8080;
const MOCK_SFN_PORT = 8099;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Mock Step Functions endpoint: record SendTask* calls -------------------
const sfnCalls = [];
const mockSfn = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    // The AWS JSON protocol puts the operation in the X-Amz-Target header.
    const target = (req.headers['x-amz-target'] || '').split('.').pop();
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    sfnCalls.push({ target, taskToken: parsed.taskToken, error: parsed.error, cause: parsed.cause, output: parsed.output });
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
    res.end('{}');
  });
});
const findCall = (token) => sfnCalls.find((c) => c.taskToken === token);

// --- Fake `claude` CLI on PATH ----------------------------------------------
// Sleeps so we can cancel it; prompt "FAST" finishes quickly for the happy path.
// On SIGTERM it exits non-zero (like a killed real run) so server.js rejects.
const binDir = mkdtempSync(join(tmpdir(), 'cc-bin-'));
const fakeClaude = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] || '';
const ms = prompt === 'FAST' ? 300 : 5000;
const t = setTimeout(() => {
  process.stdout.write(JSON.stringify({ result: 'completed: ' + prompt }));
  process.exit(0);
}, ms);
process.on('SIGTERM', () => { clearTimeout(t); process.exit(143); });
`;
writeFileSync(join(binDir, 'claude'), fakeClaude, { mode: 0o755 });
chmodSync(join(binDir, 'claude'), 0o755);

// --- HTTP helper ------------------------------------------------------------
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: SERVER_PORT, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/ping' }, (res) => { res.resume(); res.on('end', resolve); });
        r.on('error', reject);
      });
      return;
    } catch { await sleep(100); }
  }
  throw new Error('server did not come up');
}

// --- Run --------------------------------------------------------------------
let server;
try {
  await new Promise((r) => mockSfn.listen(MOCK_SFN_PORT, r));

  server = spawn('node', [join(HERE, 'server.js')], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: `http://127.0.0.1:${MOCK_SFN_PORT}`,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'cc-ws-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [server:err] ${d}`));

  await waitForServer();

  // --- Test A: cancel an in-flight run --------------------------------------
  console.log('\nTest A — cancel kills the in-flight run and reports it superseded');
  const startA = await post('/invocations', { taskToken: 'tok-A', runId: 'run-A', prompt: 'slow', repo: '' });
  assert(startA.status === 200 && startA.body.started === true, 'start returns 200 {started:true}');
  await sleep(1000); // let the fake claude spawn and be running
  const cancelA = await post('/invocations', { action: 'cancel', runId: 'run-A' });
  assert(cancelA.status === 200 && cancelA.body.cancelled === true, 'cancel returns 200 {cancelled:true}');
  await sleep(1500); // let the kill + SendTaskFailure land
  const callA = findCall('tok-A');
  assert(!!callA, 'a SendTask* call was made for tok-A');
  assert(callA?.target === 'SendTaskFailure', `resolves as SendTaskFailure (got ${callA?.target})`);
  assert(callA?.error === 'ClaudeCodeRuntimeCancelled', `error code is ClaudeCodeRuntimeCancelled (got ${callA?.error})`);
  assert(/superseded/i.test(callA?.cause || ''), 'cause mentions "superseded"');
  assert(!/@agentcore-claude/.test(callA?.cause || ''), 'cause does NOT contain a raw @mention (no re-trigger)');

  // --- Test B: cancel an unknown runId --------------------------------------
  console.log('\nTest B — cancelling an unknown runId is a clean no-op');
  const cancelB = await post('/invocations', { action: 'cancel', runId: 'does-not-exist' });
  assert(cancelB.status === 200 && cancelB.body.cancelled === false, 'returns 200 {cancelled:false}');

  // --- Test C: happy path still resolves as SendTaskSuccess -----------------
  console.log('\nTest C — an uncancelled run still resolves as SendTaskSuccess');
  const startC = await post('/invocations', { taskToken: 'tok-C', runId: 'run-C', prompt: 'FAST', repo: '' });
  assert(startC.status === 200 && startC.body.started === true, 'start returns 200 {started:true}');
  await sleep(2000); // > 300ms fake run + SendTaskSuccess
  const callC = findCall('tok-C');
  assert(!!callC, 'a SendTask* call was made for tok-C');
  assert(callC?.target === 'SendTaskSuccess', `resolves as SendTaskSuccess (got ${callC?.target})`);
  assert(/completed: FAST/.test(callC?.output || ''), 'output carries the CLI result text');

  console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} ASSERTION(S) FAILED ✗`}`);
} finally {
  if (server) server.kill('SIGKILL');
  mockSfn.close();
}
process.exit(failures === 0 ? 0 : 1);
