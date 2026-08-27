import { defineFunction } from '@aws-amplify/backend';

/**
 * Continuous Optimization Engine Lambda Functions
 * 
 * These functions orchestrate continuous parallel execution of multi-fidelity models
 * (physics, ROM, CFD) for real-time optimization of hydraulic fracturing operations.
 * 
 * This is a prototype implementation using simulated sensor data to validate the
 * architecture before integrating real sensor pipelines.
 */

/**
 * Start continuous optimization for a fracturing operation
 * 
 * Initializes an optimization session, sets up simulated sensor data generation,
 * and submits parallel job streams for all three model types.
 */
export const startContinuousOptimization = defineFunction({
  name: 'start-continuous-optimization',
  entry: './startContinuousOptimization.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});

/**
 * Stop continuous optimization for a fracturing operation
 * 
 * Cancels all running Slurm jobs, updates session status, and calculates
 * final performance metrics.
 */
export const stopContinuousOptimization = defineFunction({
  name: 'stop-continuous-optimization',
  entry: './stopContinuousOptimization.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});

/**
 * Process results from one optimization iteration
 * 
 * Collects results from all three models, weights by fidelity, calculates
 * aggregated metrics, identifies optimization opportunities, and generates
 * recommendations.
 */
export const processOptimizationIteration = defineFunction({
  name: 'process-optimization-iteration',
  entry: './processOptimizationIteration.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});

/**
 * Get latest optimization recommendations for a session
 * 
 * Queries and returns recommendations sorted by priority and timestamp.
 */
export const getOptimizationRecommendations = defineFunction({
  name: 'get-optimization-recommendations',
  entry: './getOptimizationRecommendations.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});

/**
 * Generate simulated sensor data for prototype testing
 * 
 * Generates realistic pressure, injection rate, and proppant concentration
 * data with configurable noise and variations to simulate real sensor behavior.
 * This is a prototype feature to validate the architecture before integrating
 * real sensor pipelines.
 */
export const generateSimulatedSensorData = defineFunction({
  name: 'generate-simulated-sensor-data',
  entry: './generateSimulatedSensorData.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});
