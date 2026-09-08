// Spike #533, criterion 5 — minimal MCP server (streamable-HTTP, JSON-RPC 2.0
// over a single POST/response, no SSE) exposing exactly one resource, so an
// AgentCore Gateway `mcpServer`-type target has something real to proxy
// `resources/list` / `resources/read` to.
const STEERING_DOC_URI = 'steering://spike-533/playbook';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface LambdaUrlEvent {
  body?: string;
}

interface LambdaUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function respond(id: JsonRpcRequest['id'], result: unknown): LambdaUrlResult {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

export const handler = async (event: LambdaUrlEvent): Promise<LambdaUrlResult> => {
  const req: JsonRpcRequest = JSON.parse(event.body ?? '{}');

  switch (req.method) {
    case 'initialize':
      return respond(req.id, {
        protocolVersion: '2025-06-18',
        capabilities: { resources: {} },
        serverInfo: { name: 'spike-533-mock-mcp-server', version: '0.0.1' },
      });

    case 'resources/list':
      return respond(req.id, {
        resources: [
          {
            uri: STEERING_DOC_URI,
            name: 'Spike 533 playbook',
            mimeType: 'text/markdown',
            annotations: { audience: ['assistant'], priority: 0.5 },
          },
        ],
      });

    case 'resources/read': {
      const uri = req.params?.uri;
      if (uri !== STEERING_DOC_URI) {
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } }) };
      }
      return respond(req.id, {
        contents: [
          {
            uri: STEERING_DOC_URI,
            mimeType: 'text/markdown',
            text: '# Spike 533 playbook\n\nThis is a throwaway steering doc served from a Lambda-backed MCP-server gateway target.',
          },
        ],
      });
    }

    default:
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }) };
  }
};
