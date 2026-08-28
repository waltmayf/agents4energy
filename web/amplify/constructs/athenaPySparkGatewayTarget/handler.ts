import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  UpdateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListGatewayTargetsCommand,
  SchemaType,
  CredentialProviderType,
  type ToolDefinition,
  type TargetConfiguration,
  type CredentialProviderConfiguration,
} from '@aws-sdk/client-bedrock-agentcore-control';

const client = new BedrockAgentCoreControlClient({});

interface ResourceProperties {
  GatewayIdentifier: string;
  TargetName: string;
  LambdaArn: string;
}

// Keep in sync with the athena-pyspark handler's ToolEvent + dispatch (issue #501).
const toolDefinitions = (): ToolDefinition[] => [
  {
    name: 'SubmitPySpark',
    description:
      'Submit PySpark code to run in an Amazon Athena-for-Spark session and return immediately with '
      + '{ status, sessionId, calculationId, subdir, artifactsPrefix } — it does not wait for the code to finish. '
      + 'Poll with GetPySparkStatus, then fetch output with GetPySparkResults once the calculation reaches a terminal state. '
      + 'A `spark` session is pre-initialized. Available libraries: matplotlib, numpy, scipy, scikit-learn, pyarrow, pandas. '
      + 'Save plot files to `plots/` and data files to `data/` in the working directory — everything there is '
      + 'automatically uploaded to the shared artifacts store after execution; do NOT use boto3 or hardcode S3 paths yourself. '
      + 'Reference `/artifacts/<subdir>/plots/<file>` when describing a saved plot to the user (rendered inline by the chat UI). '
      + 'If the response comes back with status "pending", the session (a one-time cold start) is still initializing — '
      + 'call SubmitPySpark again with the exact same subdir shortly to retry; the same session is reused, not recreated.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        code: {
          type: SchemaType.STRING,
          description: 'PySpark code to execute (required). The `spark` session is already initialized.',
        },
        subdir: {
          type: SchemaType.STRING,
          description:
            'Stable identifier for this analysis (e.g. the chat session id) — scopes the Athena session '
            + '(reused across calls with the same subdir) and the artifacts path (files/artifacts/<subdir>/...) (required).',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Optional human-readable description of what this code does.',
        },
      },
      required: ['code', 'subdir'],
    },
  },
  {
    name: 'GetPySparkStatus',
    description:
      'Poll the status of a calculation previously submitted via SubmitPySpark. Returns '
      + '{ calculationId, state, stateChangeReason, progressPercent, dpuExecutionSeconds }. '
      + 'state is one of WAITING | RUNNING | COMPLETED | FAILED | CANCELED (among others) — poll every ~15s '
      + 'until it reaches a terminal state, then call GetPySparkResults.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        calculationId: {
          type: SchemaType.STRING,
          description: 'The calculationId returned by SubmitPySpark (required).',
        },
      },
      required: ['calculationId'],
    },
  },
  {
    name: 'GetPySparkResults',
    description:
      'Fetch the stdout/stderr/result output of a completed calculation, plus a listing of the artifact files '
      + '(plots/data) it produced under files/artifacts/<subdir>/. Call only after GetPySparkStatus reports a '
      + 'terminal state (COMPLETED/FAILED/CANCELED) — otherwise returns a message asking you to keep polling.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        calculationId: {
          type: SchemaType.STRING,
          description: 'The calculationId returned by SubmitPySpark (required).',
        },
        subdir: {
          type: SchemaType.STRING,
          description: 'The same subdir passed to SubmitPySpark, used to list artifact files (required).',
        },
      },
      required: ['calculationId', 'subdir'],
    },
  },
];

function buildTargetConfiguration(lambdaArn: string): TargetConfiguration {
  return {
    mcp: {
      lambda: {
        lambdaArn,
        toolSchema: { inlinePayload: toolDefinitions() },
      },
    },
  };
}

// A Lambda target is invoked with the gateway's own execution role, so use
// GATEWAY_IAM_ROLE (paired with the identity-based lambda:InvokeFunction grant
// on that role in backend.ts). CreateGatewayTarget requires
// credentialProviderConfigurations explicitly — see the S3ToolsGatewayTarget
// handler for the full rationale.
const credentialProviderConfigurations: CredentialProviderConfiguration[] = [
  { credentialProviderType: CredentialProviderType.GATEWAY_IAM_ROLE },
];

async function findExistingTargetId(gatewayIdentifier: string, targetName: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier, nextToken }));
    const match = (res.items ?? []).find((t) => t.name === targetName);
    if (match?.targetId) return match.targetId;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    const targetConfiguration = buildTargetConfiguration(props.LambdaArn);

    // Create-if-absent: look up by name first so a redeploy that recreates this
    // custom resource updates the existing target instead of failing on
    // "already exists".
    const existingTargetId = await findExistingTargetId(props.GatewayIdentifier, props.TargetName);

    if (existingTargetId) {
      await client.send(new UpdateGatewayTargetCommand({
        gatewayIdentifier: props.GatewayIdentifier,
        targetId: existingTargetId,
        name: props.TargetName,
        targetConfiguration,
        credentialProviderConfigurations,
      }));
      return { PhysicalResourceId: existingTargetId };
    }

    const created = await client.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: props.GatewayIdentifier,
      name: props.TargetName,
      targetConfiguration,
      credentialProviderConfigurations,
    }));
    if (!created.targetId) throw new Error('CreateGatewayTarget did not return a targetId');
    return { PhysicalResourceId: created.targetId };
  }

  // event.RequestType === 'Delete'
  try {
    await client.send(new DeleteGatewayTargetCommand({
      gatewayIdentifier: props.GatewayIdentifier,
      targetId: event.PhysicalResourceId,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
};
