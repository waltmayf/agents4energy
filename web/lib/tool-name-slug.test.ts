import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyToolName } from './tool-name-slug.ts';

const VALID = /^[a-zA-Z0-9_-]+$/;

test('a display name with spaces becomes a valid tool name (#366 — InvokeHarness rejects spaces)', () => {
  const slug = slugifyToolName('Knowledge Graph Tools');
  assert.equal(slug, 'Knowledge-Graph-Tools');
  assert.match(slug, VALID);
});

test('the S3 server name also slugifies to a valid name', () => {
  const slug = slugifyToolName('S3 Filesystem Tools');
  assert.equal(slug, 'S3-Filesystem-Tools');
  assert.match(slug, VALID);
});

test('an already-valid name is returned unchanged', () => {
  assert.equal(slugifyToolName('graph_traverse-v2'), 'graph_traverse-v2');
});

test('runs of disallowed characters collapse to a single dash', () => {
  assert.equal(slugifyToolName('My   Cool / Tool!!'), 'My-Cool-Tool');
});

test('leading and trailing disallowed characters are trimmed, not left as dashes', () => {
  assert.equal(slugifyToolName('  spaced  '), 'spaced');
  assert.equal(slugifyToolName('***edgey***'), 'edgey');
});

test('a name that is entirely disallowed characters falls back to mcp-server', () => {
  assert.equal(slugifyToolName('   '), 'mcp-server');
  assert.equal(slugifyToolName('!@#$%'), 'mcp-server');
  assert.equal(slugifyToolName(''), 'mcp-server');
});

test('every output satisfies the InvokeHarness tool-name pattern', () => {
  for (const name of ['Knowledge Graph Tools', 'S3 Filesystem Tools', 'a b c', 'café ☕ tools', '!!!', 'ok']) {
    assert.match(slugifyToolName(name), VALID, `"${name}" did not slugify to a valid tool name`);
  }
});
