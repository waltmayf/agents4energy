/**
 * Generate Simulated Sensor Data Handler
 * 
 * Generates realistic simulated sensor data for prototype validation:
 * 1. Generates realistic pressure data based on fracture propagation model
 * 2. Generates injection rate following typical pumping schedule (ramp-up, steady-state)
 * 3. Generates proppant concentration following standard proppant schedule
 * 4. Adds realistic noise and variations to simulate real sensor behavior
 * 5. Simulates time progression (configurable operation duration, default 4 hours)
 * 6. Stores simulated sensor data in WellOperation record
 * 7. Supports configurable parameters: operationDurationHours, sensorUpdateFrequencyHz, enableRealisticNoise
 * 
 * Requirements: 2.4 (adapted for simulated data)
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { type DataClientEnv } from '@aws-amplify/backend-function/runtime';
import { env } from '$amplify/env/generate-simulated-sensor-data';
import { withRetry, classifyError, logError, ErrorCategory, ErrorCode, ClassifiedError } from '../shared/utils/errorHandler';
import { 
  publishOptimizationIterationTime, 
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// Constants
const COMPONENT_NAME = 'GenerateSimulatedSensorData';

// Default configuration
const DEFAULT_CONFIG = {
  operationDurationHours: 4,
  sensorUpdateFrequencyHz: 1,
  enableRealisticNoise: true,
};

// Pumping schedule phases (typical fracturing operation)
const PUMPING_PHASES = {
  RAMP_UP: 0.15,      // 15% of operation time
  STEADY_STATE: 0.70, // 70% of operation time
  RAMP_DOWN: 0.15,    // 15% of operation time
};

// Proppant schedule phases
const PROPPANT_PHASES = {
  LOW_CONCENTRATION: 0.20,  // 20% of operation time
  MEDIUM_CONCENTRATION: 0.50, // 50% of operation time
  HIGH_CONCENTRATION: 0.30,  // 30% of operation time
};

// Realistic parameter ranges
const PARAMETER_RANGES = {
  pressure: {
    min: 5000,  // psi
    max: 12000, // psi
    noise: 100, // psi variation
  },
  injectionRate: {
    min: 0.1,   // m³/s
    max: 0.5,   // m³/s
    noise: 0.02, // m³/s variation
  },
  proppantConcentration: {
    min: 0.05,  // volume fraction
    max: 0.4,   // volume fraction
    noise: 0.01, // volume fraction variation
  },
  fluidViscosity: {
    min: 0.01,  // Pa·s
    max: 0.1,   // Pa·s
    noise: 0.005, // Pa·s variation
  },
};

/**
 * Input for generating simulated sensor data
 */
interface GenerateSensorDataInput {
  operationId: string;
  sessionId: string;
  initialParameters: {
    injectionRate: number;
    proppantConcentration: number;
    fluidViscosity: number;
    treatingPressure: number;
    fractureLengthM?: number;
    fractureWidthMm?: number;
  };
  config?: {
    operationDurationHours?: number;
    sensorUpdateFrequencyHz?: number;
    enableRealisticNoise?: boolean;
  };
  currentTimeElapsedSeconds?: number; // For continuing simulation
}

/**
 * Simulated sensor data point
 */
interface SensorDataPoint {
  timestamp: string;
  timeElapsedSeconds: number;
  pressure: number;              // psi
  injectionRate: number;         // m³/s
  proppantConcentration: number; // volume fraction
  fluidViscosity: number;        // Pa·s
  fractureWidth: number;         // mm (estimated)
  fractureLength: number;        // m (estimated)
  phase: string;                 // Current operation phase
}

/**
 * Handler for generating simulated sensor data
 * 
 * Note: This is an internal handler called by the optimization engine,
 * not directly exposed as a GraphQL mutation. Therefore, it uses a custom
 * type definition instead of Schema['operationName']['functionHandler'].
 */
export const handler = async (event: { arguments: { input: GenerateSensorDataInput } }) => {
  console.log('Generating simulated sensor data', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  // Note: env type will include AMPLIFY_DATA_DEFAULT_NAME after deployment regenerates types
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env as unknown as DataClientEnv);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { input } = event.arguments;
  const {
    operationId,
    sessionId,
    initialParameters,
    config = {},
    currentTimeElapsedSeconds = 0,
  } = input;

  const dimensions: MetricDimensions = {
    FunctionName: 'generateSimulatedSensorData',
    SessionId: sessionId,
    OperationId: operationId,
  };

  // Merge with default config
  const sensorConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  try {
    // ========================================================================
    // Step 1: Validate operation and session exist
    // ========================================================================
    console.log(`Validating operation ${operationId} and session ${sessionId}`);
    
    const [_operationResult, sessionResult] = await Promise.all([
      withRetry({
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
      }),
      withRetry({
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
      }),
    ]);

    // Check if session is active
    if (sessionResult.status !== 'ACTIVE') {
      return {
        success: false,
        error: `Optimization session ${sessionId} is not active (status: ${sessionResult.status})`,
      };
    }

    // ========================================================================
    // Step 2: Calculate operation progress
    // ========================================================================
    const operationDurationSeconds = sensorConfig.operationDurationHours * 3600;
    const progressFraction = currentTimeElapsedSeconds / operationDurationSeconds;
    
    console.log(`Operation progress: ${(progressFraction * 100).toFixed(1)}% (${currentTimeElapsedSeconds}s / ${operationDurationSeconds}s)`);

    // ========================================================================
    // Step 3: Generate pressure data based on fracture propagation model
    // ========================================================================
    const pressure = generatePressureData(
      initialParameters.treatingPressure,
      progressFraction,
      sensorConfig.enableRealisticNoise
    );

    // ========================================================================
    // Step 4: Generate injection rate following pumping schedule
    // ========================================================================
    const injectionRate = generateInjectionRateData(
      initialParameters.injectionRate,
      progressFraction,
      sensorConfig.enableRealisticNoise
    );

    // ========================================================================
    // Step 5: Generate proppant concentration following proppant schedule
    // ========================================================================
    const proppantConcentration = generateProppantConcentrationData(
      initialParameters.proppantConcentration,
      progressFraction,
      sensorConfig.enableRealisticNoise
    );

    // ========================================================================
    // Step 6: Generate fluid viscosity with minor variations
    // ========================================================================
    const fluidViscosity = generateFluidViscosityData(
      initialParameters.fluidViscosity,
      progressFraction,
      sensorConfig.enableRealisticNoise
    );

    // ========================================================================
    // Step 7: Estimate fracture dimensions based on pumped volume
    // ========================================================================
    const pumpedVolume = injectionRate * currentTimeElapsedSeconds; // m³
    const _fractureWidth = estimateFractureWidth(
      initialParameters.fractureWidthMm || 5.0,
      pressure,
      initialParameters.treatingPressure
    );
    const fractureLength = estimateFractureLength(
      initialParameters.fractureLengthM || 100,
      pumpedVolume,
      _fractureWidth
    );

    // ========================================================================
    // Step 8: Determine current operation phase
    // ========================================================================
    const phase = determineOperationPhase(progressFraction);

    // ========================================================================
    // Step 9: Create sensor data point
    // ========================================================================
    const sensorDataPoint: SensorDataPoint = {
      timestamp: new Date().toISOString(),
      timeElapsedSeconds: currentTimeElapsedSeconds,
      pressure,
      injectionRate,
      proppantConcentration,
      fluidViscosity,
      fractureWidth: _fractureWidth,
      fractureLength,
      phase,
    };

    console.log('Generated sensor data point:', sensorDataPoint);

    // ========================================================================
    // Step 10: Validate generated data is within realistic ranges
    // ========================================================================
    validateSensorData(sensorDataPoint);

    // ========================================================================
    // Step 11: Store simulated sensor data in WellOperation record
    // ========================================================================
    console.log('Storing simulated sensor data in WellOperation');
    
    await withRetry({
      operation: async () => {
        await client.models.WellOperation.update({
          id: operationId,
          simulatedSensorData: JSON.stringify(sensorDataPoint),
          simulatedDataTimestamp: new Date().toISOString(),
          simulationTimeElapsedSeconds: currentTimeElapsedSeconds,
        });
      },
      operationName: 'UpdateWellOperationWithSensorData',
      component: COMPONENT_NAME,
      context: { operationId, sessionId },
    });

    console.log('Simulated sensor data stored successfully');

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishOptimizationIterationTime(executionTime, dimensions);

    // ========================================================================
    // Return success
    // ========================================================================
    return {
      success: true,
      sensorData: sensorDataPoint,
      operationProgress: progressFraction,
      isComplete: progressFraction >= 1.0,
    };

  } catch (error) {
    const classifiedError = classifyError(error, { operationId, sessionId });
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
 * Generate realistic pressure data based on fracture propagation model
 * 
 * Pressure typically:
 * - Starts at treating pressure
 * - Increases during ramp-up as fracture initiates
 * - Stabilizes during steady-state pumping
 * - May decrease slightly during ramp-down
 */
function generatePressureData(
  treatingPressure: number,
  progressFraction: number,
  enableNoise: boolean
): number {
  let pressure = treatingPressure;

  // Ramp-up phase: pressure increases 10-15%
  if (progressFraction < PUMPING_PHASES.RAMP_UP) {
    const rampProgress = progressFraction / PUMPING_PHASES.RAMP_UP;
    pressure = treatingPressure * (1.0 + 0.15 * rampProgress);
  }
  // Steady-state phase: pressure stabilizes with minor fluctuations
  else if (progressFraction < PUMPING_PHASES.RAMP_UP + PUMPING_PHASES.STEADY_STATE) {
    pressure = treatingPressure * 1.15;
    
    // Add periodic pressure spikes (simulating proppant bridging events)
    const steadyProgress = (progressFraction - PUMPING_PHASES.RAMP_UP) / PUMPING_PHASES.STEADY_STATE;
    const spikeFrequency = 5; // Spikes every 20% of steady-state
    const spikePhase = (steadyProgress * spikeFrequency) % 1.0;
    if (spikePhase < 0.1) {
      pressure *= (1.0 + 0.05 * Math.sin(spikePhase * Math.PI * 10));
    }
  }
  // Ramp-down phase: pressure decreases
  else {
    const rampDownProgress = (progressFraction - PUMPING_PHASES.RAMP_UP - PUMPING_PHASES.STEADY_STATE) / PUMPING_PHASES.RAMP_DOWN;
    pressure = treatingPressure * (1.15 - 0.15 * rampDownProgress);
  }

  // Add realistic noise
  if (enableNoise) {
    const noise = (Math.random() - 0.5) * 2 * PARAMETER_RANGES.pressure.noise;
    pressure += noise;
  }

  // Clamp to realistic range
  return Math.max(
    PARAMETER_RANGES.pressure.min,
    Math.min(PARAMETER_RANGES.pressure.max, pressure)
  );
}

/**
 * Generate injection rate following typical pumping schedule
 * 
 * Injection rate typically:
 * - Ramps up from low to target rate
 * - Maintains steady-state at target rate
 * - Ramps down at end of operation
 */
function generateInjectionRateData(
  targetRate: number,
  progressFraction: number,
  enableNoise: boolean
): number {
  let rate = targetRate;

  // Ramp-up phase: rate increases from 50% to 100%
  if (progressFraction < PUMPING_PHASES.RAMP_UP) {
    const rampProgress = progressFraction / PUMPING_PHASES.RAMP_UP;
    rate = targetRate * (0.5 + 0.5 * rampProgress);
  }
  // Steady-state phase: maintain target rate
  else if (progressFraction < PUMPING_PHASES.RAMP_UP + PUMPING_PHASES.STEADY_STATE) {
    rate = targetRate;
  }
  // Ramp-down phase: rate decreases to 20%
  else {
    const rampDownProgress = (progressFraction - PUMPING_PHASES.RAMP_UP - PUMPING_PHASES.STEADY_STATE) / PUMPING_PHASES.RAMP_DOWN;
    rate = targetRate * (1.0 - 0.8 * rampDownProgress);
  }

  // Add realistic noise
  if (enableNoise) {
    const noise = (Math.random() - 0.5) * 2 * PARAMETER_RANGES.injectionRate.noise;
    rate += noise;
  }

  // Clamp to realistic range
  return Math.max(
    PARAMETER_RANGES.injectionRate.min,
    Math.min(PARAMETER_RANGES.injectionRate.max, rate)
  );
}

/**
 * Generate proppant concentration following standard proppant schedule
 * 
 * Proppant concentration typically:
 * - Starts low (pad stage with no proppant)
 * - Increases gradually to medium concentration
 * - Increases to high concentration at end
 */
function generateProppantConcentrationData(
  targetConcentration: number,
  progressFraction: number,
  enableNoise: boolean
): number {
  let concentration = 0;

  // Low concentration phase: 0-30% of target
  if (progressFraction < PROPPANT_PHASES.LOW_CONCENTRATION) {
    const lowProgress = progressFraction / PROPPANT_PHASES.LOW_CONCENTRATION;
    concentration = targetConcentration * 0.3 * lowProgress;
  }
  // Medium concentration phase: 30-70% of target
  else if (progressFraction < PROPPANT_PHASES.LOW_CONCENTRATION + PROPPANT_PHASES.MEDIUM_CONCENTRATION) {
    const mediumProgress = (progressFraction - PROPPANT_PHASES.LOW_CONCENTRATION) / PROPPANT_PHASES.MEDIUM_CONCENTRATION;
    concentration = targetConcentration * (0.3 + 0.4 * mediumProgress);
  }
  // High concentration phase: 70-100% of target
  else {
    const highProgress = (progressFraction - PROPPANT_PHASES.LOW_CONCENTRATION - PROPPANT_PHASES.MEDIUM_CONCENTRATION) / PROPPANT_PHASES.HIGH_CONCENTRATION;
    concentration = targetConcentration * (0.7 + 0.3 * highProgress);
  }

  // Add realistic noise
  if (enableNoise) {
    const noise = (Math.random() - 0.5) * 2 * PARAMETER_RANGES.proppantConcentration.noise;
    concentration += noise;
  }

  // Clamp to realistic range
  return Math.max(
    PARAMETER_RANGES.proppantConcentration.min,
    Math.min(PARAMETER_RANGES.proppantConcentration.max, concentration)
  );
}

/**
 * Generate fluid viscosity with minor variations
 * 
 * Fluid viscosity typically:
 * - Remains relatively constant
 * - May decrease slightly due to shear thinning
 * - Minor fluctuations due to temperature changes
 */
function generateFluidViscosityData(
  targetViscosity: number,
  progressFraction: number,
  enableNoise: boolean
): number {
  // Slight decrease due to shear thinning (5% over operation)
  let viscosity = targetViscosity * (1.0 - 0.05 * progressFraction);

  // Add realistic noise
  if (enableNoise) {
    const noise = (Math.random() - 0.5) * 2 * PARAMETER_RANGES.fluidViscosity.noise;
    viscosity += noise;
  }

  // Clamp to realistic range
  return Math.max(
    PARAMETER_RANGES.fluidViscosity.min,
    Math.min(PARAMETER_RANGES.fluidViscosity.max, viscosity)
  );
}

/**
 * Estimate fracture width based on pressure
 * 
 * Fracture width increases with pressure above treating pressure
 */
function estimateFractureWidth(
  initialWidth: number,
  currentPressure: number,
  treatingPressure: number
): number {
  // Width increases proportionally to pressure above treating pressure
  const pressureRatio = currentPressure / treatingPressure;
  const width = initialWidth * Math.pow(pressureRatio, 0.5); // Square root relationship
  
  return Math.max(1.0, Math.min(20.0, width)); // Clamp to 1-20mm
}

/**
 * Estimate fracture length based on pumped volume
 * 
 * Fracture length increases with pumped volume
 */
function estimateFractureLength(
  initialLength: number,
  pumpedVolume: number,
  fractureWidth: number
): number {
  // Simplified model: length increases with cube root of volume
  // Assuming fracture height is constant
  const volumeFactor = Math.pow(pumpedVolume / 100, 0.33); // Normalize by 100 m³
  const length = initialLength * (1.0 + volumeFactor);
  
  return Math.max(50, Math.min(500, length)); // Clamp to 50-500m
}

/**
 * Determine current operation phase based on progress
 */
function determineOperationPhase(progressFraction: number): string {
  if (progressFraction < PUMPING_PHASES.RAMP_UP) {
    return 'RAMP_UP';
  } else if (progressFraction < PUMPING_PHASES.RAMP_UP + PUMPING_PHASES.STEADY_STATE) {
    return 'STEADY_STATE';
  } else {
    return 'RAMP_DOWN';
  }
}

/**
 * Validate sensor data is within realistic ranges
 * 
 * Throws error if data is outside acceptable bounds
 */
function validateSensorData(sensorData: SensorDataPoint): void {
  const validations = [
    {
      field: 'pressure',
      value: sensorData.pressure,
      min: PARAMETER_RANGES.pressure.min,
      max: PARAMETER_RANGES.pressure.max,
    },
    {
      field: 'injectionRate',
      value: sensorData.injectionRate,
      min: PARAMETER_RANGES.injectionRate.min,
      max: PARAMETER_RANGES.injectionRate.max,
    },
    {
      field: 'proppantConcentration',
      value: sensorData.proppantConcentration,
      min: PARAMETER_RANGES.proppantConcentration.min,
      max: PARAMETER_RANGES.proppantConcentration.max,
    },
    {
      field: 'fluidViscosity',
      value: sensorData.fluidViscosity,
      min: PARAMETER_RANGES.fluidViscosity.min,
      max: PARAMETER_RANGES.fluidViscosity.max,
    },
  ];

  for (const validation of validations) {
    if (validation.value < validation.min || validation.value > validation.max) {
      throw new ClassifiedError(
        ErrorCategory.SYSTEM,
        ErrorCode.INVALID_PARAMETERS,
        `Generated ${validation.field} (${validation.value}) is outside realistic range [${validation.min}, ${validation.max}]`,
        { sensorData }
      );
    }
  }

  console.log('Sensor data validation passed');
}
