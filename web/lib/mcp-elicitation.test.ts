import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpElicitation, elicitationFriendlyMessage, type McpElicitation } from './mcp-elicitation.ts';

// Verbatim shape from AWS's AgentCore Gateway 3LO elicitation docs/samples.
const RAW_ELICITATION = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  error: {
    code: -32042,
    message: 'This request requires more information.',
    data: {
      elicitations: [
        {
          mode: 'url',
          elicitationId: 'elicit-123',
          url: 'https://idp.example.com/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc123',
          message: 'Please login to this URL for authorization.',
        },
      ],
    },
  },
});

test('parses the full JSON-RPC elicitation envelope, extracting the session URI from the url', () => {
  const elicitation = parseMcpElicitation(RAW_ELICITATION);
  assert.ok(elicitation);
  assert.equal(elicitation.elicitationId, 'elicit-123');
  assert.equal(elicitation.mode, 'url');
  assert.equal(elicitation.message, 'Please login to this URL for authorization.');
  assert.equal(
    elicitation.url,
    'https://idp.example.com/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc123',
  );
  assert.equal(elicitation.sessionUri, 'urn:ietf:params:oauth:request_uri:abc123');
});

test('parses a bare error object (no jsonrpc envelope)', () => {
  const bare = JSON.stringify({
    code: -32042,
    message: 'consent required',
    data: { elicitations: [{ mode: 'url', elicitationId: 'e2', url: 'https://idp.example.com/a' }] },
  });
  const elicitation = parseMcpElicitation(bare);
  assert.ok(elicitation);
  assert.equal(elicitation.elicitationId, 'e2');
});

test('recovers the JSON payload from an SDK exception message with a text prefix', () => {
  const prefixed = `RuntimeClientError: ${RAW_ELICITATION}`;
  const elicitation = parseMcpElicitation(prefixed);
  assert.ok(elicitation);
  assert.equal(elicitation.elicitationId, 'elicit-123');
});

test('returns null for an unrelated JSON-RPC error code', () => {
  const other = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } });
  assert.equal(parseMcpElicitation(other), null);
});

test('returns null for a normal (non-error) tool result', () => {
  assert.equal(parseMcpElicitation(JSON.stringify({ sunny: true, temp: 75 })), null);
});

test('returns null for malformed JSON and for empty/missing input', () => {
  assert.equal(parseMcpElicitation('not json at all'), null);
  assert.equal(parseMcpElicitation(''), null);
  assert.equal(parseMcpElicitation(null), null);
  assert.equal(parseMcpElicitation(undefined), null);
});

test('returns null when the elicitations array is missing or empty', () => {
  const noElicitations = JSON.stringify({ error: { code: -32042, message: 'x', data: {} } });
  assert.equal(parseMcpElicitation(noElicitations), null);
});

test('returns null when the sole elicitation entry is missing url/elicitationId', () => {
  const incomplete = JSON.stringify({
    error: { code: -32042, data: { elicitations: [{ mode: 'url', message: 'no id or url' }] } },
  });
  assert.equal(parseMcpElicitation(incomplete), null);
});

test('elicitationFriendlyMessage never leaks the raw JSON-RPC error code', () => {
  const elicitation: McpElicitation = {
    elicitationId: 'e1',
    url: 'https://idp.example.com/a',
    message: 'Please sign in.',
    sessionUri: null,
  };
  const friendly = elicitationFriendlyMessage(elicitation);
  assert.ok(!friendly.includes('-32042'));
  assert.ok(!friendly.includes('jsonrpc'));
  assert.match(friendly, /Please sign in\./);

  const withoutMessage = elicitationFriendlyMessage({ ...elicitation, message: undefined });
  assert.ok(withoutMessage.length > 0);
  assert.ok(!withoutMessage.includes('-32042'));
});
