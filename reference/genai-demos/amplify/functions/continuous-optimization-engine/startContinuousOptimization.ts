/**
 * Start Continuous Optimization Handler
 * 
 * Initializes continuous optimization for a fracturing operation by:
 * 1. Validating the operation exists and is active
 * 2. Creating an OptimizationSession record in DynamoDB
 * 3. Initializing simulated sensor data generator
 * 4. Ensuring PCS cluster compute nodes are available
 * 5. Submitting initial parallel job streams for all three models
 * 6. Updating session status to ACTIVE
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 9.2
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/start-continuous-optimization';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { 
  withRetry, 
  classifyError, 
  logError, 
  ErrorCategory, 
  ErrorCode, 
  ClassifiedError 
} from '../shared/utils/errorHandler';
import { OptimizationStatus, ClusterStatus } from '../../graphql/API';
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
const COMPONENT_NAME = 'StartContinuousOptimization';
const CLUSTER_NAME = process.env.CLUSTER_NAME || '';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';

// PCS Slurm binary paths (PCS installs Slurm at a non-standard location)
const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
const SINFO_PATH = '/opt/aws/pcs/scheduler/slurm-25.05/bin/sinfo';

// Fast retry config for cluster checks — command failures are immediate (not transient network issues)
const CLUSTER_CHECK_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
};

/**
 * Handler for startContinuousOptimization mutation
 */
export const handler: Schema['startContinuousOptimization']['functionHandler'] = async (event) => {
  console.log('Starting continuous optimization', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { input } = event.arguments;
  const {
    operationId,
    wellName,
    initialParameters,
    optimizationGoals,
    simulationConfig,
  } = input;

  const dimensions: MetricDimensions = {
    FunctionName: 'startContinuousOptimization',
    OperationId: operationId,
  };

  try {
    // ========================================================================
    // Step 1: Validate operation exists and is active
    // ========================================================================
    console.log(`Validating operation ${operationId}`);
    
    const operationResult = await withRetry({
      operation: async () => {
        const result = await client.models.WellOperation.get({ id: operationId });
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.INVALID_PARAMETERS,
            `Operation ${operationId} not found`,
            { operationId }
          );
        }
        return result.data;
      },
      operationName: 'GetWellOperation',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    // Check if operation is active or planned
    if (operationResult.status !== 'active' && operationResult.status !== 'planned') {
      return {
        success: false,
        error: `Operation ${operationId} is not active (status: ${operationResult.status})`,
        status: 'FAILED',
      };
    }

    // Check if optimization is already running
    if (operationResult.optimizationSessionId) {
      return {
        success: false,
        error: `Operation ${operationId} already has an active optimization session`,
        status: 'FAILED',
      };
    }

    // ========================================================================
    // Step 2: Create OptimizationSession record with status INITIALIZING
    // ========================================================================
    console.log('Creating OptimizationSession record');
    
    const sessionResult = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationSession.create({
          operationId,
          status: 'INITIALIZING',
          initialParameters: JSON.stringify(initialParameters),
          optimizationGoals: JSON.stringify(optimizationGoals),
          simulationConfig: simulationConfig ? JSON.stringify(simulationConfig) : undefined,
          currentParameters: JSON.stringify(initialParameters),
          startedAt: new Date().toISOString(),
          lastUpdateAt: new Date().toISOString(),
          totalIterations: 0,
          physicsModelExecutions: 0,
          romModelExecutions: 0,
          cfdModelExecutions: 0,
          totalComputeTimeSeconds: 0,
          totalComputeCostUsd: 0,
        });
        
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.SYSTEM,
            ErrorCode.SERVICE_UNAVAILABLE,
            'Failed to create OptimizationSession',
            { operationId }
          );
        }
        
        return result.data;
      },
      operationName: 'CreateOptimizationSession',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    const sessionId = sessionResult.id;
    console.log(`Created OptimizationSession ${sessionId}`);

    // ========================================================================
    // Step 3: Initialize simulated sensor data generator
    // ========================================================================
    console.log('Initializing simulated sensor data');
    
    const sensorConfig = simulationConfig || {
      operationDurationHours: 4,
      sensorUpdateFrequencyHz: 1,
      enableRealisticNoise: true,
    };

    // Generate initial simulated sensor data
    const initialSensorData = {
      timestamp: new Date().toISOString(),
      pressure: initialParameters.treatingPressure,
      injectionRate: initialParameters.injectionRate,
      proppantConcentration: initialParameters.proppantConcentration,
      fluidViscosity: initialParameters.fluidViscosity,
      simulationTimeElapsed: 0,
      config: sensorConfig,
    };

    // Update WellOperation with initial sensor data (using generated GraphQL mutation
    // for cross-schema enum compatibility with OptimizationStatus)
    await withRetry({
      operation: async () => {
        const updateInput: UpdateWellOperationInput = {
          id: operationId,
          optimizationSessionId: sessionId,
          currentOptimizationStatus: OptimizationStatus.INITIALIZING,
          simulatedSensorData: JSON.stringify(initialSensorData),
          simulatedDataTimestamp: new Date().toISOString(),
          simulationTimeElapsedSeconds: 0,
        };
        await client.graphql({
          query: updateWellOperation,
          variables: { input: updateInput },
        });
      },
      operationName: 'UpdateWellOperationWithSensorData',
      component: COMPONENT_NAME,
      context: { operationId, sessionId },
    });

    console.log('Initialized simulated sensor data');

    // ========================================================================
    // Step 4: Ensure PCS cluster compute nodes are available
    // ========================================================================
    console.log('Checking PCS cluster status');
    
    try {
      // Find login node by tag
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
        context: { headNodeTag: HEAD_NODE_TAG },
      });

      console.log(`Found login node: ${loginNodeId}`);

      // Check cluster status via Slurm (using full PCS binary path)
      const clusterStatus = await withRetry({
        operation: async () => {
          const commandResult = await ssmClient.send(
            new SendCommandCommand({
              InstanceIds: [loginNodeId],
              DocumentName: 'AWS-RunShellScript',
              Parameters: {
                commands: [`export SLURM_CONF=${SLURM_CONF} && ${SINFO_PATH} -h -o "%P %a %l %D %T"`],
              },
            })
          );

          const commandId = commandResult.Command?.CommandId;
          if (!commandId) {
            throw new ClassifiedError(
              ErrorCategory.TRANSIENT,
              ErrorCode.SSM_THROTTLING,
              'Failed to get SSM command ID',
              { loginNodeId }
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
              `Slurm command failed: ${invocationResult.StandardErrorContent}`,
              { loginNodeId, commandId }
            );
          }

          return invocationResult.StandardOutputContent || '';
        },
        operationName: 'CheckClusterStatus',
        component: COMPONENT_NAME,
        context: { loginNodeId },
        config: CLUSTER_CHECK_RETRY_CONFIG,
      });

      console.log('Cluster status:', clusterStatus);

      // Update WellOperation with cluster status
      await client.graphql({
        query: updateWellOperation,
        variables: {
          input: {
            id: operationId,
            clusterStatus: ClusterStatus.running,
            clusterStartedAt: new Date().toISOString(),
          } satisfies UpdateWellOperationInput,
        },
      });

    } catch (error) {
      const classifiedError = classifyError(error, { operationId, sessionId });
      logError(classifiedError, COMPONENT_NAME);

      // Update session to FAILED
      await client.models.OptimizationSession.update({
        id: sessionId,
        status: 'FAILED',
        stoppedAt: new Date().toISOString(),
      });

      return {
        success: false,
        sessionId,
        status: 'FAILED',
        error: `Cluster unavailable: ${classifiedError.message}`,
      };
    }

    // ========================================================================
    // Step 5: Submit initial parallel job streams for all three models
    // ========================================================================
    console.log('Submitting parallel job streams');
    
    // Note: In a full implementation, this would submit actual Slurm jobs
    // For the prototype, we'll create placeholder simulation records
    // that will be processed by the processOptimizationIteration handler

    const jobSubmissionResults = await Promise.allSettled([
      // Physics model job (continuous, <1s per iteration)
      client.models.CFDSimulation.create({
        name: `Physics Model - ${wellName}`,
        description: 'Simplified physics model for instant feedback',
        simulationType: 'optimization',
        status: 'running',
        optimizationSessionId: sessionId,
        wellName,
        meshConfig: {
          cellsX: 10,
          cellsY: 10,
          cellsZ: 10,
          refinementLevel: 0,
          domainSizeX: 100,
          domainSizeY: 100,
          domainSizeZ: 100,
        },
        solverConfig: {
          solver: 'simpleFoam',
          timeStep: 0.1,
          endTime: 1.0,
          writeInterval: 0.5,
        },
        computeResources: {
          nodeCount: 1,
          coresPerNode: 4,
          instanceType: 'c5.xlarge',
        },
        clusterName: CLUSTER_NAME,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      }),

      // ROM model job (continuous, <30s per iteration)
      client.models.CFDSimulation.create({
        name: `ROM Model - ${wellName}`,
        description: 'ML surrogate/ROM for refined predictions',
        simulationType: 'optimization',
        status: 'running',
        optimizationSessionId: sessionId,
        wellName,
        meshConfig: {
          cellsX: 20,
          cellsY: 20,
          cellsZ: 20,
          refinementLevel: 1,
          domainSizeX: 100,
          domainSizeY: 100,
          domainSizeZ: 100,
        },
        solverConfig: {
          solver: 'pimpleFoam',
          timeStep: 0.05,
          endTime: 10.0,
          writeInterval: 1.0,
        },
        computeResources: {
          nodeCount: 2,
          coresPerNode: 8,
          instanceType: 'c5.2xlarge',
        },
        clusterName: CLUSTER_NAME,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      }),

      // CFD model job (continuous, minutes per iteration)
      client.models.CFDSimulation.create({
        name: `CFD Model - ${wellName}`,
        description: 'Full CFD simulation for high-fidelity validation',
        simulationType: 'optimization',
        status: 'running',
        optimizationSessionId: sessionId,
        wellName,
        meshConfig: {
          cellsX: 50,
          cellsY: 50,
          cellsZ: 50,
          refinementLevel: 2,
          domainSizeX: 100,
          domainSizeY: 100,
          domainSizeZ: 100,
        },
        solverConfig: {
          solver: 'pimpleFoam',
          timeStep: 0.01,
          endTime: 60.0,
          writeInterval: 5.0,
        },
        computeResources: {
          nodeCount: 4,
          coresPerNode: 16,
          instanceType: 'c5.4xlarge',
        },
        clusterName: CLUSTER_NAME,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      }),
    ]);

    // Check if any job submissions failed
    const failedJobs = jobSubmissionResults.filter((result) => result.status === 'rejected');
    if (failedJobs.length > 0) {
      console.warn(`${failedJobs.length} job submissions failed`, failedJobs);
      
      // Log but continue - partial failure is acceptable
      failedJobs.forEach((result, index) => {
        if (result.status === 'rejected') {
          const error = classifyError(result.reason, { operationId, sessionId, modelIndex: index });
          logError(error, COMPONENT_NAME);
        }
      });
    }

    const successfulJobs = jobSubmissionResults.filter((result) => result.status === 'fulfilled');
    console.log(`Successfully submitted ${successfulJobs.length}/3 model job streams`);

    // ========================================================================
    // Step 6: Update session status to ACTIVE
    // ========================================================================
    console.log('Updating session status to ACTIVE');
    
    await withRetry({
      operation: async () => {
        await client.models.OptimizationSession.update({
          id: sessionId,
          status: 'ACTIVE',
          lastUpdateAt: new Date().toISOString(),
        });
      },
      operationName: 'UpdateSessionToActive',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    // Update WellOperation status (using generated GraphQL mutation for cross-schema enum)
    await client.graphql({
      query: updateWellOperation,
      variables: {
        input: {
          id: operationId,
          currentOptimizationStatus: OptimizationStatus.ACTIVE,
          lastOptimizationUpdateAt: new Date().toISOString(),
        } satisfies UpdateWellOperationInput,
      },
    });

    console.log(`Optimization session ${sessionId} is now ACTIVE`);

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishOptimizationIterationTime(executionTime, { ...dimensions, SessionId: sessionId });

    // ========================================================================
    // Return success
    // ========================================================================
    return {
      success: true,
      sessionId,
      status: 'ACTIVE',
      message: `Continuous optimization started for operation ${operationId}. ${successfulJobs.length}/3 models running.`,
    };

  } catch (error) {
    const classifiedError = classifyError(error, { operationId });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    return {
      success: false,
      status: 'FAILED',
      error: classifiedError.message,
    };
  }
};
