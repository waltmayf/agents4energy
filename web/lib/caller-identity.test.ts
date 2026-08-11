import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRuntimeUserId, isActorAuthorized, SHARED_ACTOR_ID } from './caller-identity.ts';

test('encodeRuntimeUserId omits an empty identity', () => {
  assert.equal(encodeRuntimeUserId({ sub: null, groups: [] }), undefined);
});

test('encodeRuntimeUserId serializes sub + groups', () => {
  assert.equal(
    encodeRuntimeUserId({ sub: 'user-123', groups: ['admins'] }),
    JSON.stringify({ sub: 'user-123', groups: ['admins'] }),
  );
});

// Authorization guard for list-session-messages (issue #256). This is the
// security boundary: without it, any authenticated caller could pass another
// user's sub as `actorId` and read their memory.
test('a caller may read their OWN sub namespace', () => {
  assert.equal(isActorAuthorized('user-123', 'user-123'), true);
});

test('a caller may read the shared namespace (cross-surface webhook runs)', () => {
  assert.equal(isActorAuthorized('user-123', SHARED_ACTOR_ID), true);
});

test("a caller may NOT read another user's sub namespace", () => {
  assert.equal(isActorAuthorized('user-123', 'someone-else'), false);
});

test('a caller with no verified sub may still read only the shared namespace', () => {
  assert.equal(isActorAuthorized(null, SHARED_ACTOR_ID), true);
  assert.equal(isActorAuthorized(null, 'user-123'), false);
  assert.equal(isActorAuthorized(undefined, 'anything'), false);
});

// Guard against a subtle bypass: a user whose sub literally equals the shared
// sentinel is a non-issue (Cognito subs are UUIDs), but an empty-string sub must
// never be treated as authorized for a non-shared actor.
test('an empty-string sub is not authorized for a non-shared actor', () => {
  assert.equal(isActorAuthorized('', 'user-123'), false);
});
