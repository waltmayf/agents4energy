/**
 * Process Optimization Iteration Handler
 * 
 * Processes results from one iteration of all three models (physics, ROM, CFD):
 * 1. Collects results from all three models
 * 2. Weights results by model fidelity (physics: 0.2, ROM: 0.3, CFD: 0.5)
 * 3. Calculates aggregated optimization metrics
 * 4. Identifies optimization opportunities based on metric trends
 * 5. Stores OptimizationResult in DynamoDB
 * 6. Triggers recommendation generation if opportunities found
 * 7. Publishes update via GraphQL subscription
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { type DataClientEnv } from '@aws-amplify/backend-function/runtime';
import { env } from '$amplify/env/process-optimization-iteration';
import { withRetry, classifyError, logError, ErrorCategory, ErrorCode, ClassifiedError } from '../shared/utils/errorHandler';
import {
  publishOptimizationIterationTime,
  publishModelExecutionTime,
  publishErrorRate,
  publishRecommendationCount,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';
import {
  generateRecommendations as generateRecommendationsUtil,
  type OptimizationMetrics,
  type OperationParameters,
  type ModelResult as UtilModelResult,
  type TrendData,
  type Recommendation,
} from './utils/recommendationGenerator';
import {
  generateSensorDataPoint,
  type SensorDataPoint,
  type InitialParameters,
  type SensorDataConfig,
  DEFAULT_SENSOR_CONFIG,
} from './utils/sensorDataProvider';

// Constants
const COMPONENT_NAME = 'ProcessOptimizationIteration';

// Model fidelity weights
const MODEL_WEIGHTS = {
  PHYSICS: 0.2,  // High frequency, low fidelity
  ROM: 0.3,      // Medium frequency, medium fidelity
  CFD: 0.5,      // Low frequency, high fidelity
};

// Opportunity detection thresholds
const OPPORTUNITY_THRESHOLDS = {
  PROPPANT_PLACEMENT_IMPROVEMENT: 0.15,  // 15% improvement potential
  FRACTURE_GEOMETRY_IMPROVEMENT: 0.10,   // 10% improvement potential
  PLACEMENT_UNIFORMITY_IMPROVEMENT: 0.12, // 12% improvement potential
  HIGH_CONFIDENCE: 0.7,                   // Confidence threshold for recommendations
};

// Significant parameter change thresholds for triggering model re-execution
const PARAMETER_CHANGE_THRESHOLDS = {
  PRESSURE_CHANGE_PERCENT: 5,           // 5% pressure change
  INJECTION_RATE_CHANGE_PERCENT: 10,    // 10% injection rate change
  PROPPANT_CONCENTRATION_CHANGE_PERCENT: 15, // 15% proppant concentration change
  FLUID_VISCOSITY_CHANGE_PERCENT: 8,    // 8% fluid viscosity change
};

/**
 * Model result interface matching the schema
 */
interface ModelResult {
  modelType: 'PHYSICS' | 'ROM' | 'CFD';
  executionTimeMs: number;
  confidence: number;
  
  // Proppant metrics
  nearWellboreConcentration: number;
  placementEfficiency: number;
  
  // Fracture metrics
  fractureWidth: number;
  fractureLength: number;
  fractureHeight: number;
  
  // Risk metrics (secondary)
  screenOutRisk: number;
  timeToScreenOutSeconds?: number;
}

/**
 * Optimization opportunity interface
 */
interface OptimizationOpportunity {
  type: 'INCREASE_PROPPANT_PLACEMENT' | 'IMPROVE_FRACTURE_GEOMETRY' | 'OPTIMIZE_INJECTION_RATE' | 
        'ADJUST_PROPPANT_CONCENTRATION' | 'MODIFY_STAGE_PLAN' | 'EXTEND_PUMPING_TIME';
  description: string;
  confidence: number;
  expectedImprovement: number;
  recommendation: string;
}

/**
 * Input for processing an optimization iteration
 */
interface ProcessIterationInput {
  sessionId: string;
  operationId: string;
  iterationNumber: number;
  physicsModelResult?: ModelResult;
  romModelResult?: ModelResult;
  cfdModelResult?: ModelResult;
  currentParameters: {
    injectionRate: number;
    proppantConcentration: number;
    fluidViscosity: number;
    treatingPressure: number;
    fractureLengthM?: number;
    fractureWidthMm?: number;
  };
  sensorData?: Record<string, unknown>;
  sensorDataConfig?: SensorDataConfig;
}

/**
 * Handler for processing optimization iteration
 * 
 * Note: This is an internal handler called by the optimization engine,
 * not directly exposed as a GraphQL mutation. Therefore, it uses a custom
 * type definition instead of Schema['operationName']['functionHandler'].
 */
export const handler = async (event: { arguments: { input: ProcessIterationInput } }) => {
  console.log('Processing optimization iteration', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  // Note: env type will include AMPLIFY_DATA_DEFAULT_NAME after deployment regenerates types
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env as unknown as DataClientEnv);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { input } = event.arguments;
  const {
    sessionId,
    operationId,
    iterationNumber,
    physicsModelResult,
    romModelResult,
    cfdModelResult,
    currentParameters,
    sensorData,
  } = input;

  const dimensions: MetricDimensions = {
    FunctionName: 'processOptimizationIteration',
    SessionId: sessionId,
    OperationId: operationId,
  };

  try {
    // ========================================================================
    // Step 1: Validate session exists and is active
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

    // Check if session is active
    if (sessionResult.status !== 'ACTIVE') {
      return {
        success: false,
        error: `Optimization session ${sessionId} is not active (status: ${sessionResult.status})`,
      };
    }

    // ========================================================================
    // Step 1.5: Generate and update simulated sensor data
    // ========================================================================
    console.log('Generating simulated sensor data');
    
    // Get current operation to retrieve previous sensor data
    const operationResult = await withRetry({
      operation: async () => {
        const result = await client.models.WellOperation.get({ id: operationId });
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.INVALID_PARAMETERS,
            `Well operation ${operationId} not found`,
            { operationId }
          );
        }
        return result.data;
      },
      operationName: 'GetWellOperation',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    // Determine current simulation time
    const previousTimeElapsed = operationResult.simulationTimeElapsedSeconds || 0;
    const sensorConfig = input.sensorDataConfig || DEFAULT_SENSOR_CONFIG;
    const timeIncrement = 1 / sensorConfig.sensorUpdateFrequencyHz; // seconds per update
    const currentTimeElapsed = previousTimeElapsed + timeIncrement;

    // Prepare initial parameters for sensor data generation
    const initialParameters: InitialParameters = {
      injectionRate: currentParameters.injectionRate,
      proppantConcentration: currentParameters.proppantConcentration,
      fluidViscosity: currentParameters.fluidViscosity,
      treatingPressure: currentParameters.treatingPressure,
      fractureLengthM: currentParameters.fractureLengthM,
      fractureWidthMm: currentParameters.fractureWidthMm,
    };

    // Generate new sensor data point
    const newSensorData: SensorDataPoint = generateSensorDataPoint(
      initialParameters,
      currentTimeElapsed,
      sensorConfig
    );

    console.log('Generated sensor data:', {
      timeElapsed: currentTimeElapsed,
      pressure: newSensorData.pressure,
      injectionRate: newSensorData.injectionRate,
      proppantConcentration: newSensorData.proppantConcentration,
      phase: newSensorData.phase,
    });

    // Check for significant parameter changes that should trigger model re-execution
    const previousSensorData = operationResult.simulatedSensorData as SensorDataPoint | null;
    const significantChanges = detectSignificantParameterChanges(
      previousSensorData,
      newSensorData
    );

    if (significantChanges.length > 0) {
      console.log('Significant parameter changes detected:', significantChanges);
      // Note: Model re-execution is handled by the continuous optimization engine
      // This flag can be used to prioritize or expedite model runs
    }

    // Update WellOperation with new simulated sensor data
    await withRetry({
      operation: async () => {
        await client.models.WellOperation.update({
          id: operationId,
          simulatedSensorData: JSON.stringify(newSensorData),
          simulatedDataTimestamp: new Date().toISOString(),
          simulationTimeElapsedSeconds: currentTimeElapsed,
        });
      },
      operationName: 'UpdateWellOperationSensorData',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    // Store sensor data history as SensorReading for analysis
    await withRetry({
      operation: async () => {
        await client.models.SensorReading.create({
          operationId,
          treatingPressure: newSensorData.pressure,
          pumpRate: newSensorData.injectionRate * 377.4, // Convert m³/s to bbl/min
          proppantConcentration: newSensorData.proppantConcentration * 100, // Convert to ppg equivalent
          fluidViscosity: newSensorData.fluidViscosity * 1000, // Convert Pa·s to cP
          capturedAt: new Date().toISOString(),
          dataSource: 'simulated',
          // Calculate pressure derivative if previous data exists
          pressureDerivative: previousSensorData 
            ? (newSensorData.pressure - previousSensorData.pressure) / timeIncrement * 60 // psi/min
            : undefined,
        });
      },
      operationName: 'CreateSensorReading',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    console.log('Updated WellOperation with simulated sensor data and stored history');

    // Use the new sensor data in the iteration processing
    const sensorDataForIteration = {
      ...newSensorData,
      significantChanges,
    };

    // ========================================================================
    // Step 2: Collect and validate model results
    // ========================================================================
    console.log('Collecting model results');
    
    const availableModels: ModelResult[] = [];
    if (physicsModelResult) availableModels.push(physicsModelResult);
    if (romModelResult) availableModels.push(romModelResult);
    if (cfdModelResult) availableModels.push(cfdModelResult);

    if (availableModels.length === 0) {
      throw new ClassifiedError(
        ErrorCategory.PERMANENT,
        ErrorCode.INVALID_PARAMETERS,
        'No model results provided for iteration',
        { sessionId, iterationNumber }
      );
    }

    console.log(`Processing ${availableModels.length}/3 model results`);

    // ========================================================================
    // Step 3: Calculate aggregated optimization metrics with fidelity weighting
    // ========================================================================
    console.log('Calculating aggregated optimization metrics');
    
    let weightedProppantPlacement = 0;
    let weightedFractureGeometry = 0;
    let weightedPlacementUniformity = 0;
    let weightedScreenOutRisk = 0;
    let totalWeight = 0;

    for (const modelResult of availableModels) {
      const weight = MODEL_WEIGHTS[modelResult.modelType];
      
      // Weight proppant placement efficiency
      weightedProppantPlacement += modelResult.placementEfficiency * weight;
      
      // Calculate fracture geometry score (normalized combination of dimensions)
      const geometryScore = calculateFractureGeometryScore(
        modelResult.fractureWidth,
        modelResult.fractureLength,
        modelResult.fractureHeight
      );
      weightedFractureGeometry += geometryScore * weight;
      
      // Calculate placement uniformity (inverse of concentration variance)
      // For prototype, use near-wellbore concentration as proxy
      const uniformityScore = calculatePlacementUniformity(
        modelResult.nearWellboreConcentration,
        modelResult.placementEfficiency
      );
      weightedPlacementUniformity += uniformityScore * weight;
      
      // Weight screen-out risk (secondary metric)
      weightedScreenOutRisk += modelResult.screenOutRisk * weight;
      
      totalWeight += weight;
    }

    // Normalize by total weight (handles partial model availability)
    const proppantPlacementEfficiency = weightedProppantPlacement / totalWeight;
    const fractureGeometryScore = weightedFractureGeometry / totalWeight;
    const placementUniformity = weightedPlacementUniformity / totalWeight;
    const screenOutRisk = weightedScreenOutRisk / totalWeight;

    console.log('Aggregated metrics:', {
      proppantPlacementEfficiency,
      fractureGeometryScore,
      placementUniformity,
      screenOutRisk,
    });

    // ========================================================================
    // Step 4: Identify optimization opportunities based on metric trends
    // ========================================================================
    console.log('Identifying optimization opportunities');
    
    const opportunities = await identifyOptimizationOpportunities({
      proppantPlacementEfficiency,
      fractureGeometryScore,
      placementUniformity,
      screenOutRisk,
      currentParameters,
      availableModels,
      sessionId,
      iterationNumber,
      client,
    });

    console.log(`Identified ${opportunities.length} optimization opportunities`);

    // ========================================================================
    // Step 5: Calculate total execution time
    // ========================================================================
    const totalExecutionTimeMs = availableModels.reduce(
      (sum, model) => sum + model.executionTimeMs,
      0
    );

    // ========================================================================
    // Step 6: Store OptimizationResult in DynamoDB
    // ========================================================================
    console.log('Storing OptimizationResult in DynamoDB');
    
    const optimizationResult = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationResult.create({
          sessionId,
          operationId,
          timestamp: new Date().toISOString(),
          iterationNumber,
          
          // Model results (stored as JSON)
          physicsModelResult: physicsModelResult ? JSON.stringify(physicsModelResult) : undefined,
          romModelResult: romModelResult ? JSON.stringify(romModelResult) : undefined,
          cfdModelResult: cfdModelResult ? JSON.stringify(cfdModelResult) : undefined,
          
          // Aggregated metrics
          proppantPlacementEfficiency,
          fractureGeometryScore,
          placementUniformity,
          screenOutRisk,
          
          // Opportunities
          opportunities: JSON.stringify(opportunities),
          
          // Parameters and sensor data
          parameters: JSON.stringify(currentParameters),
          sensorData: JSON.stringify(sensorDataForIteration),
          
          // Performance
          totalExecutionTimeMs,
        });

        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.SYSTEM,
            ErrorCode.SERVICE_UNAVAILABLE,
            'Failed to create OptimizationResult',
            { sessionId, iterationNumber }
          );
        }

        return result.data;
      },
      operationName: 'CreateOptimizationResult',
      component: COMPONENT_NAME,
      context: { sessionId, iterationNumber },
    });

    console.log(`Created OptimizationResult ${optimizationResult.id}`);

    // ========================================================================
    // Step 7: Update OptimizationSession with latest result
    // ========================================================================
    await withRetry({
      operation: async () => {
        await client.models.OptimizationSession.update({
          id: sessionId,
          latestResultId: optimizationResult.id,
          currentParameters: JSON.stringify(currentParameters),
          lastUpdateAt: new Date().toISOString(),
          totalIterations: (sessionResult.totalIterations || 0) + 1,
          physicsModelExecutions: (sessionResult.physicsModelExecutions || 0) + (physicsModelResult ? 1 : 0),
          romModelExecutions: (sessionResult.romModelExecutions || 0) + (romModelResult ? 1 : 0),
          cfdModelExecutions: (sessionResult.cfdModelExecutions || 0) + (cfdModelResult ? 1 : 0),
          totalComputeTimeSeconds: (sessionResult.totalComputeTimeSeconds || 0) + Math.floor(totalExecutionTimeMs / 1000),
        });
      },
      operationName: 'UpdateOptimizationSession',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    // ========================================================================
    // Step 8: Update WellOperation with latest metrics
    // ========================================================================
    await withRetry({
      operation: async () => {
        await client.models.WellOperation.update({
          id: operationId,
          currentProppantPlacementEfficiency: proppantPlacementEfficiency,
          currentFractureGeometryScore: fractureGeometryScore,
          lastOptimizationUpdateAt: new Date().toISOString(),
          currentRiskScore: screenOutRisk,
          lastRiskAssessmentAt: new Date().toISOString(),
        });
      },
      operationName: 'UpdateWellOperation',
      component: COMPONENT_NAME,
      context: { operationId },
    });

    // ========================================================================
    // Step 9: Generate recommendations using recommendation generator utility
    // ========================================================================
    console.log('Generating recommendations using recommendation generator utility');
    
    // Prepare metrics for recommendation generator
    const metricsForGenerator: OptimizationMetrics = {
      proppantPlacementEfficiency,
      fractureGeometryScore,
      placementUniformity,
      screenOutRisk,
    };

    // Prepare parameters for recommendation generator
    const parametersForGenerator: OperationParameters = {
      injectionRate: currentParameters.injectionRate,
      proppantConcentration: currentParameters.proppantConcentration,
      fluidViscosity: currentParameters.fluidViscosity,
      treatingPressure: currentParameters.treatingPressure,
      fractureLengthM: currentParameters.fractureLengthM,
      fractureWidthMm: currentParameters.fractureWidthMm,
    };

    // Convert model results to utility format
    const modelResultsForGenerator: UtilModelResult[] = availableModels.map((model) => ({
      modelType: model.modelType,
      confidence: model.confidence,
      placementEfficiency: model.placementEfficiency,
      fractureWidth: model.fractureWidth,
      fractureLength: model.fractureLength,
      fractureHeight: model.fractureHeight,
    }));

    // Prepare trend data if previous iteration exists
    let trendDataForGenerator: TrendData | undefined;
    if (iterationNumber > 1) {
      try {
        const previousResults = await client.models.OptimizationResult.list({
          filter: {
            sessionId: { eq: sessionId },
            iterationNumber: { eq: iterationNumber - 1 },
          },
        });
        if (previousResults.data[0]) {
          trendDataForGenerator = {
            previousMetrics: {
              proppantPlacementEfficiency: previousResults.data[0].proppantPlacementEfficiency,
              fractureGeometryScore: previousResults.data[0].fractureGeometryScore,
              placementUniformity: previousResults.data[0].placementUniformity,
              screenOutRisk: previousResults.data[0].screenOutRisk,
            },
            iterationNumber,
          };
        }
      } catch (error) {
        console.warn('Failed to fetch previous result for trend analysis', error);
      }
    }

    // Generate recommendations using utility
    const recommendations = generateRecommendationsUtil(
      metricsForGenerator,
      parametersForGenerator,
      modelResultsForGenerator,
      trendDataForGenerator
    );

    console.log(`Generated ${recommendations.length} recommendations`);

    // Store recommendations in DynamoDB
    if (recommendations.length > 0) {
      await storeRecommendations({
        sessionId,
        operationId,
        resultId: optimizationResult.id,
        recommendations,
        client,
      });
    }

    // ========================================================================
    // Step 10: Publish update via GraphQL subscription
    // ========================================================================
    // Note: GraphQL subscriptions are automatically triggered by DynamoDB updates
    // The OptimizationResult creation above will trigger onOptimizationUpdate subscription

    console.log('Optimization iteration processed successfully');

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishOptimizationIterationTime(executionTime, dimensions);

    // Publish model execution times
    if (physicsModelResult) {
      await publishModelExecutionTime('Physics', physicsModelResult.executionTimeMs, dimensions);
    }
    if (romModelResult) {
      await publishModelExecutionTime('ROM', romModelResult.executionTimeMs, dimensions);
    }
    if (cfdModelResult) {
      await publishModelExecutionTime('CFD', cfdModelResult.executionTimeMs, dimensions);
    }

    // Publish recommendation count
    await publishRecommendationCount(recommendations.length, dimensions);

    // ========================================================================
    // Return success
    // ========================================================================
    return {
      success: true,
      resultId: optimizationResult.id,
      metrics: {
        proppantPlacementEfficiency,
        fractureGeometryScore,
        placementUniformity,
        screenOutRisk,
      },
      opportunitiesFound: opportunities.length,
      recommendationsGenerated: recommendations.length,
      sensorDataUpdated: true,
      simulationTimeElapsed: currentTimeElapsed,
      significantChanges: significantChanges.length > 0 ? significantChanges : undefined,
    };

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId, operationId, iterationNumber });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    return {
      success: false,
      error: classifiedError.message,
    };
  }
};

/**
 * Detect significant parameter changes between sensor data points
 * 
 * Compares current sensor data with previous data to identify changes
 * that exceed thresholds and should trigger model re-execution.
 * 
 * @param previousData - Previous sensor data point (or null if first iteration)
 * @param currentData - Current sensor data point
 * @returns Array of detected significant changes
 */
function detectSignificantParameterChanges(
  previousData: SensorDataPoint | null,
  currentData: SensorDataPoint
): string[] {
  if (!previousData) {
    return []; // No previous data to compare
  }

  const changes: string[] = [];

  // Check pressure change
  const pressureChangePercent = Math.abs(
    (currentData.pressure - previousData.pressure) / previousData.pressure * 100
  );
  if (pressureChangePercent >= PARAMETER_CHANGE_THRESHOLDS.PRESSURE_CHANGE_PERCENT) {
    changes.push(
      `Pressure changed by ${pressureChangePercent.toFixed(1)}% (${previousData.pressure.toFixed(0)} → ${currentData.pressure.toFixed(0)} psi)`
    );
  }

  // Check injection rate change
  const rateChangePercent = Math.abs(
    (currentData.injectionRate - previousData.injectionRate) / previousData.injectionRate * 100
  );
  if (rateChangePercent >= PARAMETER_CHANGE_THRESHOLDS.INJECTION_RATE_CHANGE_PERCENT) {
    changes.push(
      `Injection rate changed by ${rateChangePercent.toFixed(1)}% (${previousData.injectionRate.toFixed(3)} → ${currentData.injectionRate.toFixed(3)} m³/s)`
    );
  }

  // Check proppant concentration change
  const concentrationChangePercent = Math.abs(
    (currentData.proppantConcentration - previousData.proppantConcentration) / 
    (previousData.proppantConcentration || 0.01) * 100 // Avoid division by zero
  );
  if (concentrationChangePercent >= PARAMETER_CHANGE_THRESHOLDS.PROPPANT_CONCENTRATION_CHANGE_PERCENT) {
    changes.push(
      `Proppant concentration changed by ${concentrationChangePercent.toFixed(1)}% (${previousData.proppantConcentration.toFixed(3)} → ${currentData.proppantConcentration.toFixed(3)})`
    );
  }

  // Check fluid viscosity change
  const viscosityChangePercent = Math.abs(
    (currentData.fluidViscosity - previousData.fluidViscosity) / previousData.fluidViscosity * 100
  );
  if (viscosityChangePercent >= PARAMETER_CHANGE_THRESHOLDS.FLUID_VISCOSITY_CHANGE_PERCENT) {
    changes.push(
      `Fluid viscosity changed by ${viscosityChangePercent.toFixed(1)}% (${previousData.fluidViscosity.toFixed(3)} → ${currentData.fluidViscosity.toFixed(3)} Pa·s)`
    );
  }

  // Check for phase transitions (always significant)
  if (previousData.phase !== currentData.phase) {
    changes.push(
      `Operation phase changed from ${previousData.phase} to ${currentData.phase}`
    );
  }

  return changes;
}

/**
 * Calculate fracture geometry score from dimensions
 * 
 * Combines width, length, and height into a normalized score [0, 1]
 * Higher scores indicate better fracture geometry for production
 */
function calculateFractureGeometryScore(
  width: number,
  length: number,
  height: number
): number {
  // Target dimensions for optimal fracture (industry typical values)
  const targetWidth = 0.005;   // 5mm
  const targetLength = 100;    // 100m
  const targetHeight = 50;     // 50m

  // Calculate normalized scores for each dimension
  const widthScore = Math.min(width / targetWidth, 1.0);
  const lengthScore = Math.min(length / targetLength, 1.0);
  const heightScore = Math.min(height / targetHeight, 1.0);

  // Weighted combination (width is most important for conductivity)
  const geometryScore = (widthScore * 0.5) + (lengthScore * 0.3) + (heightScore * 0.2);

  return Math.max(0, Math.min(1, geometryScore));
}

/**
 * Calculate placement uniformity score
 * 
 * Measures how uniformly proppant is distributed
 * Higher scores indicate better placement uniformity
 */
function calculatePlacementUniformity(
  nearWellboreConcentration: number,
  placementEfficiency: number
): number {
  // For prototype, use ratio of near-wellbore concentration to placement efficiency
  // In production, this would analyze concentration distribution variance
  
  if (placementEfficiency === 0) return 0;
  
  const uniformityRatio = nearWellboreConcentration / placementEfficiency;
  
  // Ideal uniformity is when near-wellbore matches overall efficiency
  // Score decreases as ratio deviates from 1.0
  const uniformityScore = 1.0 - Math.abs(1.0 - uniformityRatio);
  
  return Math.max(0, Math.min(1, uniformityScore));
}

/**
 * Identify optimization opportunities based on current metrics
 */
async function identifyOptimizationOpportunities(params: {
  proppantPlacementEfficiency: number;
  fractureGeometryScore: number;
  placementUniformity: number;
  screenOutRisk: number;
  currentParameters: ProcessIterationInput['currentParameters'];
  availableModels: ModelResult[];
  sessionId: string;
  iterationNumber: number;
  client: ReturnType<typeof generateClient<Schema>>;
}): Promise<OptimizationOpportunity[]> {
  const {
    proppantPlacementEfficiency,
    fractureGeometryScore,
    placementUniformity,
    currentParameters,
    availableModels,
    sessionId,
    iterationNumber,
    client,
  } = params;

  const opportunities: OptimizationOpportunity[] = [];

  // Get previous iteration for trend analysis
  let previousResult: {
    proppantPlacementEfficiency: number;
    fractureGeometryScore: number;
    placementUniformity: number;
    screenOutRisk: number;
  } | null = null;
  
  if (iterationNumber > 1) {
    try {
      const previousResults = await client.models.OptimizationResult.list({
        filter: {
          sessionId: { eq: sessionId },
          iterationNumber: { eq: iterationNumber - 1 },
        },
      });
      if (previousResults.data[0]) {
        previousResult = {
          proppantPlacementEfficiency: previousResults.data[0].proppantPlacementEfficiency,
          fractureGeometryScore: previousResults.data[0].fractureGeometryScore,
          placementUniformity: previousResults.data[0].placementUniformity,
          screenOutRisk: previousResults.data[0].screenOutRisk,
        };
      }
    } catch (error) {
      console.warn('Failed to fetch previous result for trend analysis', error);
    }
  }

  // Calculate model agreement (confidence based on how many models agree)
  const modelAgreementConfidence = availableModels.length / 3;

  // Opportunity 1: Increase proppant placement
  if (proppantPlacementEfficiency < 0.85) {
    const improvementPotential = 0.85 - proppantPlacementEfficiency;
    
    if (improvementPotential >= OPPORTUNITY_THRESHOLDS.PROPPANT_PLACEMENT_IMPROVEMENT) {
      opportunities.push({
        type: 'INCREASE_PROPPANT_PLACEMENT',
        description: `Proppant placement efficiency is ${(proppantPlacementEfficiency * 100).toFixed(1)}%, below optimal 85%`,
        confidence: modelAgreementConfidence,
        expectedImprovement: improvementPotential * 100,
        recommendation: `Increase injection rate by ${(improvementPotential * 20).toFixed(1)}% to improve near-wellbore sand placement`,
      });
    }
  }

  // Opportunity 2: Improve fracture geometry
  if (fractureGeometryScore < 0.80) {
    const improvementPotential = 0.80 - fractureGeometryScore;
    
    if (improvementPotential >= OPPORTUNITY_THRESHOLDS.FRACTURE_GEOMETRY_IMPROVEMENT) {
      opportunities.push({
        type: 'IMPROVE_FRACTURE_GEOMETRY',
        description: `Fracture geometry score is ${(fractureGeometryScore * 100).toFixed(1)}%, below optimal 80%`,
        confidence: modelAgreementConfidence * 0.9, // Slightly lower confidence for geometry
        expectedImprovement: improvementPotential * 100,
        recommendation: `Adjust fluid viscosity to ${(currentParameters.fluidViscosity * 1.1).toFixed(3)} Pa·s to improve fracture width`,
      });
    }
  }

  // Opportunity 3: Optimize injection rate based on trend
  if (previousResult) {
    const previousEfficiency = previousResult.proppantPlacementEfficiency;
    const efficiencyTrend = proppantPlacementEfficiency - previousEfficiency;
    
    if (efficiencyTrend < -0.05) {
      // Efficiency is declining
      opportunities.push({
        type: 'OPTIMIZE_INJECTION_RATE',
        description: `Proppant placement efficiency declining by ${(Math.abs(efficiencyTrend) * 100).toFixed(1)}% per iteration`,
        confidence: modelAgreementConfidence * 0.85,
        expectedImprovement: Math.abs(efficiencyTrend) * 100,
        recommendation: `Reduce injection rate by 8% to ${(currentParameters.injectionRate * 0.92).toFixed(3)} m³/s to stabilize placement`,
      });
    }
  }

  // Opportunity 4: Adjust proppant concentration for uniformity
  if (placementUniformity < 0.75) {
    const improvementPotential = 0.75 - placementUniformity;
    
    if (improvementPotential >= OPPORTUNITY_THRESHOLDS.PLACEMENT_UNIFORMITY_IMPROVEMENT) {
      opportunities.push({
        type: 'ADJUST_PROPPANT_CONCENTRATION',
        description: `Placement uniformity is ${(placementUniformity * 100).toFixed(1)}%, indicating uneven distribution`,
        confidence: modelAgreementConfidence * 0.8,
        expectedImprovement: improvementPotential * 100,
        recommendation: `Increase proppant concentration gradually to ${(currentParameters.proppantConcentration * 1.1).toFixed(3)} to improve uniformity`,
      });
    }
  }

  // Opportunity 5: Extend pumping time if all metrics are good
  if (
    proppantPlacementEfficiency > 0.85 &&
    fractureGeometryScore > 0.80 &&
    placementUniformity > 0.75
  ) {
    opportunities.push({
      type: 'EXTEND_PUMPING_TIME',
      description: 'All optimization metrics are above target, favorable conditions for extended pumping',
      confidence: modelAgreementConfidence,
      expectedImprovement: 15, // Estimated production increase
      recommendation: 'Extend stage duration by 15 minutes to maximize fracture development under optimal conditions',
    });
  }

  return opportunities;
}

/**
 * Store optimization recommendations in DynamoDB
 * 
 * Requirements: 10.1, 10.5
 * 
 * Creates OptimizationRecommendation records with:
 * - Parameter adjustments
 * - Expected improvements
 * - Supporting models
 * - Status set to PENDING
 * 
 * GraphQL subscriptions are automatically triggered by DynamoDB updates
 */
async function storeRecommendations(params: {
  sessionId: string;
  operationId: string;
  resultId: string;
  recommendations: Recommendation[];
  client: ReturnType<typeof generateClient<Schema>>;
}): Promise<void> {
  const { sessionId, operationId, resultId, recommendations, client } = params;

  for (const recommendation of recommendations) {
    try {
      await withRetry({
        operation: async () => {
          const result = await client.models.OptimizationRecommendation.create({
            sessionId,
            operationId,
            resultId,
            timestamp: new Date().toISOString(),
            type: recommendation.type,
            priority: recommendation.priority,
            title: recommendation.title,
            description: recommendation.description,
            reasoning: recommendation.reasoning,
            parameterAdjustments: JSON.stringify(recommendation.parameterAdjustments),
            expectedImprovements: JSON.stringify(recommendation.expectedImprovements),
            supportingModels: JSON.stringify(recommendation.supportingModels),
            confidence: recommendation.confidence,
            status: 'PENDING',
          });

          if (!result.data) {
            throw new ClassifiedError(
              ErrorCategory.SYSTEM,
              ErrorCode.SERVICE_UNAVAILABLE,
              'Failed to create OptimizationRecommendation',
              { sessionId, recommendationType: recommendation.type }
            );
          }

          console.log(`Created recommendation ${result.data.id}: ${recommendation.title}`);
        },
        operationName: 'CreateOptimizationRecommendation',
        component: COMPONENT_NAME,
        context: { sessionId, recommendationType: recommendation.type },
      });
    } catch (error) {
      // Log error but continue with other recommendations
      const classifiedError = classifyError(error, { sessionId, recommendationType: recommendation.type });
      logError(classifiedError, COMPONENT_NAME);
      console.error(`Failed to store recommendation: ${recommendation.title}`, error);
    }
  }
}
