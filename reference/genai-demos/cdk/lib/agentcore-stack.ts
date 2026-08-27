/**
 * AgentCore CDK Stack
 *
 * Independent CDK stack containing Bedrock AgentCore gateway, runtimes (MCP + GenAI),
 * workload identity, OAuth2 credential provider, and MCP gateway target.
 *
 * Reads `amplify_outputs.json` at synth time to get Cognito, GraphQL, and Knowledge Base
 * values from the Amplify backend deployment.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as bedrock_agent_core from 'aws-cdk-lib/aws-bedrockagentcore';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import type { IResolvable } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AgentCoreConstruct } from './constructs/agentCoreConstruct';
import { KnowledgeBaseConstruct } from './constructs/knowledgeBase';
import { AmplifyHostingConstruct } from './constructs/amplifyHostingConstruct';
import { SeedDataConstruct } from './seed-data-construct';
import { RAG_GENERATION_MODEL } from '../../config/models';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Amplify Outputs type (relevant fields only)
// ============================================================================

interface AmplifyOutputs {
  auth: {
    user_pool_id: string;
    user_pool_client_id: string;
    aws_region: string;
  };
  data: {
    url: string;
  };
  storage: {
    bucket_name: string;
  };
  custom: {
    cognitoDomainPrefix: string;
    rootStackName: string;
    retrieveAndGenerateLambdaArn: string;
    mcpFilesystemLambdaArn: string;
    settingsTableName: string;
  };
}

// ============================================================================
// Stack Props
// ============================================================================

export interface AgentCoreStackProps extends cdk.StackProps {
  sandboxId: string;
  /** Optional path to amplify_outputs.json (defaults to repo root) */
  amplifyOutputsPath?: string;
}

// ============================================================================
// Stack
// ============================================================================

export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    // ========================================================================
    // READ AMPLIFY OUTPUTS
    // ========================================================================

    const outputsPath = props.amplifyOutputsPath
      ?? path.resolve(__dirname, '../../amplify_outputs.json');

    if (!fs.existsSync(outputsPath)) {
      throw new Error(
        `amplify_outputs.json not found at ${outputsPath}. ` +
        'Deploy the Amplify backend first: npx ampx sandbox --once',
      );
    }

    const rawOutputs = fs.readFileSync(outputsPath, 'utf-8');
    const amplifyOutputs: AmplifyOutputs = JSON.parse(rawOutputs);

    const userPoolId = amplifyOutputs.auth.user_pool_id;
    const userPoolClientId = amplifyOutputs.auth.user_pool_client_id;
    const region = amplifyOutputs.auth.aws_region;
    const graphqlUrl = amplifyOutputs.data.url;
    const domainPrefix = amplifyOutputs.custom.cognitoDomainPrefix;
    const storageBucketName = amplifyOutputs.storage.bucket_name;

    // ========================================================================
    // IMPORT COGNITO RESOURCES
    // ========================================================================

    const userPool = cognito.UserPool.fromUserPoolId(this, 'ImportedUserPool', userPoolId);

    const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      'ImportedUserPoolClient',
      userPoolClientId,
    );

    // The Cognito domain is already created by the Amplify stack. Since Amplify
    // deploys first (Step 1), the domain is guaranteed to exist when this stack
    // deploys. No need to recreate it here.

    // ========================================================================
    // CREATE OAUTH CLIENTS (tightly coupled to AgentCore)
    // ========================================================================

    // These OAuth clients are created in this stack (not imported from Amplify)
    // because they are tightly coupled to AgentCore functionality and avoid
    // cross-stack CloudFormation dependencies.

    // QuickSight OAuth client (with secret) — needed by OAuth2CredentialProvider
    const quicksightUserPoolClient = new cognito.CfnUserPoolClient(this, 'QuickSightClient', {
      userPoolId,
      clientName: `agentcore-quicksight-${props.sandboxId}`,
      generateSecret: true,
      explicitAuthFlows: [
        'ALLOW_ADMIN_USER_PASSWORD_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
        'ALLOW_USER_SRP_AUTH',
      ],
      allowedOAuthFlows: ['code', 'implicit'],
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      allowedOAuthFlowsUserPoolClient: true,
      callbackUrLs: [
        'https://us-east-1.quicksight.aws.amazon.com/sn/integrations/oauth/callback',
        'https://quicksight.aws.amazon.com/sn/integrations/oauth/callback',
        'https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback',
        'http://localhost:3000/callback',
        'http://localhost:10419/oauth/callback',
        'http://localhost:16998/oauth/callback',
        'http://localhost:16999/oauth/callback',
        'http://localhost:17000/oauth/callback',
        'http://localhost:19245/oauth/callback',
        'http://localhost:32359/oauth/callback',
        'http://localhost:43111/oauth/callback',
      ],
      logoutUrLs: ['https://us-east-1.quicksight.aws.amazon.com/sn/start'],
      supportedIdentityProviders: ['COGNITO'],
    });

    // MCP Gateway client (with secret)
    const mcpGatewayClient = new cognito.CfnUserPoolClient(this, 'McpGatewayClient', {
      userPoolId,
      clientName: `agentcore-mcp-gateway-${props.sandboxId}`,
      generateSecret: true,
      explicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      allowedOAuthFlows: ['code'],
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      allowedOAuthFlowsUserPoolClient: true,
      callbackUrLs: [
        'http://localhost:3000/oauth/callback',
        'http://localhost:10419/oauth/callback',
        'http://localhost:16998/oauth/callback',
        'http://localhost:16999/oauth/callback',
        'http://localhost:17000/oauth/callback',
        'http://localhost:19245/oauth/callback',
        'http://localhost:32359/oauth/callback',
        'http://localhost:43111/oauth/callback',
      ],
      supportedIdentityProviders: ['COGNITO'],
    });

    // MCP Gateway public client (PKCE, no secret)
    const mcpGatewayPublicClient = new cognito.CfnUserPoolClient(this, 'McpGatewayPublicClient', {
      userPoolId,
      clientName: `agentcore-mcp-public-${props.sandboxId}`,
      generateSecret: false,
      explicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      allowedOAuthFlows: ['code'],
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      allowedOAuthFlowsUserPoolClient: true,
      callbackUrLs: [
        'http://localhost:3000/oauth/callback',
        'http://localhost:16998/oauth/callback',
      ],
      supportedIdentityProviders: ['COGNITO'],
    });

    // ========================================================================
    // IMPORT GRAPHQL API
    // ========================================================================

    // AgentCoreConstruct destructures graphqlApi but never calls methods on it.
    // It uses wildcard IAM policies instead of graphqlApi.grantMutation() to avoid
    // cross-stack circular dependencies. We import a reference for type safety.
    const graphqlApiId = this.extractGraphqlApiId(graphqlUrl);
    const graphqlApi = appsync.GraphqlApi.fromGraphqlApiAttributes(this, 'ImportedGraphqlApi', {
      graphqlApiId,
    });

    // ========================================================================
    // KNOWLEDGE BASE (moved from Amplify stack for faster Amplify deploys)
    // ========================================================================

    const documentBucket = s3.Bucket.fromBucketName(this, 'ImportedDocumentBucket', storageBucketName);

    const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
      documentBucket,
      namePrefix: this.stackName,
      region,
      accountId: this.account,
    });

    // ========================================================================
    // AMPLIFY HOSTING (moved from Amplify stack for faster Amplify deploys)
    // ========================================================================

    const amplifyHosting = new AmplifyHostingConstruct(this, 'AmplifyHosting', {
      appName: 'digital-operations-frontend',
      description: 'Digital Operations Agent - Static Frontend',
      branchName: 'main',
    });

    const settingsTableName = amplifyOutputs.custom.settingsTableName;

    // ========================================================================
    // ATHENA PYSPARK WORKGROUP
    // ========================================================================

    // Execution role for Athena Spark sessions — Athena assumes this role
    // to run PySpark code, access S3, and interact with Glue catalog.
    const athenaSparkExecutionRole = new iam.Role(this, 'AthenaSparkExecutionRole', {
      assumedBy: new iam.ServicePrincipal('athena.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'aws:SourceArn': `arn:aws:athena:${region}:${this.account}:workgroup/*`,
          },
        },
      }),
      description: 'Execution role for Athena PySpark workgroup sessions',
    });

    // S3 access for the storage bucket (read/write data and results)
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
          's3:DeleteObject',
          's3:GetBucketLocation',
        ],
        resources: [
          documentBucket.bucketArn,
          `${documentBucket.bucketArn}/*`,
        ],
      })
    );

    // Athena results bucket access (Athena writes query results to S3)
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
          's3:GetBucketLocation',
        ],
        resources: [
          `arn:aws:s3:::aws-athena-query-results-${this.account}-${region}`,
          `arn:aws:s3:::aws-athena-query-results-${this.account}-${region}/*`,
        ],
      })
    );

    // Glue catalog access for Spark SQL operations
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:CreateDatabase',
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetPartition',
          'glue:GetPartitions',
          'glue:CreateTable',
          'glue:UpdateTable',
          'glue:DeleteTable',
          'glue:BatchCreatePartition',
          'glue:DeletePartition',
          'glue:BatchDeletePartition',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch Logs for Spark session logs
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${region}:${this.account}:log-group:/aws-athena/*`,
          `arn:aws:logs:${region}:${this.account}:log-group:/aws-athena/*:log-stream:*`,
        ],
      })
    );

    // Athena session + notebook permissions for the Spark execution role
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // Session management (required for interactive notebooks)
          'athena:StartSession',
          'athena:GetSession',
          'athena:GetSessionStatus',
          'athena:ListSessions',
          'athena:TerminateSession',
          'athena:StartCalculationExecution',
          'athena:GetCalculationExecution',
          'athena:GetCalculationExecutionStatus',
          'athena:ListCalculationExecutions',
          'athena:StopCalculationExecution',
          // Notebook management
          'athena:CreateNotebook',
          'athena:UpdateNotebook',
          'athena:DeleteNotebook',
          'athena:ExportNotebook',
          'athena:ImportNotebook',
          'athena:GetNotebookMetadata',
          'athena:CreatePresignedNotebookUrl',
          'athena:ListNotebookMetadata',
          'athena:ListNotebookSessions',
          // Workgroup read (needed to resolve session config)
          'athena:GetWorkGroup',
        ],
        resources: [
          `arn:aws:athena:${region}:${this.account}:workgroup/*`,
        ],
      })
    );

    // Federated query permissions for Athena JDBC V2 catalog

    // Lambda invoke restricted to connector Lambdas tagged for federation
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/federated_athena_datacatalog': 'true',
          },
        },
      })
    );

    // Athena federated query actions (data catalogs + workgroups)
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['athena:GetDataCatalog'],
        resources: [
          `arn:aws:athena:${region}:${this.account}:datacatalog/*`,
        ],
      })
    );

    // ListDataCatalogs + ListDatabases + ListTableMetadata are account-level actions — require resource: *
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['athena:ListDataCatalogs', 'athena:ListDatabases', 'athena:ListTableMetadata'],
        resources: ['*'],
      })
    );

    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:GetQueryResultsStream',
          'athena:CreatePreparedStatement',
          'athena:GetPreparedStatement',
          'athena:DeletePreparedStatement',
        ],
        resources: [
          `arn:aws:athena:${region}:${this.account}:workgroup/*`,
        ],
      })
    );

    // Spill bucket read access for federated connector Lambdas
    athenaSparkExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          'arn:aws:s3:::*spill*',
          'arn:aws:s3:::*spill*/*',
        ],
      })
    );

    // Sanitize workgroup name: alphanumeric, hyphens, underscores only, max 128 chars
    const pysparkWorkgroupName = `${this.stackName}-pyspark`
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 128);

    const pysparkWorkgroup = new athena.CfnWorkGroup(this, 'PySparkWorkgroup', {
      name: pysparkWorkgroupName,
      description: 'PySpark workgroup for data processing and analysis',
      state: 'ENABLED',
      workGroupConfiguration: {
        engineVersion: {
          selectedEngineVersion: 'PySpark engine version 3',
        },
        executionRole: athenaSparkExecutionRole.roleArn,
        resultConfiguration: {
          outputLocation: `s3://${storageBucketName}/athena-results/`,
        },
      },
    });

    // ========================================================================
    // DATAZONE LINEAGE CONFIGURATION (optional)
    // ========================================================================

    const datazoneDomainId = this.node.tryGetContext('datazoneDomainId')
      ?? process.env.DATAZONE_DOMAIN_ID
      ?? undefined;

    if (!datazoneDomainId) {
      console.log('DataZone domain ID not configured — lineage emission disabled');
    }

    // ========================================================================
    // AGENTCORE CONSTRUCT
    // ========================================================================

    // If the registry was created in a prior deploy, pass it in to skip re-creation.
    // Retrieve from CDK context: `cdk deploy --context agentRegistryArn=<arn>`
    const existingRegistryArn = this.node.tryGetContext('agentRegistryArn') as string | undefined;

    const agentServerEnvironment: Record<string, string> = {
      ATHENA_PYSPARK_WORKGROUP_NAME: pysparkWorkgroupName,
      STORAGE_BUCKET_NAME: storageBucketName,
    };

    if (datazoneDomainId) {
      agentServerEnvironment.DATAZONE_DOMAIN_ID = datazoneDomainId;
    }

    const agentCore = new AgentCoreConstruct(this, 'AgentCore', {
      userPool,
      userPoolClient,
      quicksightUserPoolClient,
      mcpGatewayClient,
      mcpGatewayPublicClient,
      domainPrefix,
      graphqlApi,
      graphqlUrl,
      knowledgeBase,
      existingRegistryArn,
      agentServerEnvironment,
    });

    // ========================================================================
    // SEED DATA (moved from Amplify stack to enable hot swap deploys)
    // Placed after AgentCoreConstruct so all AwsCustomResources share the same
    // singleton Lambda role (agentCore.customResourceRole), which has all needed
    // permissions (Cognito, DynamoDB, Bedrock AgentCore, Secrets Manager).
    // ========================================================================

    if (settingsTableName) {
      new SeedDataConstruct(this, 'SeedData', {
        settingsTableName,
        customResourceRole: agentCore.customResourceRole,
      });
    }

    // ========================================================================
    // MCP GATEWAY TARGET (Filesystem Lambda)
    // ========================================================================
    // Created here (not in AgentCoreConstruct) because the Lambda lives in the
    // Amplify stack and its ARN isn't available until after Amplify deploys.
    // On fresh deployments the Lambda doesn't exist yet, so the target must be
    // created in this post-Amplify CDK stack.

    agentCore.gatewayRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: ['*'],
      })
    );

    const mcpFilesystemLambdaArn = amplifyOutputs.custom.mcpFilesystemLambdaArn
      ?? `arn:aws:lambda:${region}:${this.account}:function:PLACEHOLDER`;

    const mcpFilesystemLambda = lambda.Function.fromFunctionArn(
      this,
      'ImportedMcpFilesystemLambda',
      mcpFilesystemLambdaArn,
    );

    // Sanitize stack name for AgentCore naming requirements: [A-Za-z0-9_.-]+, max 48 chars
    const gatewayTargetName = this.stackName
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 48 - '-fstarget'.length) + '-fstarget';

    const mcpFilesystemGatewayTarget = new bedrock_agent_core.CfnGatewayTarget(
      this,
      'McpFilesystemGatewayTarget',
      {
        name: gatewayTargetName,
        gatewayIdentifier: agentCore.gateway.attrGatewayIdentifier,
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: mcpFilesystemLambda.functionArn,
              toolSchema: {
                inlinePayload: getMCPFilesystemToolSchema() as IResolvable | (IResolvable | bedrock_agent_core.CfnGatewayTarget.ToolDefinitionProperty)[],
              },
            }
          }
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: 'GATEWAY_IAM_ROLE',
          }
        ],
        description: 'Lambda function providing MCP filesystem tools with S3 backend'
      }
    );

    mcpFilesystemGatewayTarget.addDependency(agentCore.gateway);

    // ========================================================================
    // DATAZONE LINEAGE IAM PERMISSIONS
    // ========================================================================
    // If a DataZone domain ID is configured, grant PostLineageEvent permission
    // to the agent server execution role so it can emit OpenLineage events to
    // DataZone. The flow executor Lambda gets the same permission via the
    // Amplify stack's LambdaPermissionsConstruct (which reads the domain ARN
    // from CDK outputs).

    if (datazoneDomainId) {
      const datazoneDomainArn =
        `arn:aws:datazone:${region}:${this.account}:domain/${datazoneDomainId}`;

      // Grant to agent server (AgentCore) execution role
      agentCore.agentServer.executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['datazone:PostLineageEvent'],
          resources: [datazoneDomainArn],
        }),
      );
    }

    // ========================================================================
    // ATHENA LINEAGE LISTENER (EventBridge → Lambda → DataZone)
    // ========================================================================
    // Listens for Athena Query State Change events (SUCCEEDED), fetches the
    // SQL, parses it for input/output tables, and posts OpenLineage events
    // to DataZone. Captures lineage from ALL Athena queries in the account.

    if (datazoneDomainId) {
      const athenaLineageListener = new lambda_nodejs.NodejsFunction(
        this,
        'AthenaLineageListener',
        {
          entry: path.join(__dirname, 'athena-lineage-listener', 'handler.ts'),
          handler: 'handler',
          runtime: lambda.Runtime.NODEJS_20_X,
          timeout: cdk.Duration.seconds(30),
          memorySize: 256,
          environment: {
            DATAZONE_DOMAIN_ID: datazoneDomainId,
            AWS_ACCOUNT_ID: this.account,
          },
          bundling: {
            minify: true,
            sourceMap: true,
          },
        },
      );

      // Grant permissions to read Athena query details
      athenaLineageListener.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['athena:GetQueryExecution'],
          resources: ['*'],
        }),
      );

      // Grant permission to post lineage events to DataZone
      athenaLineageListener.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['datazone:PostLineageEvent'],
          resources: [
            `arn:aws:datazone:${region}:${this.account}:domain/${datazoneDomainId}`,
          ],
        }),
      );

      // EventBridge rule: trigger on Athena query SUCCEEDED
      new events.Rule(this, 'AthenaQuerySucceededRule', {
        description: 'Captures successful Athena queries for lineage tracking',
        eventPattern: {
          source: ['aws.athena'],
          detailType: ['Athena Query State Change'],
          detail: {
            currentState: ['SUCCEEDED'],
          },
        },
        targets: [new targets.LambdaFunction(athenaLineageListener)],
      });
    }

    // ========================================================================
    // OUTPUTS
    // ========================================================================

    new cdk.CfnOutput(this, 'GatewayArn', {
      value: agentCore.gateway.attrGatewayArn,
      description: 'AgentCore gateway ARN',
    });

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: agentCore.gateway.attrGatewayUrl,
      description: 'AgentCore gateway URL',
    });

    new cdk.CfnOutput(this, 'GatewayId', {
      value: agentCore.gateway.attrGatewayIdentifier,
      description: 'AgentCore gateway identifier',
    });

    new cdk.CfnOutput(this, 'McpServerRuntimeArn', {
      value: agentCore.mcpServer.runtime.attrAgentRuntimeArn,
      description: 'MCP server runtime ARN',
    });

    new cdk.CfnOutput(this, 'AgentServerRuntimeArn', {
      value: agentCore.agentServer.runtime.attrAgentRuntimeArn,
      description: 'GenAI agent server runtime ARN',
    });

    new cdk.CfnOutput(this, 'A2aServerRuntimeArn', {
      value: agentCore.a2aServer.runtime.attrAgentRuntimeArn,
      description: 'A2A agent runtime ARN',
    });

    new cdk.CfnOutput(this, 'AgentRegistryId', {
      value: agentCore.agentRegistry.registryArn,
      description: 'AgentCore agent registry ARN (also accepted as registryId)',
    });

    new cdk.CfnOutput(this, 'WorkloadIdentityArn', {
      value: agentCore.identity.workloadIdentityArn,
      description: 'Workload identity ARN',
    });

    new cdk.CfnOutput(this, 'WorkloadIdentityClientId', {
      value: agentCore.identity.clientId,
      description: 'Workload identity client ID',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.knowledgeBaseId,
      description: 'Bedrock Knowledge Base ID',
    });

    new cdk.CfnOutput(this, 'StorageBucketName', {
      value: storageBucketName,
      description: 'Amplify storage bucket name (for Lambda env vars)',
    });

    new cdk.CfnOutput(this, 'AthenaPySparkWorkgroupName', {
      value: pysparkWorkgroupName,
      description: 'Athena PySpark workgroup name',
    });

    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: amplifyHosting.appUrl,
      description: 'Amplify Hosting app URL',
    });

    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: amplifyHosting.app.attrAppId,
      description: 'Amplify Hosting app ID',
    });

    if (datazoneDomainId) {
      new cdk.CfnOutput(this, 'DataZoneDomainId', {
        value: datazoneDomainId,
        description: 'DataZone domain ID for lineage emission',
      });

      new cdk.CfnOutput(this, 'DataZoneDomainArn', {
        value: `arn:aws:datazone:${region}:${this.account}:domain/${datazoneDomainId}`,
        description: 'DataZone domain ARN for lineage IAM permissions',
      });
    }

    // ========================================================================
    // LAMBDA ENV VARS MAP
    // ========================================================================
    // Structured output that maps Amplify Lambda output keys to the env vars
    // they need from this CDK stack. The Amplify backend reads this at synth
    // time via a custom construct and calls lambda.addEnvironment() for each
    // entry, so env vars survive hot-swap deploys without the shell script.
    //
    // Format: { "<amplify_outputs.custom key for Lambda ARN>": { "ENV_VAR": "value" } }
    //
    // The consumer (amplify/custom/cdkEnvVarsConstruct.ts) resolves each key
    // to the actual Lambda function and applies the env vars declaratively.

    // Build the LambdaEnvVars map. The flow executor gets DATAZONE_DOMAIN_ID
    // only when a domain is configured, so lineage emission is opt-in.
    const lambdaEnvVarsMap: Record<string, Record<string, string>> = {
      retrieveAndGenerate: {
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        RAG_MODEL_ID: RAG_GENERATION_MODEL,
      },
      startKbSync: {
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DATA_SOURCE_ID: knowledgeBase.dataSourceId,
      },
      getKbSyncStatus: {
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DATA_SOURCE_ID: knowledgeBase.dataSourceId,
      },
      mcpFilesystem: {
        S3_BUCKET: storageBucketName,
      },
      executeFlow: {},
    };

    if (datazoneDomainId) {
      lambdaEnvVarsMap.executeFlow.DATAZONE_DOMAIN_ID = datazoneDomainId;
      lambdaEnvVarsMap.lineage = { DATAZONE_DOMAIN_ID: datazoneDomainId };
    }

    new cdk.CfnOutput(this, 'LambdaEnvVars', {
      value: JSON.stringify(lambdaEnvVarsMap),
      description: 'JSON map of Lambda function keys to their required env vars from CDK',
    });

    // Apply project tag to all resources
    cdk.Tags.of(this).add('Project', 'a4e');
  }

  /**
   * Extract the GraphQL API ID from an AppSync URL.
   * URL format: https://{apiId}.appsync-api.{region}.amazonaws.com/graphql
   */
  private extractGraphqlApiId(graphqlUrl: string): string {
    const match = graphqlUrl.match(/^https:\/\/([^.]+)\.appsync-api\./);
    if (!match) {
      throw new Error(
        `Could not extract GraphQL API ID from URL: ${graphqlUrl}. ` +
        'Expected format: https://{apiId}.appsync-api.{region}.amazonaws.com/graphql',
      );
    }
    return match[1];
  }
}

// ============================================================================
// MCP Filesystem Tool Schema
// ============================================================================

function getMCPFilesystemToolSchema() {
  return [
    {
      name: 'read_text_file',
      description: 'Read complete contents of a file as text with optional head/tail',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          head: { type: 'number', description: 'First N lines (optional)' },
          tail: { type: 'number', description: 'Last N lines (optional)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_media_file',
      description: 'Read an image or audio file and return base64 data',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_multiple_files',
      description: 'Read multiple files simultaneously',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths' },
        },
        required: ['paths'],
      },
    },
    {
      name: 'write_file',
      description: 'Create new file or overwrite existing file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Make selective edits using pattern matching with dry run support',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string' },
                newText: { type: 'string' },
              },
              required: ['oldText', 'newText'],
            },
          },
          dryRun: { type: 'boolean', description: 'Preview changes without applying' },
        },
        required: ['path', 'edits'],
      },
    },
    {
      name: 'create_directory',
      description: 'Create new directory or ensure it exists',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description: 'List directory contents with [FILE] or [DIR] prefixes',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_directory_with_sizes',
      description: 'List directory contents with file sizes and statistics',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
          sortBy: { type: 'string', enum: ['name', 'size'], description: 'Sort by name or size' },
        },
        required: ['path'],
      },
    },
    {
      name: 'move_file',
      description: 'Move or rename files and directories',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['source', 'destination'],
      },
    },
    {
      name: 'search_files',
      description: 'Recursively search for files matching glob patterns',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Starting directory' },
          pattern: { type: 'string', description: 'Search pattern (glob-style)' },
          excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Patterns to exclude' },
        },
        required: ['path', 'pattern'],
      },
    },
    {
      name: 'directory_tree',
      description: 'Get recursive JSON tree structure of directory',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Starting directory' },
          excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Patterns to exclude' },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_file_info',
      description: 'Get detailed file/directory metadata',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_allowed_directories',
      description: 'List all directories the server can access',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}
