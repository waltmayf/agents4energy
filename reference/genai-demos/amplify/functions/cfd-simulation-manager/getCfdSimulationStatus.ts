/**
 * Get CFD Simulation Status Handler
 *
 * Retrieves the current status, progress, and metadata of a CFD simulation
 * from the CFDSimulation model in DynamoDB via the Amplify GraphQL client.
 *
 * Returns: simulation status, fracturing params, mesh config, compute resources,
 * timestamps, and optimization/risk metrics if the simulation has completed.
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/get-cfd-simulation-status';
import {
  withRetry,
  classifyError,
  logError,
  ErrorCategory,
  ErrorCode,
  ClassifiedError,
} from '../shared/utils/errorHandler';

const COMPONENT_NAME = 'GetCfdSimulationStatus';

export const handler: Schema['getCFDSimulationStatus']['functionHandler'] = async (event) => {
  console.log('Getting CFD simulation status', JSON.stringify(event, null, 2));

  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const { simulationId } = event.arguments;

  try {
    const result = await withRetry({
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

    return JSON.stringify({
      success: true,
      simulationId: result.id,
      name: result.name,
      status: result.status,
      simulationType: result.simulationType,
      description: result.description,

      // Cluster info
      clusterJobId: result.clusterJobId,
      clusterName: result.clusterName,
      queueName: result.queueName,

      // Configuration
      fracturingParams: result.fracturingParams,
      meshConfig: result.meshConfig,
      solverConfig: result.solverConfig,
      computeResources: result.computeResources,

      // Progress
      progress: result.progress,

      // Timestamps
      submittedAt: result.submittedAt,
      startedAt: result.startedAt,
      completedAt: result.completedAt,

      // Optimization metrics (populated after completion)
      proppantPlacementEfficiency: result.proppantPlacementEfficiency,
      fractureGeometryScore: result.fractureGeometryScore,
      placementUniformity: result.placementUniformity,
      nearWellboreConcentration: result.nearWellboreConcentration,

      // Risk metrics (populated after completion)
      screenOutRisk: result.screenOutRisk,
      concentrationRisk: result.concentrationRisk,
      velocityRisk: result.velocityRisk,
      pressureRisk: result.pressureRisk,
      confidence: result.confidence,

      // Error info
      errorMessage: result.errorMessage,
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
