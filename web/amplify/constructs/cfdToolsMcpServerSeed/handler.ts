import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

interface ResourceProperties {
  GraphqlUrl: string;
  GraphqlRegion: string;
  GatewayEndpoint: string;
  GatewayTargetId: string;
}

const DEMO_AGENT_SLUG = 'cfd-simulation-demo';
const DEMO_AGENT_NAME = 'CFD Simulation Demo';
const DEMO_MCP_SERVER_NAME = 'CFD Simulation Tools';

const credentialProvider = fromNodeProviderChain();

async function signedGraphqlRequest(
  url: string,
  region: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(url);
  const body = JSON.stringify({ query, variables });

  const request = new HttpRequest({
    method: 'POST',
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: endpoint.pathname,
    headers: { 'Content-Type': 'application/json', host: endpoint.hostname },
    body,
  });

  const signer = new SignatureV4({
    credentials: credentialProvider,
    region,
    service: 'appsync',
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  const res = await fetch(url, { method: signed.method, headers: signed.headers, body: signed.body });
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data ?? {};
}

async function findOrCreateAgent(
  url: string,
  region: string,
): Promise<string> {
  const existing = await signedGraphqlRequest(
    url,
    region,
    `query ListAgents($filter: ModelAgentFilterInput) {
      listAgents(filter: $filter) { items { id } }
    }`,
    { filter: { slug: { eq: DEMO_AGENT_SLUG } } },
  );
  const existingId = (existing.listAgents as { items?: Array<{ id: string }> })?.items?.[0]?.id;
  if (existingId) return existingId;

  const created = await signedGraphqlRequest(
    url,
    region,
    `mutation CreateAgent($input: CreateAgentInput!) {
      createAgent(input: $input) { id }
    }`,
    {
      input: {
        name: DEMO_AGENT_NAME,
        slug: DEMO_AGENT_SLUG,
        description: 'Demo agent proving the CFD simulation tools (SubmitCfdSimulation/GetCfdJobStatus/GetCfdResults, issue #504) end-to-end.',
        enabled: true,
      },
    },
  );
  const id = (created.createAgent as { id?: string })?.id;
  if (!id) throw new Error('createAgent did not return an id');
  return id;
}

async function findOrCreateMcpServer(
  url: string,
  region: string,
  gatewayEndpoint: string,
  gatewayTargetId: string,
): Promise<string> {
  // Match by the stable demo name, not by url == gatewayEndpoint — the
  // gateway endpoint can change across redeploys (e.g. gateway
  // recreated), and matching on it would orphan the old McpServer row
  // instead of updating it in place.
  const existing = await signedGraphqlRequest(
    url,
    region,
    `query ListMcpServers($filter: ModelMcpServerFilterInput) {
      listMcpServers(filter: $filter) { items { id url gatewayTargetId } }
    }`,
    { filter: { name: { eq: DEMO_MCP_SERVER_NAME } } },
  );
  const existingItem = (existing.listMcpServers as {
    items?: Array<{ id: string; url: string; gatewayTargetId: string | null }>;
  })?.items?.[0];
  if (existingItem) {
    if (existingItem.url !== gatewayEndpoint || existingItem.gatewayTargetId !== gatewayTargetId) {
      await signedGraphqlRequest(
        url,
        region,
        `mutation UpdateMcpServer($input: UpdateMcpServerInput!) {
          updateMcpServer(input: $input) { id }
        }`,
        { input: { id: existingItem.id, url: gatewayEndpoint, gatewayTargetId } },
      );
    }
    return existingItem.id;
  }

  const created = await signedGraphqlRequest(
    url,
    region,
    `mutation CreateMcpServer($input: CreateMcpServerInput!) {
      createMcpServer(input: $input) { id }
    }`,
    {
      input: {
        name: DEMO_MCP_SERVER_NAME,
        url: gatewayEndpoint,
        gatewayTargetId,
        description: 'AgentCore Gateway exposing the SubmitCfdSimulation/GetCfdJobStatus/GetCfdResults CFD simulation tools (issue #504).',
        serverType: 'agentcore',
        enabled: true,
      },
    },
  );
  const id = (created.createMcpServer as { id?: string })?.id;
  if (!id) throw new Error('createMcpServer did not return an id');
  return id;
}

async function ensureAgentMcpServerLink(
  url: string,
  region: string,
  agentId: string,
  mcpServerId: string,
): Promise<string> {
  const existing = await signedGraphqlRequest(
    url,
    region,
    `query ListAgentMcpServers($filter: ModelAgentMcpServerFilterInput) {
      listAgentMcpServers(filter: $filter) { items { id } }
    }`,
    { filter: { agentId: { eq: agentId }, mcpServerId: { eq: mcpServerId } } },
  );
  const existingId = (existing.listAgentMcpServers as { items?: Array<{ id: string }> })?.items?.[0]?.id;
  if (existingId) return existingId;

  const created = await signedGraphqlRequest(
    url,
    region,
    `mutation CreateAgentMcpServer($input: CreateAgentMcpServerInput!) {
      createAgentMcpServer(input: $input) { id }
    }`,
    { input: { agentId, mcpServerId } },
  );
  const id = (created.createAgentMcpServer as { id?: string })?.id;
  if (!id) throw new Error('createAgentMcpServer did not return an id');
  return id;
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  // No-op on Delete — same reasoning as S3ToolsMcpServerSeed: a ChatSession
  // may already reference the demo agent, so leave the idle demo row behind
  // rather than deleting it out from under an in-progress chat.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const agentId = await findOrCreateAgent(props.GraphqlUrl, props.GraphqlRegion);
  const mcpServerId = await findOrCreateMcpServer(
    props.GraphqlUrl,
    props.GraphqlRegion,
    props.GatewayEndpoint,
    props.GatewayTargetId,
  );
  const linkId = await ensureAgentMcpServerLink(props.GraphqlUrl, props.GraphqlRegion, agentId, mcpServerId);

  return { PhysicalResourceId: linkId };
};
