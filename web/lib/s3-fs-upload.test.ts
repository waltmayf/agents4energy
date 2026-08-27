import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3FsPathError } from './s3-fs-path.ts';
import {
  ARTIFACTS_SUBPREFIX,
  resolveArtifactsPrefix,
  sniffContentType,
  uploadObjectBytes,
  copyObjectWithinFs,
} from './s3-fs-upload.ts';

// -- resolveArtifactsPrefix ---------------------------------------------------

test('ARTIFACTS_SUBPREFIX is "artifacts"', () => {
  assert.equal(ARTIFACTS_SUBPREFIX, 'artifacts');
});

test('omitted subdir resolves to the shared artifacts root', () => {
  assert.equal(resolveArtifactsPrefix(), 'files/artifacts/');
});

test('null/empty subdir resolves to the shared artifacts root', () => {
  assert.equal(resolveArtifactsPrefix(null), 'files/artifacts/');
  assert.equal(resolveArtifactsPrefix(''), 'files/artifacts/');
});

test('subdir resolves under the artifacts root, sanitized', () => {
  assert.equal(resolveArtifactsPrefix('session-123'), 'files/artifacts/session-123/');
});

test('nested subdir resolves and normalizes . segments', () => {
  assert.equal(resolveArtifactsPrefix('a/./b'), 'files/artifacts/a/b/');
});

test('subdir traversal above the files/ root is rejected', () => {
  // A single ".." only cancels the "artifacts" segment (still inside files/);
  // a second ".." has nothing left to pop and escapes the root.
  assert.throws(() => resolveArtifactsPrefix('../../escape'), S3FsPathError);
});

// -- sniffContentType ---------------------------------------------------------

test('sniffs known content types by extension', () => {
  assert.equal(sniffContentType('files/artifacts/x/report.html'), 'text/html');
  assert.equal(sniffContentType('files/artifacts/x/data.csv'), 'text/csv');
  assert.equal(sniffContentType('files/artifacts/x/data.json'), 'application/json');
  assert.equal(sniffContentType('files/artifacts/x/notes.txt'), 'text/plain');
  assert.equal(sniffContentType('files/artifacts/x/plot.png'), 'image/png');
});

test('unknown extensions sniff to undefined', () => {
  assert.equal(sniffContentType('files/artifacts/x/model.pkl'), undefined);
  assert.equal(sniffContentType('files/artifacts/x/no-extension'), undefined);
});

// -- uploadObjectBytes / copyObjectWithinFs -----------------------------------
//
// Path validation runs before any S3 call, so a stub S3Client whose send()
// throws lets us assert traversal is rejected without touching AWS.

function unreachableS3() {
  return { send: () => { throw new Error('s3.send should not be called'); } } as unknown as import('@aws-sdk/client-s3').S3Client;
}

test('uploadObjectBytes rejects a destPath that escapes files/', async () => {
  await assert.rejects(
    () => uploadObjectBytes({ s3: unreachableS3(), bucket: 'b', destPath: '../escape.txt', content: 'x' }),
    S3FsPathError,
  );
});

test('copyObjectWithinFs rejects a sourcePath that escapes files/', async () => {
  await assert.rejects(
    () => copyObjectWithinFs({ s3: unreachableS3(), bucket: 'b', sourcePath: '../escape.txt', destPath: 'ok.txt' }),
    S3FsPathError,
  );
});

test('copyObjectWithinFs rejects a destPath that escapes files/', async () => {
  await assert.rejects(
    () => copyObjectWithinFs({ s3: unreachableS3(), bucket: 'b', sourcePath: 'ok.txt', destPath: '../escape.txt' }),
    S3FsPathError,
  );
});

test('uploadObjectBytes resolves the key, sniffs content-type, and writes via PutObject', async () => {
  const calls: unknown[] = [];
  const s3 = {
    send: async (command: { input: unknown }) => { calls.push(command.input); return {}; },
  } as unknown as import('@aws-sdk/client-s3').S3Client;

  const result = await uploadObjectBytes({ s3, bucket: 'my-bucket', destPath: '/reports/q3.html', content: '<p>hi</p>' });

  assert.equal(result.key, 'files/reports/q3.html');
  assert.equal(result.bytesWritten, Buffer.byteLength('<p>hi</p>', 'utf-8'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    Bucket: 'my-bucket',
    Key: 'files/reports/q3.html',
    Body: Buffer.from('<p>hi</p>', 'utf-8'),
    ContentType: 'text/html',
  });
});

test('uploadObjectBytes decodes base64 content', async () => {
  const calls: unknown[] = [];
  const s3 = {
    send: async (command: { input: { Body: Buffer } }) => { calls.push(command.input); return {}; },
  } as unknown as import('@aws-sdk/client-s3').S3Client;

  const base64 = Buffer.from('binary-ish').toString('base64');
  const result = await uploadObjectBytes({ s3, bucket: 'b', destPath: 'blob.bin', content: base64, encoding: 'base64' });

  assert.equal(result.bytesWritten, Buffer.byteLength('binary-ish'));
  assert.deepEqual((calls[0] as { Body: Buffer }).Body, Buffer.from('binary-ish'));
});

test('copyObjectWithinFs resolves both keys and URL-encodes the CopySource key segments', async () => {
  const calls: unknown[] = [];
  const s3 = {
    send: async (command: { input: unknown }) => { calls.push(command.input); return {}; },
  } as unknown as import('@aws-sdk/client-s3').S3Client;

  const result = await copyObjectWithinFs({
    s3,
    bucket: 'my-bucket',
    sourcePath: '/reports/q3 final.csv',
    destPath: 'artifacts/session-1/q3.csv',
  });

  assert.equal(result.key, 'files/artifacts/session-1/q3.csv');
  assert.deepEqual(calls[0], {
    Bucket: 'my-bucket',
    CopySource: 'my-bucket/files/reports/q3%20final.csv',
    Key: 'files/artifacts/session-1/q3.csv',
  });
});
