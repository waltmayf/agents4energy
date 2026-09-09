import { SchemaType, type ToolDefinition } from '@aws-sdk/client-bedrock-agentcore-control';

// MCP tool schema for the athena-pyspark gateway target (issue #501) — moved
// verbatim from web/amplify/constructs/athenaPySparkGatewayTarget/handler.ts
// as part of #536. The Lambda implementing these tools is a local copy at
// ./athena-pyspark/handler.ts (see its header comment for why).
//
// Keep in sync with the athena-pyspark handler's ToolEvent + dispatch.
export const athenaPySparkToolDefinitions: ToolDefinition[] = [
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
