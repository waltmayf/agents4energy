import type { Schema } from '../../data/resource';
import { PCSClient, GetClusterCommand, type Endpoint } from '@aws-sdk/client-pcs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { sign } from 'jsonwebtoken';

export const handler: Schema['submitSlurmJob']['functionHandler'] = async (event) => {

  try {
    const { clusterId, queueName, jobScript, jobName, nodes, tasks } = event.arguments;
    
    // Get cluster configuration from environment
    const region = process.env.AWS_REGION || 'us-east-1';
    const pcsClient = new PCSClient({ region });
    
    // Step 1: Get SLURM REST API endpoint from cluster
    console.log('Retrieving SLURM REST API endpoint...');
    const clusterCommand = new GetClusterCommand({
      clusterIdentifier: clusterId
    });
    const clusterResponse = await pcsClient.send(clusterCommand);
    const cluster = clusterResponse.cluster;
    
    if (!cluster) {
      throw new Error('Cluster not found');
    }
    
    // Find SLURMRESTD endpoint
    const slurmrestdEndpoint = cluster.endpoints?.find((ep: Endpoint) => ep.type === 'SLURMRESTD');
    if (!slurmrestdEndpoint || !slurmrestdEndpoint.privateIpAddress || !slurmrestdEndpoint.port) {
      throw new Error('SLURM REST API endpoint not found');
    }
    
    const apiEndpoint = `${slurmrestdEndpoint.privateIpAddress}:${slurmrestdEndpoint.port}`;
    console.log(`SLURM REST API endpoint: http://${apiEndpoint}`);
    
    // Step 2: Get JWT secret ARN
    const jwtSecretArn = cluster.slurmConfiguration?.jwtAuth?.jwtKey?.secretArn;
    if (!jwtSecretArn) {
      throw new Error('JWT secret ARN not found');
    }
    
    // Step 3: Retrieve JWT signing key from Secrets Manager
    console.log('Retrieving JWT signing key...');
    const secretsClient = new SecretsManagerClient({ region });
    const secretCommand = new GetSecretValueCommand({
      SecretId: jwtSecretArn
    });
    const secretResponse = await secretsClient.send(secretCommand);
    
    if (!secretResponse.SecretString) {
      throw new Error('JWT signing key not found');
    }
    
    // The secret is base64-encoded, decode it
    const signingKey = Buffer.from(secretResponse.SecretString, 'base64');
    console.log('JWT signing key retrieved (length:', signingKey.length, 'bytes)');
    
    // Step 4: Generate JWT token
    console.log('Generating JWT token...');
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      exp: now + 300,      // 5 minute expiration
      iat: now,
      sun: 'ec2-user',     // Username
      uid: 1000,           // POSIX user ID
      gid: 1000,           // POSIX group ID
      id: {
        gecos: 'EC2 User',
        dir: '/home/ec2-user',
        gids: [1000],
        shell: '/bin/bash'
      }
    };
    console.log('JWT payload:', JSON.stringify(payload, null, 2));
    
    const token = sign(
      payload,
      signingKey,
      { algorithm: 'HS256', noTimestamp: true }  // noTimestamp prevents automatic iat
    );
    
    console.log('JWT token generated (first 50 chars):', token.substring(0, 50));
    
    // Step 5: Submit job via SLURM REST API
    console.log('Submitting job to SLURM...');
    const jobSubmission = {
      job: {
        name: jobName || 'lambda-submitted-job',
        partition: queueName,
        nodes: nodes?.toString() || '1',  // Must be string, not integer
        tasks: tasks || 1,
        script: jobScript,
        current_working_directory: `/fsx/jobs/${Date.now()}`,  // Use FSx for Lustre
        environment: ['PATH=/usr/local/bin:/usr/bin:/bin']
      }
    };
    
    let response;
    try {
      // Set timeout for network request (25 seconds to stay under Lambda timeout)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      
      response = await fetch(`http://${apiEndpoint}/slurm/v0.0.43/job/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SLURM-USER-TOKEN': token  // Use X-SLURM-USER-TOKEN header instead of Authorization
        },
        body: JSON.stringify(jobSubmission),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
    } catch (fetchError: any) {
      // Handle network-level errors
      if (fetchError.name === 'AbortError') {
        console.error('Network timeout connecting to SLURM REST API');
        return {
          success: false,
          error: 'Network timeout: Unable to connect to SLURM REST API within 25 seconds'
        };
      }
      console.error('Network error connecting to SLURM REST API:', fetchError);
      return {
        success: false,
        error: `Network error: ${fetchError.message}`
      };
    }
    
    console.log('Response status:', response.status);
    console.log('Response headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('SLURM REST API error:', errorText);
      
      // Categorize error types
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: `Authentication failure: Invalid or expired JWT token (${response.status})`
        };
      } else if (response.status === 400) {
        return {
          success: false,
          error: `Invalid job submission: ${errorText}`
        };
      } else if (response.status >= 500) {
        return {
          success: false,
          error: `SLURM server error (${response.status}): ${errorText}`
        };
      }
      
      return {
        success: false,
        error: `SLURM REST API error (${response.status}): ${errorText}`
      };
    }
    
    const result = await response.json();
    const jobId = result.job_id || result.job?.job_id || result.results?.[0]?.job_id;
    
    if (!jobId) {
      console.error('Job ID not found in response:', JSON.stringify(result, null, 2));
      return {
        success: false,
        error: 'Job submitted but job ID not found in response'
      };
    }
    
    console.log('Job submitted successfully:', jobId);
    
    return {
      success: true,
      jobId: jobId?.toString(),
      message: 'Job submitted successfully via SLURM REST API'
    };
    
  } catch (error: any) {
    console.error('Error submitting job:', error);
    
    // Provide more specific error messages
    if (error.name === 'TimeoutError') {
      return {
        success: false,
        error: 'Request timeout: Operation took too long to complete'
      };
    }
    
    return {
      success: false,
      error: `Unexpected error: ${error.message}`
    };
  }
};
