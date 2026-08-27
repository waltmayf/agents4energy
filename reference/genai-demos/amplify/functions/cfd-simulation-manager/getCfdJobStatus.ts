/**
 * Get CFD Job Status Handler
 * 
 * Queries the status of a CFD simulation job by:
 * 1. Querying Slurm via SSM SendCommand (squeue, sacct)
 * 2. Parsing Slurm output to extract job state
 * 3. Mapping Slurm states to status enum: PENDING, RUNNING, COMPLETED, FAILED, CANCELLED
 * 4. Extracting elapsed time and estimated completion for RUNNING jobs
 * 5. Returning S3 result path for COMPLETED jobs
 * 6. Returning error logs and failure reason for FAILED jobs
 * 7. Updating CFDSimulation record in DynamoDB
 * 8. Returning within 2 seconds
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/get-cfd-job-status';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { SimulationStatus, JobStatus } from '../../graphql/API';
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
  publishQueueWaitTime,
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// AWS SDK clients
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'GetCfdJobStatus';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';
// DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME is auto-injected by Amplify Gen 2 via allow.resource() in storage/resource.ts.
// STORAGE_BUCKET was manually set to 'PLACEHOLDER' in backend.ts due to cross-stack circular dependency.
// HPC_BUCKET is the S3 bucket linked to FSx Lustre via Data Repository Association (auto-export).
const STORAGE_BUCKET = process.env.DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME || process.env.STORAGE_BUCKET || '';
const HPC_BUCKET = process.env.HPC_BUCKET || '';

// PCS Slurm binary paths (PCS installs Slurm at a non-standard location)
const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
const PCS_BIN = '/opt/aws/pcs/scheduler/slurm-25.05/bin';
const SLURM_ENV = `export SLURM_CONF=${SLURM_CONF}`;

// Slurm job state mapping to JobStatus enum (uppercase values for GraphQL response)
// Requirement 3.3: Support status values: PENDING, RUNNING, COMPLETED, FAILED, CANCELLED
const SLURM_STATE_MAP: Record<string, JobStatus> = {
  // Pending states
  'PENDING': JobStatus.PENDING,
  'CONFIGURING': JobStatus.PENDING,
  'REQUEUED': JobStatus.PENDING,
  'RESIZING': JobStatus.PENDING,
  'SUSPENDED': JobStatus.PENDING,
  
  // Running states
  'RUNNING': JobStatus.RUNNING,
  'COMPLETING': JobStatus.RUNNING,
  'STAGE_OUT': JobStatus.RUNNING,
  
  // Completed states
  'COMPLETED': JobStatus.COMPLETED,
  
  // Failed states
  'FAILED': JobStatus.FAILED,
  'TIMEOUT': JobStatus.FAILED,
  'NODE_FAIL': JobStatus.FAILED,
  'PREEMPTED': JobStatus.FAILED,
  'OUT_OF_MEMORY': JobStatus.FAILED,
  'BOOT_FAIL': JobStatus.FAILED,
  'DEADLINE': JobStatus.FAILED,
  
  // Cancelled states
  'CANCELLED': JobStatus.CANCELLED,
  'REVOKED': JobStatus.CANCELLED,
};

// Mapping from JobStatus (response) to SimulationStatus (DynamoDB model)
const JOB_TO_SIMULATION_STATUS: Record<JobStatus, SimulationStatus> = {
  [JobStatus.PENDING]: SimulationStatus.queued,
  [JobStatus.RUNNING]: SimulationStatus.running,
  [JobStatus.COMPLETED]: SimulationStatus.completed,
  [JobStatus.FAILED]: SimulationStatus.failed,
  [JobStatus.CANCELLED]: SimulationStatus.cancelled,
};

/**
 * Normalize Slurm state string (sacct can return states like "CANCELLED by 1000" or "COMPLETED+")
 */
function normalizeSlurmState(rawState: string): string {
  // Strip trailing '+' (sacct suffix for jobs that exceeded resource limits)
  // Strip " by <uid>" suffix from CANCELLED states
  return rawState.replace(/\+$/, '').replace(/\s+by\s+\d+$/, '').trim();
}

/**
 * Parsed Slurm job information
 */
interface SlurmJobInfo {
  jobId: string;
  state: string;
  elapsedTime?: string;
  timeLimit?: string;
  startTime?: string;
  endTime?: string;
  exitCode?: string;
  reason?: string;
}

/**
 * Find login node instance ID by EC2 tag
 * Requirement: 3.2
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
 * Query Slurm for job status via SSM SendCommand
 * Requirement: 3.2
 */
async function querySlurmJobStatus(
  loginNodeId: string,
  slurmJobId: string
): Promise<SlurmJobInfo> {
  return withRetry({
    operation: async () => {
      // Try squeue first (for active jobs), then scontrol (for recently completed),
      // then sacct (for historical jobs — may be disabled on PCS clusters)
      const queryCommand = `
        ${SLURM_ENV}
        # Try squeue first for active jobs
        SQUEUE_OUTPUT=$(${PCS_BIN}/squeue -j ${slurmJobId} --format="%i|%T|%M|%l|%S|%e|%r" --noheader 2>/dev/null || echo "")
        
        if [ -n "$SQUEUE_OUTPUT" ]; then
          echo "SQUEUE:$SQUEUE_OUTPUT"
        else
          # Job not in queue — try scontrol (works for recently completed jobs even without accounting)
          SCONTROL_OUTPUT=$(${PCS_BIN}/scontrol show job ${slurmJobId} 2>/dev/null || echo "")
          if [ -n "$SCONTROL_OUTPUT" ] && ! echo "$SCONTROL_OUTPUT" | grep -q "Invalid job id"; then
            # Extract fields from scontrol output
            JOB_STATE=$(echo "$SCONTROL_OUTPUT" | grep -oP 'JobState=\\K[^ ]+' || echo "")
            ELAPSED=$(echo "$SCONTROL_OUTPUT" | grep -oP 'RunTime=\\K[^ ]+' || echo "N/A")
            TIMELIMIT=$(echo "$SCONTROL_OUTPUT" | grep -oP 'TimeLimit=\\K[^ ]+' || echo "N/A")
            START=$(echo "$SCONTROL_OUTPUT" | grep -oP 'StartTime=\\K[^ ]+' || echo "N/A")
            END_T=$(echo "$SCONTROL_OUTPUT" | grep -oP 'EndTime=\\K[^ ]+' || echo "N/A")
            EXIT_CODE=$(echo "$SCONTROL_OUTPUT" | grep -oP 'ExitCode=\\K[^ ]+' || echo "N/A")
            REASON=$(echo "$SCONTROL_OUTPUT" | grep -oP 'Reason=\\K[^ ]+' || echo "None")
            echo "SACCT:${slurmJobId}|$JOB_STATE|$ELAPSED|$TIMELIMIT|$START|$END_T|$EXIT_CODE|$REASON"
          else
            # Fall back to sacct for historical jobs
            SACCT_OUTPUT=$(${PCS_BIN}/sacct -j ${slurmJobId} --format=JobID,State,Elapsed,Timelimit,Start,End,ExitCode,Reason --noheader --parsable2 2>/dev/null | head -1 || echo "")
            if [ -n "$SACCT_OUTPUT" ]; then
              echo "SACCT:$SACCT_OUTPUT"
            else
              # Last resort: check S3 for results (job completed but Slurm lost track)
              S3_CHECK=$(aws s3 ls s3://\${HPC_BUCKET:-no-bucket}/cfd-simulations/${slurmJobId}/results/ 2>/dev/null | head -1 || echo "")
              if [ -n "$S3_CHECK" ]; then
                echo "SACCT:${slurmJobId}|COMPLETED|N/A|N/A|N/A|N/A|0:0|None"
              else
                echo "NOT_FOUND"
              fi
            fi
          fi
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
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          'Failed to get SSM command ID',
          { loginNodeId, slurmJobId }
        );
      }

      // Wait for command to complete (Requirement 3.1: within 2 seconds)
      await new Promise((resolve) => setTimeout(resolve, 1500));

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
          `Slurm status query failed: ${invocationResult.StandardErrorContent}`,
          { loginNodeId, commandId, slurmJobId, stderr: invocationResult.StandardErrorContent }
        );
      }

      const output = (invocationResult.StandardOutputContent || '').trim();
      
      if (output === 'NOT_FOUND') {
        throw new ClassifiedError(
          ErrorCategory.PERMANENT,
          ErrorCode.MALFORMED_INPUT,
          `Job ${slurmJobId} not found in Slurm queue or history`,
          { slurmJobId }
        );
      }

      // Parse output based on source (squeue or sacct)
      if (output.startsWith('SQUEUE:')) {
        return parseSqueueOutput(output.substring(7), slurmJobId);
      } else if (output.startsWith('SACCT:')) {
        return parseSacctOutput(output.substring(6), slurmJobId);
      } else {
        throw new ClassifiedError(
          ErrorCategory.PERMANENT,
          ErrorCode.MALFORMED_INPUT,
          `Failed to parse Slurm output: ${output}`,
          { output, slurmJobId }
        );
      }
    },
    operationName: 'QuerySlurmJobStatus',
    component: COMPONENT_NAME,
    context: { loginNodeId, slurmJobId },
  });
}

/**
 * Parse squeue output (format: jobid|state|elapsed|timelimit|starttime|endtime|reason)
 */
function parseSqueueOutput(output: string, jobId: string): SlurmJobInfo {
  const parts = output.split('|');
  
  if (parts.length < 7) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      `Invalid squeue output format: ${output}`,
      { output, jobId }
    );
  }

  return {
    jobId: parts[0].trim(),
    state: parts[1].trim(),
    elapsedTime: parts[2].trim(),
    timeLimit: parts[3].trim(),
    startTime: parts[4].trim(),
    endTime: parts[5].trim(),
    reason: parts[6].trim(),
  };
}

/**
 * Parse sacct output (format: jobid|state|elapsed|timelimit|start|end|exitcode|reason)
 */
function parseSacctOutput(output: string, jobId: string): SlurmJobInfo {
  const parts = output.split('|');
  
  if (parts.length < 8) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      `Invalid sacct output format: ${output}`,
      { output, jobId }
    );
  }

  return {
    jobId: parts[0].trim(),
    state: parts[1].trim(),
    elapsedTime: parts[2].trim(),
    timeLimit: parts[3].trim(),
    startTime: parts[4].trim(),
    endTime: parts[5].trim(),
    exitCode: parts[6].trim(),
    reason: parts[7].trim(),
  };
}

/**
 * Convert elapsed time string (HH:MM:SS or DD-HH:MM:SS) to seconds
 */
function parseElapsedTime(elapsed: string): number {
  if (!elapsed || elapsed === 'N/A') {
    return 0;
  }

  try {
    // Handle format: DD-HH:MM:SS
    if (elapsed.includes('-')) {
      const [days, time] = elapsed.split('-');
      const [hours, minutes, seconds] = time.split(':').map(Number);
      return parseInt(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
    }
    
    // Handle format: HH:MM:SS
    const parts = elapsed.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    
    return 0;
  } catch (error) {
    console.warn(`Failed to parse elapsed time: ${elapsed}`, error);
    return 0;
  }
}

/**
 * Estimate completion time for running jobs
 * Requirement 3.4: Return estimated completion time for RUNNING jobs
 */
function estimateCompletionTime(elapsedTime: string, timeLimit: string): number | undefined {
  if (!timeLimit || timeLimit === 'N/A' || timeLimit === 'UNLIMITED') {
    return undefined;
  }

  const elapsedSeconds = parseElapsedTime(elapsedTime);
  const limitSeconds = parseElapsedTime(timeLimit);
  
  if (limitSeconds > 0 && elapsedSeconds > 0) {
    return Math.max(0, limitSeconds - elapsedSeconds);
  }
  
  return undefined;
}

/**
 * Get S3 result path for completed jobs
 * Requirement 3.5: Return S3 path for COMPLETED jobs
 */
function getS3ResultPath(slurmJobId: string): string {
  // FSx DRA auto-exports to HPC_BUCKET at cfd-simulations/<jobId>/results/
  const bucket = HPC_BUCKET && HPC_BUCKET !== 'PLACEHOLDER' ? HPC_BUCKET : STORAGE_BUCKET;
  return `s3://${bucket}/cfd-simulations/${slurmJobId}/results/`;
}

/**
 * Get error logs for failed jobs
 * Requirement 3.6: Return error logs and failure reason for FAILED jobs
 */
async function getErrorLogs(
  loginNodeId: string,
  slurmJobId: string
): Promise<{ errorLog: string; failureReason: string }> {
  try {
    const logCommand = `
      ERROR_LOG="/fsx/cfd-simulations/logs/${slurmJobId}.err"
      if [ -f "$ERROR_LOG" ]; then
        tail -50 "$ERROR_LOG"
      else
        echo "Error log not found"
      fi
    `;

    const commandResult = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [loginNodeId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
          commands: [logCommand],
        },
      })
    );

    const commandId = commandResult.Command?.CommandId;
    if (!commandId) {
      return {
        errorLog: 'Failed to retrieve error log',
        failureReason: 'SSM command failed',
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const invocationResult = await ssmClient.send(
      new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: loginNodeId,
      })
    );

    const errorLog = invocationResult.StandardOutputContent || 'No error log available';
    
    // Extract failure reason from error log (look for common error patterns)
    let failureReason = 'Unknown failure';
    if (errorLog.includes('out of memory') || errorLog.includes('OOM')) {
      failureReason = 'Out of memory';
    } else if (errorLog.includes('timeout') || errorLog.includes('TIMEOUT')) {
      failureReason = 'Job timeout';
    } else if (errorLog.includes('node fail') || errorLog.includes('NODE_FAIL')) {
      failureReason = 'Compute node failure';
    } else if (errorLog.includes('segmentation fault') || errorLog.includes('SIGSEGV')) {
      failureReason = 'Segmentation fault';
    } else if (errorLog.includes('convergence') || errorLog.includes('diverged')) {
      failureReason = 'Simulation divergence';
    }

    return {
      errorLog,
      failureReason,
    };
  } catch (error) {
    console.error('Failed to retrieve error logs', error);
    return {
      errorLog: 'Failed to retrieve error log',
      failureReason: 'Error log retrieval failed',
    };
  }
}

/**
 * Update CFDSimulation record in DynamoDB
 * Requirement 3.6: Update CFDSimulation record
 */
async function updateSimulationRecord(
  amplifyClient: ReturnType<typeof generateClient<Schema>>,
  cfdSimulationId: string,
  status: SimulationStatus,
  additionalData: Record<string, string | number | undefined>
): Promise<void> {
  await withRetry({
    operation: async () => {
      const input: UpdateCFDSimulationInput = {
        id: cfdSimulationId,
        status,
        ...additionalData,
      };

      console.log('Updating CFDSimulation with input:', JSON.stringify(input));

      try {
        const result = await amplifyClient.graphql({
          query: updateCFDSimulation,
          variables: { input },
        });
        console.log('Update result:', JSON.stringify(result.data?.updateCFDSimulation?.id));
      } catch (graphqlError) {
        console.error('GraphQL update error:', JSON.stringify(graphqlError));
        const errorMessage = graphqlError instanceof Error 
          ? graphqlError.message 
          : JSON.stringify(graphqlError);
        throw new ClassifiedError(
          ErrorCategory.SYSTEM,
          ErrorCode.SERVICE_UNAVAILABLE,
          `Failed to update CFDSimulation: ${errorMessage}`,
          { cfdSimulationId, status }
        );
      }
    },
    operationName: 'UpdateCFDSimulation',
    component: COMPONENT_NAME,
    context: { cfdSimulationId, status },
  });
}

/**
 * Handler for getCfdJobStatus query
 */
export const handler: Schema['getCfdJobStatus']['functionHandler'] = async (event) => {
  const startTime = Date.now();
  console.log('Getting CFD job status', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const { jobId } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'getCfdJobStatus',
  };

  try {
    // ========================================================================
    // Step 1: Retrieve CFDSimulation record to get Slurm job ID
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

    console.log(`Found Slurm job ID: ${slurmJobId}`);

    // ========================================================================
    // Step 2: Find login node
    // Requirement: 3.2
    // ========================================================================
    console.log('Finding login node');
    const loginNodeId = await findLoginNode();
    console.log(`Found login node: ${loginNodeId}`);

    // ========================================================================
    // Step 3: Query Slurm for job status
    // Step 4: Parse Slurm output to extract job state
    // Requirements: 3.2, 3.3
    // ========================================================================
    console.log('Querying Slurm for job status');
    const slurmJobInfo = await querySlurmJobStatus(loginNodeId, slurmJobId);
    console.log('Slurm job info:', slurmJobInfo);

    // ========================================================================
    // Step 5: Map Slurm state to status enum
    // Requirement: 3.3
    // ========================================================================
    const normalizedState = normalizeSlurmState(slurmJobInfo.state);
    const mappedStatus = SLURM_STATE_MAP[normalizedState] || JobStatus.FAILED;
    console.log(`Mapped status: ${slurmJobInfo.state} -> ${normalizedState} -> ${mappedStatus}`);

    // ========================================================================
    // Step 6: Build response based on job status
    // Requirements: 3.4, 3.5, 3.6
    // ========================================================================
    const response: {
      success: boolean;
      jobId: string;
      status: JobStatus;
      elapsedTimeSeconds?: number;
      estimatedCompletionSeconds?: number;
      s3ResultPath?: string;
      error?: string;
      errorLog?: string;
    } = {
      success: true,
      jobId,
      status: mappedStatus,
    };

    // Requirement 3.4: Extract elapsed time and estimated completion for RUNNING jobs
    if (mappedStatus === JobStatus.RUNNING) {
      const elapsedSeconds = parseElapsedTime(slurmJobInfo.elapsedTime || '');
      const estimatedSeconds = estimateCompletionTime(
        slurmJobInfo.elapsedTime || '',
        slurmJobInfo.timeLimit || ''
      );
      
      response.elapsedTimeSeconds = elapsedSeconds;
      if (estimatedSeconds !== undefined) {
        response.estimatedCompletionSeconds = estimatedSeconds;
      }
      
      console.log(`Running job - elapsed: ${elapsedSeconds}s, estimated completion: ${estimatedSeconds}s`);
    }

    // Requirement 3.5: Return S3 result path for COMPLETED jobs
    if (mappedStatus === JobStatus.COMPLETED) {
      response.s3ResultPath = getS3ResultPath(slurmJobId);
      console.log(`Completed job - result path: ${response.s3ResultPath}`);
    }

    // Requirement 3.6: Return error logs and failure reason for FAILED jobs
    if (mappedStatus === JobStatus.FAILED) {
      const { errorLog, failureReason } = await getErrorLogs(loginNodeId, slurmJobId);
      response.error = failureReason;
      response.errorLog = errorLog;
      console.log(`Failed job - reason: ${failureReason}`);
    }

    // ========================================================================
    // Step 7: Update CFDSimulation record in DynamoDB
    // Requirement: 3.6
    // ========================================================================
    console.log('Updating CFDSimulation record');
    
    const updateData: Record<string, any> = {};
    
    if (mappedStatus === JobStatus.RUNNING && !simulationResult.startedAt) {
      updateData.startedAt = new Date().toISOString();
    }
    
    if (mappedStatus === JobStatus.COMPLETED || mappedStatus === JobStatus.FAILED || mappedStatus === JobStatus.CANCELLED) {
      if (!simulationResult.completedAt) {
        updateData.completedAt = new Date().toISOString();
      }
    }
    
    if (mappedStatus === JobStatus.FAILED) {
      updateData.errorMessage = response.error as string;
    }
    
    const dbStatus = JOB_TO_SIMULATION_STATUS[mappedStatus];
    await updateSimulationRecord(client, jobId, dbStatus, updateData);

    // ========================================================================
    // Step 8: Return within 2 seconds
    // Requirement: 3.1
    // ========================================================================
    const elapsedMs = Date.now() - startTime;
    console.log(`Job status query completed in ${elapsedMs}ms`);
    
    if (elapsedMs > 2000) {
      console.warn(`Query exceeded 2 second target: ${elapsedMs}ms`);
    }

    // Publish metrics
    await publishSimulationExecutionTime(elapsedMs, dimensions);
    
    // Publish queue wait time if available
    if (mappedStatus === JobStatus.RUNNING && response.elapsedTimeSeconds) {
      const queueWaitTime = parseElapsedTime(slurmJobInfo.elapsedTime || '') - (response.elapsedTimeSeconds as number);
      if (queueWaitTime > 0) {
        await publishQueueWaitTime(queueWaitTime, dimensions);
      }
    }

    return response;

  } catch (error) {
    const classifiedError = classifyError(error, { jobId });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    return {
      success: false,
      jobId,
      status: 'FAILED',
      error: classifiedError.message,
    };
  }
};
