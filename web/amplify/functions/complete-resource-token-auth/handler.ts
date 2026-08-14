import type { AppSyncIdentityCognito } from 'aws-lambda';
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new BedrockAgentCoreClient({ region: REGION });

interface CompleteResourceTokenAuthArgs {
  sessionUri: string;
  // The caller's own Cognito ACCESS token — the SAME one forwarded as
  // `Authorization: Bearer` to the gateway for the original (elicited) tool
  // call (see web/lib/harness-agent.ts's fetchCallerIdentity/buildTools). Per
  // the AWS SDK, CompleteResourceTokenAuth's `userIdentifier.userToken` must
  // be "the OAuth2.0 token ... used to generate the workload access token
  // used for initiating the user authorization flow" — i.e. this same token.
  userToken: string;
}

interface CompleteResourceTokenAuthEvent {
  arguments: CompleteResourceTokenAuthArgs;
  // AppSync populates this from the verified Cognito JWT (the mutation is
  // allow.authenticated()). `sub` here is a trusted claim, not caller input —
  // used below to cross-check the caller-supplied `userToken` actually
  // belongs to THIS signed-in user.
  identity?: AppSyncIdentityCognito | { sub?: never } | null;
}

interface CompleteResourceTokenAuthResult {
  success: boolean;
  // Present only when success is false — a friendly message for the banner.
  error?: string;
}

/**
 * Decode a JWT's payload without verifying its signature. AppSync has already
 * verified the CALLER's identity (event.identity.sub); this only checks that
 * the caller-supplied `userToken` argument decodes to the SAME sub, to catch
 * a stale/foreign token before it's ever sent to AWS (epic #412 slice 5,
 * issue #417 — "user mismatch" acceptance criterion).
 */
function decodedSub(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Session URIs are valid for 10 minutes per AgentCore Identity's URL session binding. */
const EXPIRED_SESSION_MESSAGE =
  'This authentication session has expired or was already used (links are valid for 10 minutes) — retry the tool call to get a fresh one.';
const USER_MISMATCH_MESSAGE =
  'This authentication session belongs to a different signed-in user — sign in again and retry the tool call.';

export const handler = async (
  event: CompleteResourceTokenAuthEvent,
): Promise<CompleteResourceTokenAuthResult> => {
  const { sessionUri, userToken } = event.arguments;
  const callerSub = event.identity && 'sub' in event.identity ? event.identity.sub ?? null : null;
  const tokenSub = decodedSub(userToken);
  if (!callerSub || !tokenSub || callerSub !== tokenSub) {
    return { success: false, error: USER_MISMATCH_MESSAGE };
  }

  try {
    await client.send(
      new CompleteResourceTokenAuthCommand({
        userIdentifier: { userToken },
        sessionUri,
      }),
    );
    return { success: true };
  } catch (err) {
    const name = err instanceof Error ? err.name : undefined;
    if (name === 'ResourceNotFoundException' || name === 'ValidationException') {
      return { success: false, error: EXPIRED_SESSION_MESSAGE };
    }
    if (name === 'AccessDeniedException' || name === 'UnauthorizedException') {
      return { success: false, error: USER_MISMATCH_MESSAGE };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Authentication could not be completed: ${message}` };
  }
};
