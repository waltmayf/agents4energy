import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface GraphIngestLineageProps {
  /** ChatSession table — the DynamoDB Stream trigger and source of lineageSummary. */
  chatSessionTable: ITable;
  /** AppSync GraphQL URL for the data API (Node/Edge live here — see graph-traverse). */
  graphqlUrl: string;
  /** AppSync API id — scopes the appsync:GraphQL IAM grant. */
  graphqlApiId: string;
  /** Region the AppSync API + this Lambda live in. */
  graphqlRegion: string;
}

/**
 * Stream-triggered Lambda that materializes `ChatSession.lineageSummary`
 * into the knowledge graph (#292) on every session-summary update. See
 * web/amplify/functions/graph-ingest-lineage/handler.ts for the translation
 * logic and web/lib/graph-ingest-lineage.ts for the pluggable ingestion core.
 *
 * Built as a raw NodejsFunction in its own stack — same cycle-avoidance
 * reasoning as SyncCedarPolicies: the handler reads the ChatSession table via
 * a DynamoEventSource AND writes Node/Edge over AppSync (the data stack), so
 * a `defineFunction` in the shared function stack (which the data stack
 * already depends on) would close a `data -> function -> data` cycle. This
 * sink stack depends on the data stack only and is depended on by nothing.
 */
export class GraphIngestLineage extends Construct {
  constructor(scope: Construct, id: string, props: GraphIngestLineageProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, '../functions/graph-ingest-lineage/handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: {
        GRAPHQL_URL: props.graphqlUrl,
        GRAPHQL_REGION: props.graphqlRegion,
      },
    });

    const { region, account } = Stack.of(this);
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['appsync:GraphQL'],
      resources: [
        `arn:aws:appsync:${region}:${account}:apis/${props.graphqlApiId}/types/Query/fields/*`,
        `arn:aws:appsync:${region}:${account}:apis/${props.graphqlApiId}/types/Mutation/fields/*`,
      ],
    }));

    // The stream record carries the new lineageSummary directly, so unlike
    // SyncCedarPolicies this doesn't need a broader dynamodb:Scan/Query grant
    // on the table — only the DynamoEventSource's own stream-read permissions
    // (added by addEventSource below).
    fn.addEventSource(new DynamoEventSource(props.chatSessionTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 3,
    }));
  }
}
