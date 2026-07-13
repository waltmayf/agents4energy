import { fetchAuthSession } from 'aws-amplify/auth';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessMessage,
  type HarnessTool,
} from '@aws-sdk/client-bedrock-agentcore';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import outputs from '../amplify_outputs.json';

const custom = (outputs as { custom?: { agentcore_harness_arn?: string; agentcore_region?: string } }).custom;
export const HARNESS_ARN = custom?.agentcore_harness_arn as string;
export const DEPLOYMENT_REGION = custom?.agentcore_region ?? 'us-east-1';

// MyHarness authorizes with AWS_IAM (SigV4), so the browser signs InvokeHarness
// requests with the Cognito Identity Pool's authenticated-role credentials
// (granted bedrock-agentcore:InvokeHarness in web/amplify/backend.ts) rather
// than sending a Cognito Bearer JWT. `fetchAuthSession()` returns temporary
// SigV4 credentials for the signed-in user; the SDK client signs + decodes the
// event stream for us, so there's no hand-rolled binary decoder here anymore.
function makeClient(): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({
    region: DEPLOYMENT_REGION,
    credentials: async () => {
      const session = await fetchAuthSession();
      const creds = session.credentials;
      if (!creds) throw new Error('No AWS credentials — sign in first.');
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        expiration: creds.expiration,
      };
    },
  });
}

export interface McpServerConfig {
  name: string;
  url: string;
  // Extra headers to forward when calling this MCP server (e.g. Authorization: Bearer <token>).
  headers?: Record<string, string>;
}

export interface AgentConfig {
  agentId?: string | null;
  systemPromptText?: string | null;
  // Bedrock model ID, e.g. "anthropic.claude-sonnet-4-5". When set, overrides harness default.
  modelId?: string | null;
  // MCP servers injected as remote_mcp tools for this invocation.
  mcpServers?: McpServerConfig[];
}

export class HarnessChatTransport implements ChatTransport<UIMessage> {
  private getSessionId: () => string | null;
  private getAgentConfig: () => AgentConfig;
  private client: BedrockAgentCoreClient;

  constructor(opts: {
    getSessionId: () => string | null;
    getAgentConfig?: () => AgentConfig;
  }) {
    this.getSessionId = opts.getSessionId;
    this.getAgentConfig = opts.getAgentConfig ?? (() => ({}));
    this.client = makeClient();
  }

  sendMessages({
    messages,
    abortSignal,
  }: {
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: string;
    chatId: string;
    messageId: string | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const getSessionId = this.getSessionId;
    const getAgentConfig = this.getAgentConfig;
    const client = this.client;

    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        async start(controller) {
          try {
            const agentConfig = getAgentConfig();

            const harnessMessages: HarnessMessage[] = messages.flatMap((m) => {
              if (m.role !== 'user' && m.role !== 'assistant') return [];
              const text = m.parts
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('');
              if (!text) return [];
              return [{ role: m.role, content: [{ text }] }];
            });

            const sessionId = getSessionId() ?? crypto.randomUUID();

            const tools: HarnessTool[] | undefined = agentConfig.mcpServers?.length
              ? agentConfig.mcpServers.map((s) => ({
                  type: 'remote_mcp',
                  name: s.name,
                  config: {
                    remoteMcp: {
                      url: s.url,
                      ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
                    },
                  },
                }))
              : undefined;

            // Use the InvokeHarness API's first-class override fields so the harness
            // handles system prompt and model selection properly (no message injection).
            const response = await client.send(
              new InvokeHarnessCommand({
                harnessArn: HARNESS_ARN,
                runtimeSessionId: sessionId,
                messages: harnessMessages,
                systemPrompt: agentConfig.systemPromptText
                  ? [{ text: agentConfig.systemPromptText }]
                  : undefined,
                model: agentConfig.modelId
                  ? { bedrockModelConfig: { modelId: agentConfig.modelId } }
                  : undefined,
                tools,
              }),
              { abortSignal },
            );

            const textId = crypto.randomUUID();
            controller.enqueue({ type: 'text-start', id: textId });

            for await (const event of response.stream ?? []) {
              if (abortSignal?.aborted) break;
              if (event.validationException || event.internalServerException || event.runtimeClientError) {
                const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
                throw new Error(ex?.message ?? 'Harness stream exception');
              }
              const delta = event.contentBlockDelta?.delta?.text;
              if (delta) controller.enqueue({ type: 'text-delta', id: textId, delta });
            }

            controller.enqueue({ type: 'text-end', id: textId });
            controller.close();
          } catch (err) {
            const name = err instanceof Error ? err.name : undefined;
            if (name === 'AbortError' || abortSignal?.aborted) {
              controller.close();
            } else {
              const message = err instanceof Error ? err.message : String(err);
              controller.enqueue({ type: 'error', errorText: message });
              controller.close();
            }
          }
        },
      }),
    );
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk>> {
    return Promise.reject(new Error('Reconnect not supported'));
  }
}
