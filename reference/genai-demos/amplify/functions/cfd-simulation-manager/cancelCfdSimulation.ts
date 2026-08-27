/**
 * Cancel CFD Simulation Handler
 *
 * Cancels a running or pending CFD simulation by:
 * 1. Querying DynamoDB for the CFDSimulation record to get clusterJobId
 * 2. Validating the simulation is in a cancellable state
 * 3. Sending scancel command to Slurm via SSM
 * 4. Updating CFDSimulation status to cancelled in DynamoDB
 * 5. Returning success/failure with descriptive message
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/cancel-cfd-simulation';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { SimulationStatus } from '../../graphql/API';
import type { UpdateCFDSimulationInput } from '../../graphql/API';
import { updateCFDSimulation } from '../../graphql/mutations';
import {
  withRetry,
  classifyError,
  logError,
  ErrorCategory,
  ErrorCode,
  ClassifiedError,
} from '../shared/utils/errorHandler';

// AWS SDK clients
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'CancelCfdSimulation';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';

// PCS Slurm binary paths
const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
const PCS_BIN = '/opt/aws/pcs/scheduler/slurm-25.05/bin';
const SLURM_ENV = `export SLURM_CONF=${SLURM_CONF}`;

/**
 * Find login node instance ID by EC2 tag
 */
async function findLoginNode(): Promise<string> {
  return withRetry({
    operation: async () => {
      const describeResult = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:Name', Values: [HEAD_NODE_TAG] },
            { Name: 'instance-state-name', Values: ['running'] },
          ],
        }),
      );

      const instances = describeResult.Reservations?.flatMap((r) => r.Instances || []) || [];
      if (instances.length === 0) {
        throw new ClassifiedError(
          ErrorCategory.SYSTEM,
          ErrorCode.CLUSTER_UNAVAILABLE,
          `Login node not found with tag ${HEAD_NODE_TAG}`,
          { headNodeTag: HEAD_NODE_TAG },
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
 */
async function cancelSlurmJob(loginNodeId: string, slurmJobId: string): Promise<void> {
  return withRetry({
    operation: async () => {
      const cancelCommand = `${SLURM_ENV} && ${PCS_BIN}/scancel ${slurmJobId}`;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: { commands: [cancelCommand] },
        }),
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          'Failed to get SSM command ID',
          { loginNodeId, slurmJobId },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        }),
      );

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Slurm scancel failed: ${invocationResult.StandardErrorContent}`,
          { loginNodeId, commandId, slurmJobId, stderr: invocationResult.StandardErrorContent },
        );
      }

      console.log(`scancel sent for job ${slurmJobId}`);
    },
    operationName: 'CancelSlurmJob',
    component: COMPONENT_NAME,
    context: { loginNodeId, slurmJobId },
  });
}

export const handler: Schema['cancelCFDSimulation']['functionHandler'] = async (event) => {
  console.log('Cancelling CFD simulation', JSON.stringify(event, null, 2));

  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const { simulationId } = event.arguments;

  try {
    // Step 1: Retrieve CFDSimulation record
    const simulation = await withRetry({
      operation: async () => {
        const res = await client.models.CFDSimulation.get({ id: simulationId });
        if (!res.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.MALFORMED_INPUT,
            `CFD simulation not found: ${simulationId}`,
            { simulationId },
          );
        }
        return res.data;
      },
      operationName: 'GetCFDSimulation',
      component: COMPONENT_NAME,
      context: { simulationId },
    });

    const slurmJobId = simulation.clusterJobId;
    const currentStatus = simulation.status;

    // Step 2: Validate cancellable state
    if (currentStatus !== 'running' && currentStatus !== 'queued' && currentStatus !== 'initializing') {
      return JSON.stringify({
        success: false,
        simulationId,
        status: currentStatus,
        error: `Cannot cancel simulation in state: ${currentStatus}`,
      });
    }

    // Step 3: Send scancel if we have a Slurm job ID
    if (slurmJobId) {
      const loginNodeId = await findLoginNode();
      await cancelSlurmJob(loginNodeId, slurmJobId);
    }

    // Step 4: Update DynamoDB status to cancelled
    const input: UpdateCFDSimulationInput = {
      id: simulationId,
      status: SimulationStatus.cancelled,
      completedAt: new Date().toISOString(),
    };

    await client.graphql({
      query: updateCFDSimulation,
      variables: { input },
    });

    return JSON.stringify({
      success: true,
      simulationId,
      status: 'cancelled',
      message: `Simulation ${simulationId} cancelled successfully`,
    });
  } catch (error) {
    const classifiedError = classifyError(error, { simulationId });
    logError(classifiedError, COMPONENT_NAME);

    return JSON.stringify({
      success: false,
      simulationId,
      error: classifiedError.message,
    });
  }
};
