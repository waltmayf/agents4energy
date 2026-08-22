import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonByteSize, parseComponentSpec, parseMetricGridSpec, parseTableSpec } from './component-spec.ts';

test('parseTableSpec accepts a well-formed table spec', () => {
  const spec = { type: 'table', columns: ['a', 'b'], rows: [[1, 'x']] };
  assert.deepEqual(parseTableSpec(spec), spec);
});

test('parseTableSpec rejects non-string columns', () => {
  assert.equal(parseTableSpec({ type: 'table', columns: [1], rows: [] }), null);
});

test('parseTableSpec rejects wrong type discriminator', () => {
  assert.equal(parseTableSpec({ type: 'metric-grid', columns: [], rows: [] }), null);
});

test('parseMetricGridSpec accepts a well-formed metric-grid spec', () => {
  const spec = { type: 'metric-grid', metrics: [{ label: 'Uptime', value: 99.9, unit: '%' }] };
  assert.deepEqual(parseMetricGridSpec(spec), spec);
});

test('parseMetricGridSpec rejects a metric missing a label', () => {
  assert.equal(parseMetricGridSpec({ type: 'metric-grid', metrics: [{ value: 1 }] }), null);
});

test('parseComponentSpec dispatches to the matching shape', () => {
  assert.equal(parseComponentSpec({ type: 'table', columns: [], rows: [] })?.type, 'table');
  assert.equal(parseComponentSpec({ type: 'metric-grid', metrics: [] })?.type, 'metric-grid');
});

test('parseComponentSpec returns null for an unknown shape', () => {
  assert.equal(parseComponentSpec({ type: 'gauge', value: 1 }), null);
  assert.equal(parseComponentSpec('not an object'), null);
  assert.equal(parseComponentSpec(null), null);
});

test('jsonByteSize measures the encoded size', () => {
  assert.equal(jsonByteSize({ a: 1 }), Buffer.byteLength(JSON.stringify({ a: 1 })));
});
