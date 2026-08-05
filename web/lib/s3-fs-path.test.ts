import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveS3Path, resolveS3Prefix, S3FsPathError } from './s3-fs-path.ts';

test('absolute path resolves from bucket root', () => {
  const { key, isDocs } = resolveS3Path('/docs/production/gas_lift.md', 'sess-1');
  assert.equal(key, 'docs/production/gas_lift.md');
  assert.equal(isDocs, true);
});

test('relative path resolves against session workspace', () => {
  const { key, isDocs } = resolveS3Path('example.txt', 'sess-1');
  assert.equal(key, 'workspace/id=sess-1/example.txt');
  assert.equal(isDocs, false);
});

test('relative nested path resolves against session workspace', () => {
  const { key } = resolveS3Path('reports/q3.md', 'sess-1');
  assert.equal(key, 'workspace/id=sess-1/reports/q3.md');
});

test('relative path requires a sessionId', () => {
  assert.throws(() => resolveS3Path('example.txt', ''), S3FsPathError);
});

test('normalizes internal . and .. segments', () => {
  const { key } = resolveS3Path('a/./b/../c.txt', 'sess-1');
  assert.equal(key, 'workspace/id=sess-1/a/c.txt');
});

test('rejects traversal above the workspace root', () => {
  assert.throws(() => resolveS3Path('../escape.txt', 'sess-1'), S3FsPathError);
});

test('rejects traversal above the bucket root for absolute paths', () => {
  assert.throws(() => resolveS3Path('/../escape.txt', 'sess-1'), S3FsPathError);
});

test('rejects an empty path', () => {
  assert.throws(() => resolveS3Path('', 'sess-1'), S3FsPathError);
});

test('rejects a path that normalizes to empty', () => {
  assert.throws(() => resolveS3Path('.', 'sess-1'), S3FsPathError);
});

test('non-docs absolute paths are not flagged as docs', () => {
  const { isDocs } = resolveS3Path('/other/file.txt', 'sess-1');
  assert.equal(isDocs, false);
});

// -- resolveS3Prefix (ListFiles) --------------------------------------------

test('omitted path resolves to the session CWD prefix', () => {
  const { prefix, isDocs } = resolveS3Prefix(undefined, 'sess-1');
  assert.equal(prefix, 'workspace/id=sess-1/');
  assert.equal(isDocs, false);
});

test('empty-string path resolves to the session CWD prefix', () => {
  const { prefix } = resolveS3Prefix('', 'sess-1');
  assert.equal(prefix, 'workspace/id=sess-1/');
});

test('absolute prefix resolves from bucket root with trailing slash', () => {
  const { prefix, isDocs } = resolveS3Prefix('/docs/production', 'sess-1');
  assert.equal(prefix, 'docs/production/');
  assert.equal(isDocs, true);
});

test('absolute bucket-root prefix resolves to empty string', () => {
  const { prefix } = resolveS3Prefix('/', 'sess-1');
  assert.equal(prefix, '');
});

test('relative prefix resolves against session workspace with trailing slash', () => {
  const { prefix } = resolveS3Prefix('reports', 'sess-1');
  assert.equal(prefix, 'workspace/id=sess-1/reports/');
});

test('prefix listing rejects traversal', () => {
  assert.throws(() => resolveS3Prefix('../escape', 'sess-1'), S3FsPathError);
});
