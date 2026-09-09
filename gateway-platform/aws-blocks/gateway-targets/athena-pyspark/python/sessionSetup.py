import os

# Set AWS region for boto3 clients (not set by default in an Athena Spark session).
os.environ['AWS_DEFAULT_REGION'] = '{{AWS_REGION}}'

# Working directories the agent's PySpark code writes to — postExecution.py
# auto-uploads everything under these (and anything else in the CWD) to S3.
os.makedirs('plots', exist_ok=True)
os.makedirs('data', exist_ok=True)

s3BucketName = '{{STORAGE_BUCKET_NAME}}'
s3ArtifactsPrefix = '{{ARTIFACTS_S3_PREFIX}}'

print('s3 bucket: ', s3BucketName)
print('artifacts prefix: ', s3ArtifactsPrefix)


def uploadDfToS3(df, file_path):
    import io
    import boto3
    csv_buffer = io.StringIO()
    df.toPandas().to_csv(csv_buffer, header=True, index=False)
    csv_content = csv_buffer.getvalue().encode('utf-8')
    s3_client = boto3.client('s3')
    s3_client.put_object(Body=csv_content, Bucket=s3BucketName, Key=s3ArtifactsPrefix + file_path)


def getDataFrameFromS3(file_path):
    full_s3_path = f"s3://{s3BucketName}/{s3ArtifactsPrefix}{file_path}"
    df = spark.read.option("header", "true").option("inferSchema", "true").csv(full_s3_path)
    return df


def downloadFileFromS3(s3_path):
    import boto3
    import os
    local_path = s3_path.lstrip('/')
    dir_path = os.path.dirname(local_path)
    if dir_path:
        os.makedirs(dir_path, exist_ok=True)
    s3_client = boto3.client('s3')
    try:
        print(f"Downloading {s3_path} from S3...")
        s3_client.download_file(s3BucketName, s3ArtifactsPrefix + s3_path, local_path)
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
    s3_client = boto3.client('s3')
    content_type = None
    if s3_path.endswith('.html'):
        content_type = 'text/html'
    elif s3_path.endswith('.csv'):
        content_type = 'text/csv'
    elif s3_path.endswith('.json'):
        content_type = 'application/json'
    elif s3_path.endswith('.txt'):
        content_type = 'text/plain'
    elif s3_path.endswith('.png'):
        content_type = 'image/png'
    extra_args = {}
    if content_type:
        extra_args['ContentType'] = content_type
    s3_client.upload_file(file_path, s3BucketName, s3ArtifactsPrefix + s3_path, ExtraArgs=extra_args)
