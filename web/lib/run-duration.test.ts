import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDurationMs, buildRunDurationLine } from './run-duration.ts';

test('formats sub-minute durations in seconds', () => {
  assert.equal(formatDurationMs(0), '0 seconds');
  assert.equal(formatDurationMs(1_000), '1 second');
  assert.equal(formatDurationMs(42_000), '42 seconds');
  assert.equal(formatDurationMs(59_400), '59 seconds'); // rounds to 59s
});

test('formats sub-hour durations in minutes', () => {
  assert.equal(formatDurationMs(60_000), '1 minute');
  assert.equal(formatDurationMs(37 * 60_000), '37 minutes');
  assert.equal(formatDurationMs(59 * 60_000 + 59_000), '59 minutes'); // floors to 59m
});

test('formats multi-hour durations as hours + minutes', () => {
  assert.equal(formatDurationMs(60 * 60_000), '1 hour'); // exact hour omits minutes
  assert.equal(formatDurationMs(2 * 60 * 60_000 + 5 * 60_000), '2 hours 5 minutes');
  assert.equal(formatDurationMs(74 * 60_000), '1 hour 14 minutes'); // the issue's 74-minute example
});

test('returns null for invalid durations (clock skew / bad input)', () => {
  assert.equal(formatDurationMs(-1), null);
  assert.equal(formatDurationMs(NaN), null);
  assert.equal(formatDurationMs(Infinity), null);
});

test('buildRunDurationLine composes the prefix from an ISO start time', () => {
  const start = '2026-08-11T10:00:00.000Z';
  const now = new Date('2026-08-11T11:14:00.000Z').getTime(); // +74 min
  assert.equal(buildRunDurationLine(start, now), 'Agent finished after 1 hour 14 minutes');
});

test('buildRunDurationLine honors a custom label (failure path)', () => {
  const start = '2026-08-11T10:00:00.000Z';
  const now = new Date('2026-08-11T10:03:00.000Z').getTime(); // +3 min
  assert.equal(buildRunDurationLine(start, now, 'Agent failed after'), 'Agent failed after 3 minutes');
});

test('buildRunDurationLine returns null when the start time is missing or unparseable', () => {
  assert.equal(buildRunDurationLine(undefined, 1_000), null);
  assert.equal(buildRunDurationLine('', 1_000), null);
  assert.equal(buildRunDurationLine('not-a-date', 1_000), null);
});

test('buildRunDurationLine returns null on clock skew (end before start)', () => {
  const start = '2026-08-11T11:00:00.000Z';
  const now = new Date('2026-08-11T10:00:00.000Z').getTime(); // before start
  assert.equal(buildRunDurationLine(start, now), null);
});
