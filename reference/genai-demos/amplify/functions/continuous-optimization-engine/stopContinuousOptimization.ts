/**
 * Stop Continuous Optimization Handler
 * 
 * Stops continuous optimization for a fracturing operation by:
 * 1. Validating the session exists and is ACTIVE
 * 2. Canceling all running Slurm jobs for the session (physics, ROM, CFD)
 * 3. Updating OptimizationSession status to STOPPED with stoppedAt timestamp
 * 4. Calculating final performance metrics (total iterations, compute time, cost)
 * 5. Returning success confirmation
 * 
 * Requirements: 2.1, 15.1, 15.2, 15.3
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/stop-continuous-optimization';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { withRetry, classifyError, logError, ErrorCategory, ErrorCode, ClassifiedError } from '../shared/utils/errorHandler';
import { OptimizationStatus } from '../../graphql/API';
import type { UpdateWellOperationInput } from '../../graphql/API';
import { updateWellOperation } from '../../graphql/mutations';
import { 
  publishOptimizationIterationTime, 
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// AWS SDK clients
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'StopContinuousOptimization';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';

/**
 * Handler for stopContinuousOptimization mutation
 */
export const handler: Schema['stopContinuousOptimization']['functionHandler'] = async (event) => {
  console.log('Stopping continuous optimization', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { sessionId } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'stopContinuousOptimization',
    SessionId: sessionId,
  };

  try {
    // ========================================================================
    // Step 1: Validate session exists and is ACTIVE
    // ========================================================================
    console.log(`Validating optimization session ${sessionId}`);
    
    const sessionResult = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationSession.get({ id: sessionId });
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.INVALID_PARAMETERS,
            `Optimization session ${sessionId} not found`,
            { sessionId }
          );
        }
        return result.data;
      },
      operationName: 'GetOptimizationSession',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    // Check if session is ACTIVE
    if (sessionResult.status !== 'ACTIVE') {
      return {
        success: false,
        sessionId,
        status: sessionResult.status,
        error: `Cannot stop optimization session ${sessionId} - current status is ${sessionResult.status}, expected ACTIVE`,
      };
    }

    const operationId = sessionResult.operationId;
    console.log(`Session ${sessionId} is ACTIVE for operation ${operationId}`);

    // ========================================================================
    // Step 2: Cancel all running Slurm jobs for the session
    // ========================================================================
    console.log('Canceling all running Slurm jobs for session');
    
    // Query all simulations for this session
    const simulationsResult = await withRetry({
      operation: async () => {
        const result = await client.models.CFDSimulation.list({
          filter: {
            optimizationSessionId: { eq: sessionId },
            status: { eq: 'running' }
          }
        });
        return result.data || [];
      },
      operationName: 'ListRunningSimulations',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    console.log(`Found ${simulationsResult.length} running simulations to cancel`);

    // Cancel each running simulation
    const cancelResults = await Promise.allSettled(
      simulationsResult.map(async (simulation) => {
        if (!simulation.clusterJobId) {
          console.warn(`Simulation ${simulation.id} has no clusterJobId, skipping cancellation`);
          return { simulationId: simulation.id, cancelled: false, reason: 'No clusterJobId' };
        }

        try {
          // Find login node
          const loginNodeId = await withRetry({
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
            context: { sessionId, simulationId: simulation.id },
          });

          // Cancel Slurm job via SSM
          await withRetry({
            operation: async () => {
              const commandResult = await ssmClient.send(
                new SendCommandCommand({
                  InstanceIds: [loginNodeId],
                  DocumentName: 'AWS-RunShellScript',
                  Parameters: {
                    commands: [`export SLURM_CONF=/var/spool/slurmd/conf-cache/slurm.conf && /opt/aws/pcs/scheduler/slurm-25.05/bin/scancel ${simulation.clusterJobId}`],
                  },
                })
              );

              const commandId = commandResult.Command?.CommandId;
              if (!commandId) {
                throw new ClassifiedError(
                  ErrorCategory.TRANSIENT,
                  ErrorCode.SSM_THROTTLING,
                  'Failed to get SSM command ID',
                  { loginNodeId, jobId: simulation.clusterJobId }
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
                console.warn(`Failed to cancel job ${simulation.clusterJobId}: ${invocationResult.StandardErrorContent}`);
              }
            },
            operationName: 'CancelSlurmJob',
            component: COMPONENT_NAME,
            context: { sessionId, simulationId: simulation.id, jobId: simulation.clusterJobId },
          });

          // Update simulation status to CANCELLED
          await client.models.CFDSimulation.update({
            id: simulation.id,
            status: 'cancelled',
            completedAt: new Date().toISOString(),
          });

          console.log(`Cancelled simulation ${simulation.id} (job ${simulation.clusterJobId})`);
          return { simulationId: simulation.id, cancelled: true };

        } catch (error) {
          const classifiedError = classifyError(error, { sessionId, simulationId: simulation.id });
          logError(classifiedError, COMPONENT_NAME);
          return { simulationId: simulation.id, cancelled: false, error: classifiedError.message };
        }
      })
    );

    // Count successful cancellations
    const successfulCancellations = cancelResults.filter(
      (result) => result.status === 'fulfilled' && result.value.cancelled
    ).length;

    console.log(`Successfully cancelled ${successfulCancellations}/${simulationsResult.length} simulations`);

    // ========================================================================
    // Step 3: Calculate final performance metrics
    // ========================================================================
    console.log('Calculating final performance metrics');
    
    // Query all results for this session to calculate totals
    const resultsData = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationResult.list({
          filter: {
            sessionId: { eq: sessionId }
          }
        });
        return result.data || [];
      },
      operationName: 'ListOptimizationResults',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    // Calculate total iterations and execution time
    const totalIterations = resultsData.length;
    const totalExecutionTimeMs = resultsData.reduce(
      (sum, result) => sum + (result.totalExecutionTimeMs || 0),
      0
    );
    const totalComputeTimeSeconds = Math.floor(totalExecutionTimeMs / 1000);

    // Count model executions
    const physicsModelExecutions = resultsData.filter(
      (result) => result.physicsModelResult !== null
    ).length;
    const romModelExecutions = resultsData.filter(
      (result) => result.romModelResult !== null
    ).length;
    const cfdModelExecutions = resultsData.filter(
      (result) => result.cfdModelResult !== null
    ).length;

    // Calculate compute cost (simplified estimate)
    // In production, this would query actual AWS Cost Explorer data
    const COST_PER_COMPUTE_HOUR = 5.0; // Placeholder cost per hour
    const totalComputeCostUsd = (totalComputeTimeSeconds / 3600) * COST_PER_COMPUTE_HOUR;

    console.log('Final metrics:', {
      totalIterations,
      physicsModelExecutions,
      romModelExecutions,
      cfdModelExecutions,
      totalComputeTimeSeconds,
      totalComputeCostUsd,
    });

    // ========================================================================
    // Step 4: Update OptimizationSession status to STOPPED
    // ========================================================================
    console.log('Updating session status to STOPPED');
    
    const stoppedAt = new Date().toISOString();
    
    await withRetry({
      operation: async () => {
        await client.models.OptimizationSession.update({
          id: sessionId,
          status: 'STOPPED',
          stoppedAt,
          lastUpdateAt: stoppedAt,
          totalIterations,
          physicsModelExecutions,
          romModelExecutions,
          cfdModelExecutions,
          totalComputeTimeSeconds,
          totalComputeCostUsd,
        });
      },
      operationName: 'UpdateSessionToStopped',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    // Update WellOperation status (using generated GraphQL mutation for cross-schema enum)
    await withRetry({
      operation: async () => {
        const updateInput: UpdateWellOperationInput = {
          id: operationId,
          currentOptimizationStatus: OptimizationStatus.STOPPED,
          lastOptimizationUpdateAt: stoppedAt,
        };
        await client.graphql({
          query: updateWellOperation,
          variables: { input: updateInput },
        });
      },
      operationName: 'UpdateWellOperationStatus',
      component: COMPONENT_NAME,
      context: { operationId, sessionId },
    });

    console.log(`Optimization session ${sessionId} stopped successfully`);

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishOptimizationIterationTime(executionTime, { ...dimensions, OperationId: operationId });

    // ========================================================================
    // Step 5: Return success confirmation
    // ========================================================================
    return {
      success: true,
      sessionId,
      status: 'STOPPED',
      message: `Optimization session stopped. Cancelled ${successfulCancellations}/${simulationsResult.length} running simulations. Total iterations: ${totalIterations}, compute time: ${totalComputeTimeSeconds}s, cost: $${totalComputeCostUsd.toFixed(2)}`,
    };

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    // Try to mark session as FAILED if we can
    try {
      await client.models.OptimizationSession.update({
        id: sessionId,
        status: 'FAILED',
        stoppedAt: new Date().toISOString(),
      });
    } catch (updateError) {
      console.error('Failed to update session status to FAILED', updateError);
    }

    return {
      success: false,
      sessionId,
      status: 'FAILED',
      error: classifiedError.message,
    };
  }
};
