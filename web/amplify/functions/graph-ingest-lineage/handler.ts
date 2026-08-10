// Materializes ChatSession.lineageSummary into the knowledge graph (#292).
// Triggered by a DynamoDB Stream on the ChatSession table (see backend.ts) on
// every INSERT/MODIFY — the same "stream signal, then act" shape as
// sync-cedar-policies, except here the stream record itself carries the
// payload we need (the new lineageSummary), so we translate it directly
// rather than re-scanning the whole table.

import type { DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { ingestLineageSummary } from '../../../lib/graph-ingest-lineage';
import { upsertNode, upsertEdge, type SignedGraphqlRequest } from '../../../lib/graph-write';

const GRAPHQL_URL = process.env.GRAPHQL_URL!;
const GRAPHQL_REGION = process.env.GRAPHQL_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const credentialProvider = fromNodeProviderChain();

const signedGraphqlRequest: SignedGraphqlRequest = async (query, variables) => {
  const endpoint = new URL(GRAPHQL_URL);
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
    region: GRAPHQL_REGION,
    service: 'appsync',
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  const res = await fetch(GRAPHQL_URL, { method: signed.method, headers: signed.headers, body: signed.body });
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data ?? {};
};

interface ChatSessionRow {
  id: string;
  lineageSummary?: unknown;
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    const row = unmarshall(newImage as Record<string, never>) as ChatSessionRow;
    if (row.lineageSummary === undefined || row.lineageSummary === null) continue;

    // MODIFY events fire on every field update (e.g. mapBounds, name) — skip
    // the (cheap) ingestion work when lineageSummary itself didn't change.
    if (record.eventName === 'MODIFY') {
      const oldImage = record.dynamodb?.OldImage;
      const oldRow = oldImage ? (unmarshall(oldImage as Record<string, never>) as ChatSessionRow) : undefined;
      if (JSON.stringify(oldRow?.lineageSummary) === JSON.stringify(row.lineageSummary)) continue;
    }

    try {
      const result = await ingestLineageSummary(
        { upsertNode, upsertEdge },
        signedGraphqlRequest,
        row.id,
        row.lineageSummary,
      );
      console.log(
        `Ingested lineageSummary for session ${row.id}: ${result.datasetNodeIds.length} dataset node(s), ${result.edgeIds.length} edge(s).`,
      );
    } catch (err) {
      // A malformed lineageSummary or a transient AppSync error on one session
      // shouldn't fail the whole batch — log and move on to the next record.
      console.error(`Failed to ingest lineageSummary for session ${row.id}:`, err);
    }
  }
};
