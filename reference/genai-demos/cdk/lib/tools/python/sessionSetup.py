import os

# Set AWS region for boto3 clients (not set by default in Athena Spark)
os.environ['AWS_DEFAULT_REGION'] = '{{AWS_REGION}}'

# Create the output directory and subdirectories if they don't exist
os.makedirs('plots', exist_ok=True)
os.makedirs('data', exist_ok=True)

s3BucketName = '{{STORAGE_BUCKET_NAME}}'
chatSessionS3Prefix = '{{CHAT_SESSION_PREFIX}}'
awsRegion = '{{AWS_REGION}}'
globalS3Uri = 's3://{{STORAGE_BUCKET_NAME}}/global/'

print('s3 bucket: ', s3BucketName)
print('chat session prefix: ', chatSessionS3Prefix)

def uploadDfToS3(df, file_path):
    import io
    import boto3
    csv_buffer = io.StringIO()
    df.toPandas().to_csv(csv_buffer, header=True, index=False)
    csv_content = csv_buffer.getvalue().encode('utf-8')
    s3_client = boto3.client('s3')
    s3_client.put_object(Body=csv_content, Bucket=s3BucketName, Key=chatSessionS3Prefix + file_path)

def getDataFrameFromS3(file_path):
    full_s3_path = f"s3://{s3BucketName}/{chatSessionS3Prefix}{file_path}"
    df = spark.read.option("header", "true").option("inferSchema", "true").csv(full_s3_path)
    return df

def downloadFileFromS3(s3_path):
    import boto3
    import os
    local_path = s3_path.lstrip('/')
    dir_path = os.path.dirname(local_path)
    if dir_path:
        os.makedirs(dir_path, exist_ok=True)
    try:
        print(f"Downloading {s3_path} from S3...")
        s3_client = boto3.client('s3')
        s3_key = s3_path if s3_path.startswith('global/') else chatSessionS3Prefix + s3_path
        s3_client.download_file(s3BucketName, s3_key, local_path)
        print(f"Successfully downloaded {local_path}")
    except s3_client.exceptions.ClientError as e:
        if e.response['Error']['Code'] == '404':
            print(f"Skipped {s3_path} (not yet in S3, will be created by this script)")
        else:
            print(f"Warning: could not download {s3_path}: {str(e)}")
    except Exception as e:
        print(f"Warning: could not download {s3_path}: {str(e)}")

def uploadFileToS3(file_path, s3_path):
    import boto3
    import os
    s3_client = boto3.client('s3')
    content_type = None
    if s3_path.endswith('.html'): content_type = 'text/html'
    elif s3_path.endswith('.csv'): content_type = 'text/csv'
    elif s3_path.endswith('.json'): content_type = 'application/json'
    elif s3_path.endswith('.txt'): content_type = 'text/plain'
    elif s3_path.endswith('.png'): content_type = 'image/png'
    extra_args = {}
    if content_type: extra_args['ContentType'] = content_type
    s3_client.upload_file(file_path, s3BucketName, chatSessionS3Prefix + s3_path, ExtraArgs=extra_args)

def listFederatedCatalogs():
    """List all Athena data catalogs, highlighting federated (LAMBDA) connectors."""
    import boto3
    athena = boto3.client('athena')
    response = athena.list_data_catalogs()
    catalogs = response.get('DataCatalogsSummary', [])
    for cat in catalogs:
        marker = '🔗' if cat.get('Type') in ('LAMBDA', 'FEDERATED') else '📁'
        print(f"  {marker} {cat['CatalogName']} ({cat.get('Type', 'UNKNOWN')})")
    return catalogs

def query_federated(sql, catalog=None):
    """Query a federated data source via Athena JDBC and return a Spark DataFrame.

    Usage:
        df = query_federated('SELECT * FROM "snowflake-tpch"."TPCH_SF1"."NATION" LIMIT 10')
        df = query_federated('SELECT * FROM TPCH_SF1.NATION LIMIT 10', catalog='snowflake-tpch')
    """
    if catalog:
        # Wrap unqualified query with the catalog prefix
        sql = sql.replace('FROM ', f'FROM "{catalog}".', 1)
    jdbc_url = f"jdbc:awsathena://athena.{awsRegion}.amazonaws.com:443"
    return spark.read.format("jdbc") \
        .option("url", jdbc_url) \
        .option("driver", "com.simba.athena.jdbc.Driver") \
        .option("dbtable", f"({sql}) t") \
        .option("AwsCredentialsProviderClass", "com.simba.athena.amazonaws.auth.InstanceProfileCredentialsProvider") \
        .load()

# Validate athena catalog registration for federated query support
try:
    catalogs_df = spark.sql("SHOW CATALOGS")
    catalog_names = [row[0] for row in catalogs_df.collect()]
    if 'athena' in catalog_names:
        print("✅ Federated query support available (athena catalog registered)")
    else:
        print("⚠️ Federated query support NOT available (athena catalog not found in: " + str(catalog_names) + ")")
except Exception as e:
    print("⚠️ Could not verify federated query support: " + str(e))
