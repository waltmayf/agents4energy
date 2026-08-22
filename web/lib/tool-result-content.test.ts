import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeToolResultContent,
  encodeToolResultParts,
  hasStructuredPart,
  toToolResultPart,
} from './tool-result-content.ts';

test('toToolResultPart maps a text item to a text part', () => {
  assert.deepEqual(toToolResultPart({ text: 'hi' }), { kind: 'text', text: 'hi' });
});

test('toToolResultPart maps plain json (no mimeType) to a text part via JSON.stringify', () => {
  assert.deepEqual(toToolResultPart({ json: { ok: true } }), { kind: 'text', text: '{"ok":true}' });
});

test('toToolResultPart maps a mimeType-tagged json item to a ui part', () => {
  assert.deepEqual(toToolResultPart({ json: { mimeType: 'text/html', html: '<b>hi</b>' } }), {
    kind: 'ui',
    mimeType: 'text/html',
    html: '<b>hi</b>',
  });
});

test('toToolResultPart returns null for an empty item', () => {
  assert.equal(toToolResultPart({}), null);
});

test('hasStructuredPart is false when every part is text', () => {
  assert.equal(hasStructuredPart([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]), false);
});

test('hasStructuredPart is true when at least one part is a ui block', () => {
  assert.equal(
    hasStructuredPart([{ kind: 'text', text: 'a' }, { kind: 'ui', mimeType: 'text/html', html: '<div/>' }]),
    true,
  );
});

test('encodeToolResultParts / decodeToolResultContent round-trip', () => {
  const parts = [
    { kind: 'text' as const, text: 'a' },
    { kind: 'ui' as const, mimeType: 'application/vnd.agents4energy.ui+json', spec: { widget: 'gauge' } },
  ];
  const encoded = encodeToolResultParts(parts);
  assert.deepEqual(decodeToolResultContent(encoded), parts);
});

test('decodeToolResultContent returns null for plain (non-enveloped) text', () => {
  assert.equal(decodeToolResultContent('sunny, 75F'), null);
});

test('decodeToolResultContent returns null for JSON that is not the tagged envelope', () => {
  assert.equal(decodeToolResultContent('{"ok":true}'), null);
});
