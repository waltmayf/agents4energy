import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  GlueClient,
  CreateDatabaseCommand,
  CreateTableCommand,
} from '@aws-sdk/client-glue';

interface ResourceProperties {
  BucketName: string;
  DatabaseName: string;
  DataLakePrefix: string;
}

const s3 = new S3Client({});
const glue = new GlueClient({});

const WELLS_CSV = [
  'well_id,well_name,field,spud_date,status',
  'W-1001,Antelope Ridge 1H,Antelope Ridge,2019-03-14,producing',
  'W-1002,Antelope Ridge 2H,Antelope Ridge,2019-05-02,producing',
  'W-1003,Coyote Flats 1H,Coyote Flats,2020-01-22,producing',
  'W-1004,Coyote Flats 2H,Coyote Flats,2020-02-18,shut-in',
  'W-1005,Sagebrush 1H,Sagebrush,2021-07-09,producing',
].join('\n') + '\n';

const PRODUCTION_CSV = [
  'well_id,report_date,oil_bbl,gas_mcf,water_bbl',
  'W-1001,2024-01-01,412,980,150',
  'W-1001,2024-02-01,398,955,162',
  'W-1002,2024-01-01,356,870,140',
  'W-1002,2024-02-01,341,845,148',
  'W-1003,2024-01-01,290,610,205',
  'W-1003,2024-02-01,275,590,211',
  'W-1004,2024-01-01,0,0,0',
  'W-1005,2024-01-01,180,420,90',
  'W-1005,2024-02-01,205,455,88',
].join('\n') + '\n';

interface SeedTable {
  name: string;
  csv: string;
  columns: Array<{ Name: string; Type: string }>;
}

const SEED_TABLES: SeedTable[] = [
  {
    name: 'wells',
    csv: WELLS_CSV,
    columns: [
      { Name: 'well_id', Type: 'string' },
      { Name: 'well_name', Type: 'string' },
      { Name: 'field', Type: 'string' },
      { Name: 'spud_date', Type: 'string' },
      { Name: 'status', Type: 'string' },
    ],
  },
  {
    name: 'production',
    csv: PRODUCTION_CSV,
    columns: [
      { Name: 'well_id', Type: 'string' },
      { Name: 'report_date', Type: 'string' },
      { Name: 'oil_bbl', Type: 'int' },
      { Name: 'gas_mcf', Type: 'int' },
      { Name: 'water_bbl', Type: 'int' },
    ],
  },
];

async function ensureDatabase(databaseName: string): Promise<void> {
  try {
    await glue.send(new CreateDatabaseCommand({
      DatabaseInput: { Name: databaseName, Description: 'Sample data lake seeded for the analytics agent (issue #500)' },
    }));
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AlreadyExistsException') throw err;
  }
}

async function uploadTableData(bucketName: string, prefix: string, table: SeedTable): Promise<string> {
  const location = `s3://${bucketName}/${prefix}/${table.name}/`;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `${prefix}/${table.name}/${table.name}.csv`,
    Body: table.csv,
    ContentType: 'text/csv',
  }));
  return location;
}

async function ensureTable(databaseName: string, table: SeedTable, location: string): Promise<void> {
  try {
    await glue.send(new CreateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: table.name,
        TableType: 'EXTERNAL_TABLE',
        Parameters: { classification: 'csv', 'skip.header.line.count': '1' },
        StorageDescriptor: {
          Location: location,
          InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          Columns: table.columns,
          SerdeInfo: {
            SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            Parameters: { 'field.delim': ',', 'skip.header.line.count': '1' },
          },
        },
      },
    }));
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AlreadyExistsException') throw err;
  }
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  // No-op on Delete: this only seeds demo tables to prove the PySpark tool
  // (Slice 3) has something to query out of the box — dropping the Glue
  // database on stack teardown could take an in-progress analytics session
  // down with it, same reasoning as S3ToolsMcpServerSeed's no-op-on-delete.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  await ensureDatabase(props.DatabaseName);

  for (const table of SEED_TABLES) {
    const location = await uploadTableData(props.BucketName, props.DataLakePrefix, table);
    await ensureTable(props.DatabaseName, table, location);
  }

  return { PhysicalResourceId: `${props.DatabaseName}/${props.DataLakePrefix}` };
};
