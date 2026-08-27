import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFileRouteKey, resolveS3Path, resolveS3Prefix, S3FsPathError } from './s3-fs-path.ts';

test('absolute path resolves under the files/ root', () => {
  const key = resolveS3Path('/docs/production/gas_lift.md');
  assert.equal(key, 'files/docs/production/gas_lift.md');
});

test('relative path resolves under the files/ root', () => {
  const key = resolveS3Path('example.txt');
  assert.equal(key, 'files/example.txt');
});

test('relative nested path resolves under the files/ root', () => {
  const key = resolveS3Path('reports/q3.md');
  assert.equal(key, 'files/reports/q3.md');
});

test('normalizes internal . and .. segments', () => {
  const key = resolveS3Path('a/./b/../c.txt');
  assert.equal(key, 'files/a/c.txt');
});

test('absolute and relative paths for the same segments resolve identically', () => {
  assert.equal(resolveS3Path('/reports/q3.md'), resolveS3Path('reports/q3.md'));
});

test('rejects traversal above the files/ root (relative)', () => {
  assert.throws(() => resolveS3Path('../escape.txt'), S3FsPathError);
});

test('rejects traversal above the files/ root (absolute)', () => {
  assert.throws(() => resolveS3Path('/../escape.txt'), S3FsPathError);
});

test('rejects deep traversal that nets negative', () => {
  assert.throws(() => resolveS3Path('a/../../escape.txt'), S3FsPathError);
});

test('rejects an empty path', () => {
  assert.throws(() => resolveS3Path(''), S3FsPathError);
});

test('rejects a path that normalizes to empty', () => {
  assert.throws(() => resolveS3Path('.'), S3FsPathError);
});

// -- resolveS3Prefix (ListFiles) --------------------------------------------

test('omitted path resolves to the files/ root prefix', () => {
  assert.equal(resolveS3Prefix(undefined), 'files/');
});

test('empty-string path resolves to the files/ root prefix', () => {
  assert.equal(resolveS3Prefix(''), 'files/');
});

test('absolute prefix resolves under files/ with trailing slash', () => {
  assert.equal(resolveS3Prefix('/docs/production'), 'files/docs/production/');
});

test('bucket-root prefix ("/") resolves to the files/ root prefix', () => {
  assert.equal(resolveS3Prefix('/'), 'files/');
});

test('relative prefix resolves under files/ with trailing slash', () => {
  assert.equal(resolveS3Prefix('reports'), 'files/reports/');
});

test('prefix listing rejects traversal', () => {
  assert.throws(() => resolveS3Prefix('../escape'), S3FsPathError);
});

// -- resolveFileRouteKey (frontend /file route scoping) ----------------------

test('accepts a well-formed key under files/', () => {
  assert.equal(
    resolveFileRouteKey('files/artifacts/plots/foo.png'),
    'files/artifacts/plots/foo.png',
  );
});

test('rejects a key outside the files/ prefix', () => {
  assert.throws(() => resolveFileRouteKey('other-bucket-prefix/secret.txt'), S3FsPathError);
});

test('rejects a key that is only the bare root prefix', () => {
  assert.throws(() => resolveFileRouteKey('files/'), S3FsPathError);
  assert.throws(() => resolveFileRouteKey('files'), S3FsPathError);
});

test('rejects traversal that would escape the files/ root', () => {
  assert.throws(() => resolveFileRouteKey('files/artifacts/../../secret.txt'), S3FsPathError);
});

test('rejects a key that normalizes to a different key (e.g. redundant slashes)', () => {
  assert.throws(() => resolveFileRouteKey('files//artifacts/foo.png'), S3FsPathError);
});

test('rejects empty input', () => {
  assert.throws(() => resolveFileRouteKey(''), S3FsPathError);
});
