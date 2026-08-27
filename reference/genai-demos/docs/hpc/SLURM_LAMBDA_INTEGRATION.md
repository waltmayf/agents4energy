# SLURM Lambda Integration (design notes)

> **Reality check vs deployed system.** These are early design notes for a VPC-Lambda → SLURM-REST-API pipeline. That path *does* exist (`amplify/functions/slurm-job-submitter`), but it is **not** the primary route and the deployment **does keep an always-on login node** (t3.medium, min=1) — the production submission path is SSM → `sbatch` on that login node (`amplify/functions/cfd-simulation-manager`). So the "zero infrastructure / no persistent login node" framing below does not describe the current deployment. See [README.md](README.md).

Yes, using a VPC-enabled Lambda function as a resolver for your GraphQL API is an excellent architectural choice for a serverless HPC pipeline. It allows you to submit jobs from the internet without exposing the cluster directly. 
Amazon Web Services (AWS)
Amazon Web Services (AWS)
1. Handling the Script Payload with FSx for Lustre 
Integrating Amazon FSx for Lustre significantly simplifies the "payload" problem. Instead of sending the entire script body through the REST API, you can: 
Step 1: Have your application (or another Lambda) upload the job script/data to the linked S3 bucket.
Step 2: FSx for Lustre can automatically import the file from S3 into the file system.
Step 3: Your GraphQL Lambda sends a Slurm REST API request that points to the script’s path on the FSx mount (e.g., /fsx/scripts/my_job.sh). 
Slurm Documentation
Slurm Documentation
 +3
2. The Lambda-in-VPC Architecture
To interact with the Slurm REST API, your Lambda must be attached to the same VPC as your AWS PCS cluster because the API endpoint is private. 
Amazon AWS Documentation
Amazon AWS Documentation
 +1
Security: This keeps your cluster entirely private. The Lambda acts as a secure bridge, triggered only by authorized GraphQL mutations.
Authentication: The Lambda will need to generate a JWT token using a managed signing key stored in AWS Secrets Manager. It includes this token in the X-SLURM-USER-TOKEN header of the HTTP request. 
Amazon AWS Documentation
Amazon AWS Documentation
 +2
3. Advantages of This Approach
Note: in the deployed system a 24/7 login node group IS retained (SSM sbatch path); the points below describe the REST-API-only variant.
Reduced Infrastructure: The REST-API-only variant avoids a 24/7 login node group.
Scale: Lambda can handle thousands of concurrent job submission requests from your GraphQL API.
Automation: You can easily chain logic—for example, the same Lambda can update a DynamoDB table with the job_id returned by Slurm so your frontend can track the job status. 
Amazon Web Services (AWS)
Amazon Web Services (AWS)
Critical Configuration Details
Port: Ensure your Cluster Security Group allows inbound HTTP traffic on port 6820 from the Lambda’s security group.
API Version: The Slurm REST API version corresponds to your cluster's version (e.g., Slurm 25.05 uses /slurm/v0.0.43/). 
Amazon AWS Documentation
Amazon AWS Documentation
 +2
Would you like to see a Python code snippet for a Lambda function that generates the JWT and submits a job, or should we discuss how to sync S3 and FSx for your scripts?