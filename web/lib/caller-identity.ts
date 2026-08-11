/**
 * Caller identity (Cognito `sub` + `cognito:groups`) threaded into the harness
 * invoke path (issue #246). The harness authorizes with AWS_IAM, not
 * CUSTOM_JWT (see docs/agentic-architecture.md), so `cognito:groups` never
 * arrives as a harness JWT claim — this is passed explicitly as a trusted
 * invoke argument instead, via InvokeHarnessCommand's `runtimeUserId` field
 * (the only per-invocation field the harness passes through to the runtime
 * container).
 */
export interface CallerIdentity {
  sub: string | null;
  groups: string[];
}

/**
 * Shared memory actor used for cross-surface visibility (issue #256, Option A).
 *
 * Browser harness chats scope AgentCore memory to the signed-in user's Cognito
 * `sub` (per-user isolation) by passing it as `InvokeHarnessCommand.actorId`.
 * But webhook-initiated runs (`@agentcore-claude` via the ClaudeCode/AguiAgent
 * runtimes) have no browser `sub` to attribute to, so they keep writing under
 * this shared actor. The browser's `loadHistory` dual-reads BOTH its own `sub`
 * namespace and this shared one, so a GitHub-dispatched run still appears in the
 * chat transcript. `list-session-messages` authorizes reads against exactly
 * these two actors (the caller's own `sub` + this shared constant).
 *
 * Trade-off: the shared namespace is readable by any signed-in user — acceptable
 * because webhook runs aren't attributable to a browser user anyway. The three
 * runtime writers that keep this value (agent/default/app/ClaudeCode/memory.js,
 * agent/default/app/AguiAgent/memory.ts) hard-code the same string; they're
 * separate Docker deploy artifacts and can't import this module.
 */
export const SHARED_ACTOR_ID = 'default';

/**
 * Authorize a read of a memory `actorId` by a verified caller (issue #256).
 * A signed-in user may read only their OWN namespace (their Cognito `sub`) or
 * the shared SHARED_ACTOR_ID namespace (cross-surface webhook/ClaudeCode runs).
 * Any other actorId — e.g. another user's sub — is denied. This is what closes
 * the prior hole in list-session-messages, where a caller-supplied actorId let
 * any authenticated user read any actor's memory.
 */
export function isActorAuthorized(callerSub: string | null | undefined, actorId: string): boolean {
  if (actorId === SHARED_ACTOR_ID) return true;
  return Boolean(callerSub) && actorId === callerSub;
}

export function encodeRuntimeUserId(identity: CallerIdentity): string | undefined {
  if (!identity.sub && identity.groups.length === 0) return undefined;
  return JSON.stringify({ sub: identity.sub, groups: identity.groups });
}
