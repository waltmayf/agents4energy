/**
 * Sensor Data Provider Utility
 * 
 * Generates realistic simulated sensor data for prototype validation.
 * This utility provides functions to generate pressure, injection rate,
 * proppant concentration, and other sensor readings based on fracture
 * propagation models and typical pumping schedules.
 * 
 * Requirements: 2.4 (adapted for simulated data)
 */

// Pumping schedule phases (typical fracturing operation)
export const PUMPING_PHASES = {
  RAMP_UP: 0.15,      // 15% of operation time
  STEADY_STATE: 0.70, // 70% of operation time
  RAMP_DOWN: 0.15,    // 15% of operation time
} as const;

// Proppant schedule phases
export const PROPPANT_PHASES = {
  LOW_CONCENTRATION: 0.20,  // 20% of operation time
  MEDIUM_CONCENTRATION: 0.50, // 50% of operation time
  HIGH_CONCENTRATION: 0.30,  // 30% of operation time
} as const;

// Realistic parameter ranges
export const PARAMETER_RANGES = {
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
} as const;

/**
 * Configuration for sensor data generation
 */
export interface SensorDataConfig {
  operationDurationHours: number;
  sensorUpdateFrequencyHz: number;
  enableRealisticNoise: boolean;
}

/**
 * Default sensor data configuration
 */
export const DEFAULT_SENSOR_CONFIG: SensorDataConfig = {
  operationDurationHours: 4,
  sensorUpdateFrequencyHz: 1,
  enableRealisticNoise: true,
};

/**
 * Simulated sensor data point
 */
export interface SensorDataPoint {
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
 * Initial parameters for sensor data generation
 */
export interface InitialParameters {
  injectionRate: number;
  proppantConcentration: number;
  fluidViscosity: number;
  treatingPressure: number;
  fractureLengthM?: number;
  fractureWidthMm?: number;
}

/**
 * Generate realistic pressure data based on fracture propagation model
 * 
 * Pressure typically:
 * - Starts at treating pressure
 * - Increases during ramp-up as fracture initiates
 * - Stabilizes during steady-state pumping
 * - May decrease slightly during ramp-down
 * 
 * @param treatingPressure - Initial treating pressure (psi)
 * @param progressFraction - Operation progress (0-1)
 * @param enableNoise - Whether to add realistic noise
 * @returns Simulated pressure (psi)
 */
export function generatePressureData(
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
 * 
 * @param targetRate - Target injection rate (m³/s)
 * @param progressFraction - Operation progress (0-1)
 * @param enableNoise - Whether to add realistic noise
 * @returns Simulated injection rate (m³/s)
 */
export function generateInjectionRateData(
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
 * 
 * @param targetConcentration - Target proppant concentration (volume fraction)
 * @param progressFraction - Operation progress (0-1)
 * @param enableNoise - Whether to add realistic noise
 * @returns Simulated proppant concentration (volume fraction)
 */
export function generateProppantConcentrationData(
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
 * 
 * @param targetViscosity - Target fluid viscosity (Pa·s)
 * @param progressFraction - Operation progress (0-1)
 * @param enableNoise - Whether to add realistic noise
 * @returns Simulated fluid viscosity (Pa·s)
 */
export function generateFluidViscosityData(
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
 * 
 * @param initialWidth - Initial fracture width (mm)
 * @param currentPressure - Current pressure (psi)
 * @param treatingPressure - Treating pressure (psi)
 * @returns Estimated fracture width (mm)
 */
export function estimateFractureWidth(
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
 * 
 * @param initialLength - Initial fracture length (m)
 * @param pumpedVolume - Total pumped volume (m³)
 * @param fractureWidth - Current fracture width (mm)
 * @returns Estimated fracture length (m)
 */
export function estimateFractureLength(
  initialLength: number,
  pumpedVolume: number,
  _fractureWidth: number
): number {
  // Simplified model: length increases with cube root of volume
  // Assuming fracture height is constant
  const volumeFactor = Math.pow(pumpedVolume / 100, 0.33); // Normalize by 100 m³
  const length = initialLength * (1.0 + volumeFactor);
  
  return Math.max(50, Math.min(500, length)); // Clamp to 50-500m
}

/**
 * Determine current operation phase based on progress
 * 
 * @param progressFraction - Operation progress (0-1)
 * @returns Current operation phase
 */
export function determineOperationPhase(progressFraction: number): string {
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
 * @param sensorData - Sensor data point to validate
 * @throws Error if data is outside acceptable bounds
 */
export function validateSensorData(sensorData: SensorDataPoint): void {
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
      throw new Error(
        `Generated ${validation.field} (${validation.value}) is outside realistic range [${validation.min}, ${validation.max}]`
      );
    }
  }
}

/**
 * Generate a complete sensor data point
 * 
 * This is the main function that orchestrates all sensor data generation.
 * 
 * @param initialParameters - Initial operation parameters
 * @param currentTimeElapsedSeconds - Current elapsed time (seconds)
 * @param config - Sensor data configuration
 * @returns Complete sensor data point
 */
export function generateSensorDataPoint(
  initialParameters: InitialParameters,
  currentTimeElapsedSeconds: number,
  config: SensorDataConfig = DEFAULT_SENSOR_CONFIG
): SensorDataPoint {
  // Calculate operation progress
  const operationDurationSeconds = config.operationDurationHours * 3600;
  const progressFraction = currentTimeElapsedSeconds / operationDurationSeconds;

  // Generate all sensor readings
  const pressure = generatePressureData(
    initialParameters.treatingPressure,
    progressFraction,
    config.enableRealisticNoise
  );

  const injectionRate = generateInjectionRateData(
    initialParameters.injectionRate,
    progressFraction,
    config.enableRealisticNoise
  );

  const proppantConcentration = generateProppantConcentrationData(
    initialParameters.proppantConcentration,
    progressFraction,
    config.enableRealisticNoise
  );

  const fluidViscosity = generateFluidViscosityData(
    initialParameters.fluidViscosity,
    progressFraction,
    config.enableRealisticNoise
  );

  // Estimate fracture dimensions
  const pumpedVolume = injectionRate * currentTimeElapsedSeconds; // m³
  const fractureWidth = estimateFractureWidth(
    initialParameters.fractureWidthMm || 5.0,
    pressure,
    initialParameters.treatingPressure
  );
  const fractureLength = estimateFractureLength(
    initialParameters.fractureLengthM || 100,
    pumpedVolume,
    fractureWidth
  );

  // Determine current phase
  const phase = determineOperationPhase(progressFraction);

  // Create sensor data point
  const sensorDataPoint: SensorDataPoint = {
    timestamp: new Date().toISOString(),
    timeElapsedSeconds: currentTimeElapsedSeconds,
    pressure,
    injectionRate,
    proppantConcentration,
    fluidViscosity,
    fractureWidth,
    fractureLength,
    phase,
  };

  // Validate before returning
  validateSensorData(sensorDataPoint);

  return sensorDataPoint;
}
