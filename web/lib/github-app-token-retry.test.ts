import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../amplify/functions/_shared/githubAppToken.ts';

// Zero-delay backoff so tests don't actually sleep.
const noDelay = () => 0;

function mockFetch(responses: Array<{ status: number } | Error>) {
  let i = 0;
  const calls = { count: 0 };
  const fn = async () => {
    calls.count++;
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return new Response('body', { status: r.status });
  };
  return { fn, calls };
}

test('returns immediately on a 2xx (no retry)', async () => {
  const { fn, calls } = mockFetch([{ status: 200 }]);
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    const res = await fetchWithRetry('https://api.github.com/x', undefined, { delayMs: noDelay });
    assert.equal(res.status, 200);
    assert.equal(calls.count, 1);
  } finally {
    global.fetch = orig;
  }
});

test('retries a 503 then succeeds', async () => {
  const { fn, calls } = mockFetch([{ status: 503 }, { status: 503 }, { status: 201 }]);
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    const res = await fetchWithRetry('https://api.github.com/x', undefined, { delayMs: noDelay });
    assert.equal(res.status, 201);
    assert.equal(calls.count, 3);
  } finally {
    global.fetch = orig;
  }
});

test('does NOT retry a 404 (non-transient) — returns it on first try', async () => {
  const { fn, calls } = mockFetch([{ status: 404 }, { status: 200 }]);
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    const res = await fetchWithRetry('https://api.github.com/x', undefined, { delayMs: noDelay });
    assert.equal(res.status, 404);
    assert.equal(calls.count, 1);
  } finally {
    global.fetch = orig;
  }
});

test('returns the last transient response after exhausting attempts', async () => {
  const { fn, calls } = mockFetch([{ status: 503 }]); // always 503
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    const res = await fetchWithRetry('https://api.github.com/x', undefined, { maxAttempts: 3, delayMs: noDelay });
    assert.equal(res.status, 503);
    assert.equal(calls.count, 3);
  } finally {
    global.fetch = orig;
  }
});

test('retries a network error then succeeds', async () => {
  const { fn, calls } = mockFetch([new Error('ECONNRESET'), { status: 200 }]);
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    const res = await fetchWithRetry('https://api.github.com/x', undefined, { delayMs: noDelay });
    assert.equal(res.status, 200);
    assert.equal(calls.count, 2);
  } finally {
    global.fetch = orig;
  }
});

test('throws a persistent network error after exhausting attempts', async () => {
  const { fn, calls } = mockFetch([new Error('ECONNRESET')]);
  const orig = global.fetch;
  global.fetch = fn as typeof fetch;
  try {
    await assert.rejects(
      fetchWithRetry('https://api.github.com/x', undefined, { maxAttempts: 2, delayMs: noDelay }),
      /ECONNRESET/,
    );
    assert.equal(calls.count, 2);
  } finally {
    global.fetch = orig;
  }
});
