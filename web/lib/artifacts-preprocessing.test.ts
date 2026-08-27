import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteArtifactHref, rewriteArtifactsIframeSrc } from './artifacts-preprocessing.ts';

// -- rewriteArtifactHref -----------------------------------------------------

test('rewrites a simple /artifacts/ href to /file?s3Key=', () => {
  assert.equal(
    rewriteArtifactHref('/artifacts/plots/foo.png'),
    '/file?s3Key=files%2Fartifacts%2Fplots%2Ffoo.png',
  );
});

test('rewrites a nested subdir href', () => {
  assert.equal(
    rewriteArtifactHref('/artifacts/run-42/plots/foo.png'),
    '/file?s3Key=files%2Fartifacts%2Frun-42%2Fplots%2Ffoo.png',
  );
});

test('returns null for hrefs not under /artifacts/', () => {
  assert.equal(rewriteArtifactHref('/file?s3Key=files/other.png'), null);
  assert.equal(rewriteArtifactHref('https://example.com/artifacts/foo.png'), null);
  assert.equal(rewriteArtifactHref('/other/foo.png'), null);
});

test('returns null for a bare /artifacts/ with no relative path', () => {
  assert.equal(rewriteArtifactHref('/artifacts/'), null);
});

test('returns null for non-string input', () => {
  // @ts-expect-error exercising runtime guard against non-string input
  assert.equal(rewriteArtifactHref(undefined), null);
});

// -- rewriteArtifactsIframeSrc ------------------------------------------------

test('rewrites an iframe src pointing at /artifacts/', () => {
  const input = '<iframe src="/artifacts/plots/foo.png"></iframe>';
  assert.equal(
    rewriteArtifactsIframeSrc(input),
    '<iframe src="/file?s3Key=files%2Fartifacts%2Fplots%2Ffoo.png"></iframe>',
  );
});

test('rewrites single-quoted iframe src', () => {
  const input = "<iframe src='/artifacts/plots/foo.png'></iframe>";
  assert.equal(
    rewriteArtifactsIframeSrc(input),
    "<iframe src='/file?s3Key=files%2Fartifacts%2Fplots%2Ffoo.png'></iframe>",
  );
});

test('preserves other attributes and order around src', () => {
  const input = '<iframe title="Chart" src="/artifacts/foo.png" width="400"></iframe>';
  assert.equal(
    rewriteArtifactsIframeSrc(input),
    '<iframe title="Chart" src="/file?s3Key=files%2Fartifacts%2Ffoo.png" width="400"></iframe>',
  );
});

test('rewrites multiple iframes in the same document', () => {
  const input =
    '<iframe src="/artifacts/a.png"></iframe><p>text</p><iframe src="/artifacts/b.png"></iframe>';
  const result = rewriteArtifactsIframeSrc(input);
  assert.match(result, /s3Key=files%2Fartifacts%2Fa\.png/);
  assert.match(result, /s3Key=files%2Fartifacts%2Fb\.png/);
});

test('leaves iframes not pointing at /artifacts/ untouched', () => {
  const input = '<iframe src="/other/foo.png"></iframe>';
  assert.equal(rewriteArtifactsIframeSrc(input), input);
});

test('leaves non-iframe /artifacts/ text untouched', () => {
  const input = '<p>see /artifacts/foo.png for details</p>';
  assert.equal(rewriteArtifactsIframeSrc(input), input);
});

test('is a no-op on content with no /artifacts/ reference', () => {
  const input = '<p>hello world</p>';
  assert.equal(rewriteArtifactsIframeSrc(input), input);
});

test('returns non-string input unchanged', () => {
  // @ts-expect-error exercising runtime guard against non-string input
  assert.equal(rewriteArtifactsIframeSrc(null), null);
});
