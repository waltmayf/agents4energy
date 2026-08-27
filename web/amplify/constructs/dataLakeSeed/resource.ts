import { Construct } from 'constructs';
import { Duration, CustomResource, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DataLakeSeedProps {
  /** The agentWorkspace bucket — sample table data is uploaded under `dataLakePrefix`. */
  bucket: IBucket;
  /** Glue database name to create (or reuse if it already exists). */
  databaseName: string;
  /** S3 key prefix (no leading slash, trailing slash) under which each table's data lives, e.g. `data-lake`. */
  dataLakePrefix: string;
}

/**
 * Idempotently seeds a small demo data lake (issue #500, epic #498 slice 2):
 * a Glue database plus two sample CSV tables ("wells", "production") that the
 * analytics agent's PySpark tool (Slice 3) can query via Spark SQL out of the
 * box, with no manual setup.
 *
 * A CDK custom resource is used (same Provider/NodejsFunction split as
 * `web/amplify/constructs/s3ToolsMcpServerSeed/`) because creating a Glue
 * database + uploading fixed sample data is a one-time/idempotent deploy-time
 * action, not something CloudFormation has a native resource for. Unlike that
 * construct's AppSync calls, S3/Glue calls here use the AWS SDK clients
 * directly under the handler's own execution-role credentials — no manual
 * SigV4 signing needed.
 */
export class DataLakeSeed extends Construct {
  constructor(scope: Construct, id: string, props: DataLakeSeedProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
        DATABASE_NAME: props.databaseName,
        DATA_LAKE_PREFIX: props.dataLakePrefix,
      },
    });

    props.bucket.grantPut(fn, `${props.dataLakePrefix}/*`);

    const { region, account } = Stack.of(this);
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['glue:CreateDatabase', 'glue:GetDatabase', 'glue:CreateTable', 'glue:GetTable'],
      resources: [
        `arn:aws:glue:${region}:${account}:catalog`,
        `arn:aws:glue:${region}:${account}:database/${props.databaseName}`,
        `arn:aws:glue:${region}:${account}:table/${props.databaseName}/*`,
      ],
    }));

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        BucketName: props.bucket.bucketName,
        DatabaseName: props.databaseName,
        DataLakePrefix: props.dataLakePrefix,
      },
    });
  }
}
