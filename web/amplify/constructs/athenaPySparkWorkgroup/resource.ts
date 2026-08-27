import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IBucket } from 'aws-cdk-lib/aws-s3';

export interface AthenaPySparkWorkgroupProps {
  /** Physical workgroup name — caller derives this so it's unique per sandbox/branch. */
  workGroupName: string;
  /** The agentWorkspace bucket — Spark reads/writes data-lake tables and query results here. */
  bucket: IBucket;
}

/**
 * Amazon Athena-for-Spark (PySpark) workgroup + the Spark execution role Athena
 * assumes to run sessions (issue #500, epic #498 slice 2). This is NOT the
 * Lambda role that will submit/poll jobs (Slice 3) — Athena-for-Spark runs the
 * notebook code itself under this role, so every S3/Glue/Athena permission the
 * PySpark code needs (including the injected boto3 auto-upload under
 * `files/artifacts/*`, see design-doc risk #5) must live here.
 *
 * Ported from `reference/genai-demos/cdk/lib/agentcore-stack.ts` (~L233-442),
 * trimmed to what this repo's PySpark tool (Slice 3) actually needs — the
 * federated-connector/spill-bucket/DataZone-lineage permissions there are out
 * of scope for this slice.
 */
export class AthenaPySparkWorkgroup extends Construct {
  public readonly workGroup: athena.CfnWorkGroup;
  public readonly workGroupName: string;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: AthenaPySparkWorkgroupProps) {
    super(scope, id);

    const { region, account } = Stack.of(this);
    const { bucket } = props;

    // Athena-for-Spark assumes this role to run session/notebook code — scoped
    // by SourceAccount + a workgroup-ARN-shaped SourceArn (the actual workgroup
    // name isn't known until CfnWorkGroup below is created, so this matches any
    // workgroup in this account/region rather than the literal name).
    this.executionRole = new iam.Role(this, 'SparkExecutionRole', {
      assumedBy: new iam.ServicePrincipal('athena.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:athena:${region}:${account}:workgroup/*` },
        },
      }),
      description: 'Execution role for the Athena PySpark workgroup (assumed by Athena-for-Spark, not by the tool Lambda)',
    });

    // Read/write the agentWorkspace bucket generally — sample data-lake tables
    // (dataLakeSeed) and Spark session logs/notebooks live under it.
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
    }));

    // Explicit, narrowly-scoped grant for the one path the design doc calls out
    // as a silent-failure risk (risk #5): the boto3 helper Slice 3 injects into
    // every PySpark session auto-uploads plots/results here, running under THIS
    // role — not the tool Lambda's. Redundant with the bucket-wide grant above,
    // but kept explicit so a future narrowing of that grant can't drop this path
    // without a reviewer noticing.
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${bucket.bucketArn}/files/artifacts/*`],
    }));

    // Glue Data Catalog access for Spark SQL (databases/tables/partitions).
    // Glue's catalog APIs don't support per-database/table ARN scoping cleanly
    // across all these actions, so this matches the reference implementation's
    // resource: '*' (scoped to this account/region implicitly via IAM anyway).
    this.executionRole.addToPolicy(new iam.PolicyStatement({
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
    }));

    // Session/calculation/notebook management — required for interactive
    // PySpark sessions (Slice 3's SubmitPySpark/GetPySparkStatus tools).
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
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
        'athena:GetWorkGroup',
      ],
      resources: [`arn:aws:athena:${region}:${account}:workgroup/*`],
    }));

    // Account-level catalog listing actions — Athena requires resource: '*' here.
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['athena:ListDataCatalogs', 'athena:ListDatabases', 'athena:ListTableMetadata'],
      resources: ['*'],
    }));

    // Spark session logs.
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws-athena/*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws-athena/*:log-stream:*`,
      ],
    }));

    this.workGroupName = props.workGroupName;
    this.workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: props.workGroupName,
      description: 'PySpark workgroup for the analytics agent (issue #500)',
      state: 'ENABLED',
      workGroupConfiguration: {
        engineVersion: {
          selectedEngineVersion: 'PySpark engine version 3',
        },
        executionRole: this.executionRole.roleArn,
        resultConfiguration: {
          outputLocation: `s3://${bucket.bucketName}/athena-results/`,
        },
      },
    });
  }
}
