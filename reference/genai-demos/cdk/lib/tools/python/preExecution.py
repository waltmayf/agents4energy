# Download any files that are referenced in the code. `files_to_download` will be injected
for s3_path in files_to_download:
    downloadFileFromS3(s3_path)
