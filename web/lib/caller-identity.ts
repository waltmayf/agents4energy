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

export function encodeRuntimeUserId(identity: CallerIdentity): string | undefined {
  if (!identity.sub && identity.groups.length === 0) return undefined;
  return JSON.stringify({ sub: identity.sub, groups: identity.groups });
}
