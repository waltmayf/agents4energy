/**
 * Cancel CFD Job Handler
 * 
 * Cancels a running or pending CFD simulation job by:
 * 1. Validating job exists and is RUNNING or PENDING
 * 2. Sending Slurm scancel command via SSM
 * 3. Verifying cancellation within 30 seconds
 * 4. Updating CFDSimulation status to CANCELLED
 * 5. Cleaning up partial result files from S3
 * 6. Returning success confirmation or error
 * 
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/cancel-cfd-job';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { SimulationStatus } from '../../graphql/API';
import type { UpdateCFDSimulationInput } from '../../graphql/API';
import { updateCFDSimulation } from '../../graphql/mutations';
import { 
  withRetry, 
  classifyError, 
  logError, 
  ErrorCategory, 
  ErrorCode, 
  ClassifiedError 
} from '../shared/utils/errorHandler';
import { 
  publishSimulationExecutionTime,
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// AWS SDK clients
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'CancelCfdJob';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';
// DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME is auto-injected by Amplify Gen 2 via allow.resource() in storage/resource.ts.
// STORAGE_BUCKET was manually set to 'PLACEHOLDER' in backend.ts due to cross-stack circular dependency.
const STORAGE_BUCKET = process.env.DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME || process.env.STORAGE_BUCKET || '';

// PCS Slurm binary paths (PCS installs Slurm at a non-standard location)
const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
const PCS_BIN = '/opt/aws/pcs/scheduler/slurm-25.05/bin';
const SLURM_ENV = `export SLURM_CONF=${SLURM_CONF}`;

/**
 * Find login node instance ID by EC2 tag
 * Requirement: 15.2
 */
async function findLoginNode(): Promise<string> {
  return withRetry({
    operation: async () => {
      const describeResult = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'tag:Name',
              Values: [HEAD_NODE_TAG],
            },
            {
              Name: 'instance-state-name',
              Values: ['running'],
            },
          ],
        })
      );

      const instances = describeResult.Reservations?.flatMap((r) => r.Instances || []) || [];
      if (instances.length === 0) {
        throw new ClassifiedError(
          ErrorCategory.SYSTEM,
          ErrorCode.CLUSTER_UNAVAILABLE,
          `Login node not found with tag ${HEAD_NODE_TAG}`,
          { headNodeTag: HEAD_NODE_TAG }
        );
      }

      return instances[0].InstanceId!;
    },
    operationName: 'FindLoginNode',
    component: COMPONENT_NAME,
    context: { headNodeTag: HEAD_NODE_TAG },
  });
}

/**
 * Send scancel command to Slurm via SSM
 * Requirement: 15.2
 */
async function cancelSlurmJob(
  loginNodeId: string,
  slurmJobId: string
): Promise<void> {
  return withRetry({
    operation: async () => {
      const cancelCommand = `${SLURM_ENV} && ${PCS_BIN}/scancel ${slurmJobId}`;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [cancelCommand],
          },
        })
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          'Failed to get SSM command ID',
          { loginNodeId, slurmJobId }
        );
      }

      // Wait for command to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        })
      );

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Slurm job cancellation failed: ${invocationResult.StandardErrorContent}`,
          { loginNodeId, commandId, slurmJobId, stderr: invocationResult.StandardErrorContent }
        );
      }

      console.log(`Successfully sent scancel command for job ${slurmJobId}`);
    },
    operationName: 'CancelSlurmJob',
    component: COMPONENT_NAME,
    context: { loginNodeId, slurmJobId },
  });
}

/**
 * Verify job cancellation by checking Slurm status
 * Requirement: 15.3
 */
async function verifyCancellation(
  loginNodeId: string,
  slurmJobId: string,
  maxAttempts: number = 6,
  delayMs: number = 5000
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const queryCommand = `
        ${SLURM_ENV}
        # Check if job is cancelled or no longer in queue
        SQUEUE_OUTPUT=$(${PCS_BIN}/squeue -j ${slurmJobId} --format="%T" --noheader 2>/dev/null || echo "")
        
        if [ -z "$SQUEUE_OUTPUT" ]; then
          # Job not in queue, check sacct for final status
          SACCT_OUTPUT=$(${PCS_BIN}/sacct -j ${slurmJobId} --format=State --noheader --parsable2 2>/dev/null | head -1 || echo "")
          echo "$SACCT_OUTPUT"
        else
          echo "$SQUEUE_OUTPUT"
        fi
      `;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [queryCommand],
          },
        })
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        console.warn(`Attempt ${attempt}: Failed to get SSM command ID`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        })
      );

      if (invocationResult.Status === 'Success') {
        const output = (invocationResult.StandardOutputContent || '').trim();
        
        // Check if job is cancelled or no longer exists
        if (output === '' || output.includes('CANCELLED') || output.includes('CANCELED')) {
          console.log(`Job ${slurmJobId} successfully cancelled (attempt ${attempt})`);
          return true;
        }
        
        console.log(`Attempt ${attempt}: Job status is ${output}, waiting...`);
      }

      // Wait before next attempt (unless it's the last attempt)
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      console.warn(`Attempt ${attempt} to verify cancellation failed:`, error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // If we've exhausted all attempts, return false
  console.warn(`Failed to verify cancellation after ${maxAttempts} attempts`);
  return false;
}

/**
 * Clean up partial result files from S3
 * Requirement: 15.5
 */
async function cleanupPartialResults(slurmJobId: string): Promise<void> {
  return withRetry({
    operation: async () => {
      const prefix = `cfd-simulations/results/${slurmJobId}/`;
      
      // List all objects with this prefix
      const listResult = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: STORAGE_BUCKET,
          Prefix: prefix,
        })
      );

      const objects = listResult.Contents || [];
      
      if (objects.length === 0) {
        console.log(`No partial result files found for job ${slurmJobId}`);
        return;
      }

      // Delete all objects
      const objectsToDelete = objects.map(obj => ({ Key: obj.Key! }));
      
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: STORAGE_BUCKET,
          Delete: {
            Objects: objectsToDelete,
          },
        })
      );

      console.log(`Cleaned up ${objects.length} partial result files for job ${slurmJobId}`);
    },
    operationName: 'CleanupPartialResults',
    component: COMPONENT_NAME,
    context: { slurmJobId },
  });
}

/**
 * Update CFDSimulation record status to CANCELLED
 * Requirement: 15.4
 */
async function updateSimulationStatus(
  amplifyClient: ReturnType<typeof generateClient<Schema>>,
  cfdSimulationId: string,
  status: SimulationStatus,
  errorMessage?: string
): Promise<void> {
  await withRetry({
    operation: async () => {
      const input: UpdateCFDSimulationInput = {
        id: cfdSimulationId,
        status,
        completedAt: new Date().toISOString(),
      };

      if (errorMessage) {
        input.errorMessage = errorMessage;
      }

      const result = await amplifyClient.graphql({
        query: updateCFDSimulation,
        variables: { input },
      });

      if (!result.data?.updateCFDSimulation) {
        throw new ClassifiedError(
          ErrorCategory.SYSTEM,
          ErrorCode.SERVICE_UNAVAILABLE,
          'Failed to update CFDSimulation record',
          { cfdSimulationId, status }
        );
      }
    },
    operationName: 'UpdateSimulationStatus',
    component: COMPONENT_NAME,
    context: { cfdSimulationId, status },
  });
}

/**
 * Handler for cancelCfdJob mutation
 */
export const handler: Schema['cancelCfdJob']['functionHandler'] = async (event) => {
  console.log('Cancelling CFD job', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { jobId } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'cancelCfdJob',
  };

  try {
    // ========================================================================
    // Step 1: Validate job exists and is RUNNING or PENDING
    // Requirement: 15.1
    // ========================================================================
    console.log(`Retrieving CFDSimulation record: ${jobId}`);
    
    const simulationResult = await withRetry({
      operation: async () => {
        const result = await client.models.CFDSimulation.get({ id: jobId });
        
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.MALFORMED_INPUT,
            `CFD simulation not found: ${jobId}`,
            { jobId }
          );
        }
        
        return result.data;
      },
      operationName: 'GetCFDSimulation',
      component: COMPONENT_NAME,
      context: { jobId },
    });

    const slurmJobId = simulationResult.clusterJobId;
    if (!slurmJobId) {
      throw new ClassifiedError(
        ErrorCategory.PERMANENT,
        ErrorCode.MALFORMED_INPUT,
        `No Slurm job ID found for simulation ${jobId}`,
        { jobId }
      );
    }

    // Check if job is in a cancellable state (Requirement 15.1)
    const currentStatus = simulationResult.status;
    if (currentStatus !== 'running' && currentStatus !== 'queued' && currentStatus !== 'initializing') {
      return {
        success: false,
        jobId,
        status: currentStatus?.toUpperCase() || 'UNKNOWN',
        error: `Job cannot be cancelled in current state: ${currentStatus}. Only RUNNING, QUEUED, or INITIALIZING jobs can be cancelled.`,
      };
    }

    console.log(`Found Slurm job ID: ${slurmJobId}, current status: ${currentStatus}`);

    // ========================================================================
    // Step 2: Find login node
    // Requirement: 15.2
    // ========================================================================
    console.log('Finding login node');
    const loginNodeId = await findLoginNode();
    console.log(`Found login node: ${loginNodeId}`);

    // ========================================================================
    // Step 3: Send Slurm scancel command via SSM
    // Requirement: 15.2
    // ========================================================================
    console.log('Sending scancel command to Slurm');
    await cancelSlurmJob(loginNodeId, slurmJobId);
    console.log('Scancel command sent successfully');

    // ========================================================================
    // Step 4: Verify cancellation within 30 seconds
    // Requirement: 15.3
    // ========================================================================
    console.log('Verifying job cancellation');
    const cancelled = await verifyCancellation(loginNodeId, slurmJobId, 6, 5000); // 6 attempts * 5s = 30s
    
    if (!cancelled) {
      console.warn('Failed to verify cancellation within 30 seconds');
      
      // Update status but indicate verification failed
      await updateSimulationStatus(
        client,
        jobId,
        SimulationStatus.cancelled,
        'Cancellation command sent but verification timed out'
      );

      return {
        success: false,
        jobId,
        status: 'CANCELLED',
        message: 'Cancellation command sent successfully, but verification timed out after 30 seconds. Job may still be cancelling.',
      };
    }

    console.log('Job cancellation verified successfully');

    // ========================================================================
    // Step 5: Update CFDSimulation status to CANCELLED
    // Requirement: 15.4
    // ========================================================================
    console.log('Updating CFDSimulation record status to CANCELLED');
    await updateSimulationStatus(client, jobId, SimulationStatus.cancelled);
    console.log('CFDSimulation record updated successfully');

    // ========================================================================
    // Step 6: Clean up partial result files from S3
    // Requirement: 15.5
    // ========================================================================
    console.log('Cleaning up partial result files from S3');
    try {
      await cleanupPartialResults(slurmJobId);
      console.log('Partial result files cleaned up successfully');
    } catch (error) {
      // Log cleanup error but don't fail the cancellation
      console.error('Failed to clean up partial result files:', error);
      logError(
        classifyError(error, { jobId, slurmJobId }),
        COMPONENT_NAME
      );
    }

    // ========================================================================
    // Step 7: Return success confirmation
    // Requirement: 15.1
    // ========================================================================
    
    // Publish metrics
    const executionTime = Date.now() - startTime;
    await publishSimulationExecutionTime(executionTime, dimensions);

    return {
      success: true,
      jobId,
      status: 'CANCELLED',
      message: `CFD simulation job ${jobId} (Slurm job ${slurmJobId}) cancelled successfully. Partial result files have been cleaned up.`,
    };

  } catch (error) {
    // Requirement 15.4: Return error
    const classifiedError = classifyError(error, { jobId });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    // Try to update simulation status to indicate cancellation failure
    try {
      await updateSimulationStatus(
        client,
        jobId,
        SimulationStatus.failed,
        `Cancellation failed: ${classifiedError.message}`
      );
    } catch (updateError) {
      console.error('Failed to update simulation status after cancellation error:', updateError);
    }

    return {
      success: false,
      jobId,
      status: 'FAILED',
      error: classifiedError.message,
    };
  }
};
