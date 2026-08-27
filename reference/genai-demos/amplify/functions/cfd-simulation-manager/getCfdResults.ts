/**
 * Get CFD Results Handler
 * 
 * Retrieves and parses CFD simulation results by:
 * 1. Retrieving result files from S3 (VTK, CSV, JSON formats)
 * 2. Parsing VTK/CSV files to extract velocity, pressure, proppant concentration fields
 * 3. Calculating optimization metrics: proppantPlacementEfficiency, fractureGeometryScore, placementUniformity, nearWellboreConcentration
 * 4. Calculating risk metrics (secondary): screenOutRisk, concentrationRisk, velocityRisk, pressureRisk, timeToScreenoutSeconds
 * 5. Calculating confidence score based on simulation convergence
 * 6. Generating optimization recommendations if opportunities identified
 * 7. Storing results in CFDSimulation record
 * 8. Preserving raw files if parsing fails
 * 9. Returning SimulationResultsData with all metrics
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.5
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/get-cfd-results';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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
const s3Client = new S3Client({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'GetCfdResults';
// DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME is auto-injected by Amplify Gen 2 via allow.resource() in storage/resource.ts.
// STORAGE_BUCKET was manually set to 'PLACEHOLDER' in backend.ts due to cross-stack circular dependency.
// HPC_BUCKET is the S3 bucket linked to FSx Lustre via Data Repository Association (auto-export).
const STORAGE_BUCKET = process.env.DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME || process.env.STORAGE_BUCKET || '';
const HPC_BUCKET = process.env.HPC_BUCKET || '';

/**
 * Parsed simulation data from result files
 */
interface ParsedSimulationData {
  // Field data
  velocityField: number[][];      // [x, y, z] velocity vectors
  pressureField: number[];        // Pressure values
  proppantField: number[];        // Proppant concentration values
  
  // Mesh/geometry info
  cellCount: number;
  domainSize: { x: number; y: number; z: number };
  
  // Convergence info
  finalResiduals: {
    pressure: number;
    velocity: number;
    proppant: number;
  };
  iterations: number;

  // Pre-computed metrics from calculate_metrics.py (3D pipeline)
  preComputedOptimization?: OptimizationMetrics;
  preComputedRisk?: Omit<RiskMetrics, 'timeToScreenoutSeconds'>;

  // Pressure statistics from calculate_metrics.py
  pressureStats?: PressureStats;

  // Time-series data for transient simulations
  timeSeries?: unknown[];
  predictedMaxTreatingPressure?: number;
}

/**
 * Pressure field statistics from the solver
 */
interface PressureStats {
  min: number;
  max: number;
  mean: number;
  inletPressure: number;
  maxGradient: number;
}

/**
 * Optimization metrics calculated from simulation data
 */
interface OptimizationMetrics {
  proppantPlacementEfficiency: number;  // 0-1
  fractureGeometryScore: number;        // 0-1
  placementUniformity: number;          // 0-1
  nearWellboreConcentration: number;    // volume fraction
}

/**
 * Risk metrics calculated from simulation data
 */
interface RiskMetrics {
  screenOutRisk: number;           // 0-1 composite risk
  concentrationRisk: number;       // 0-1
  velocityRisk: number;            // 0-1
  pressureRisk: number;            // 0-1
  timeToScreenoutSeconds?: number; // seconds
}

/**
 * Optimization recommendation
 */
interface OptimizationRecommendation {
  type: string;
  priority: string;
  title: string;
  description: string;
  reasoning: string;
  parameterAdjustments: Array<{
    parameter: string;
    currentValue: number;
    recommendedValue: number;
    changePercent: number;
    unit: string;
  }>;
  expectedImprovements: {
    proppantPlacementIncrease?: number;
    fractureGeometryImprovement?: number;
    screenOutRiskReduction?: number;
  };
  supportingModels: string[];
  confidence: number;
}

/**
 * Retrieve result files from S3
 * Requirement: 4.1
 */
async function retrieveResultFiles(slurmJobId: string): Promise<{
  vtkFiles: string[];
  csvFiles: string[];
  jsonFiles: string[];
  metricsFile?: string;
  sourceBucket: string;
  vtkTotalSizeBytes: number;
}> {
  return withRetry({
    operation: async () => {
      // Check both the Amplify storage bucket and the HPC bucket (FSx auto-export target).
      // FSx DRA exports to HPC_BUCKET at cfd-simulations/<jobId>/results/
      const bucketsToCheck = [
        { bucket: STORAGE_BUCKET, prefix: `cfd-simulations/results/${slurmJobId}/` },
        { bucket: HPC_BUCKET, prefix: `cfd-simulations/${slurmJobId}/results/` },
      ].filter(b => b.bucket && b.bucket !== 'PLACEHOLDER');

      for (const { bucket, prefix } of bucketsToCheck) {
        console.log(`Checking bucket ${bucket} with prefix ${prefix}`);
        const listResult = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
          })
        );

        const files = listResult.Contents || [];
        if (files.length > 0) {
          console.log(`Found ${files.length} result files in ${bucket}/${prefix}`);
          const vtkObjects = files.filter(f => f.Key?.endsWith('.vtk'));
          const vtkFiles = vtkObjects.map(f => f.Key!);
          const vtkTotalSizeBytes = vtkObjects.reduce((sum, f) => sum + (f.Size ?? 0), 0);
          const csvFiles = files.filter(f => f.Key?.endsWith('.csv')).map(f => f.Key!);
          const jsonFiles = files.filter(f => f.Key?.endsWith('.json')).map(f => f.Key!);
          const metricsFile = jsonFiles.find(f => f.includes('metrics.json'));

          return { vtkFiles, csvFiles, jsonFiles, metricsFile, sourceBucket: bucket, vtkTotalSizeBytes };
        }
      }

      throw new ClassifiedError(
        ErrorCategory.PERMANENT,
        ErrorCode.MALFORMED_INPUT,
        `No result files found for job ${slurmJobId} in any bucket`,
        { slurmJobId, bucketsChecked: bucketsToCheck.map(b => `${b.bucket}/${b.prefix}`) }
      );
    },
    operationName: 'RetrieveResultFiles',
    component: COMPONENT_NAME,
    context: { slurmJobId },
  });
}

/**
 * Download file content from S3
 */
async function downloadFileContent(key: string, bucket?: string): Promise<string> {
  return withRetry({
    operation: async () => {
      const result = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket || STORAGE_BUCKET,
          Key: key,
        })
      );

      if (!result.Body) {
        throw new ClassifiedError(
          ErrorCategory.PERMANENT,
          ErrorCode.MALFORMED_INPUT,
          `Empty file content for ${key}`,
          { key }
        );
      }

      return await result.Body.transformToString();
    },
    operationName: 'DownloadFileContent',
    component: COMPONENT_NAME,
    context: { key },
  });
}

/**
 * Parse VTK file to extract simulation fields
 * Requirement: 4.2
 */
function parseVtkFile(content: string): Partial<ParsedSimulationData> {
  try {
    const lines = content.split('\n');
    const data: Partial<ParsedSimulationData> = {
      velocityField: [],
      pressureField: [],
      proppantField: [],
    };

    let currentSection = '';
    let pointCount = 0;
    let cellCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Parse header info
      if (line.startsWith('POINTS')) {
        pointCount = parseInt(line.split(' ')[1]);
      } else if (line.startsWith('CELLS')) {
        cellCount = parseInt(line.split(' ')[1]);
      }

      // Parse field data sections
      if (line.startsWith('VECTORS velocity')) {
        currentSection = 'velocity';
        continue;
      } else if (line.startsWith('SCALARS pressure')) {
        currentSection = 'pressure';
        i++; // Skip LOOKUP_TABLE line
        continue;
      } else if (line.startsWith('SCALARS proppant') || line.startsWith('SCALARS concentration')) {
        currentSection = 'proppant';
        i++; // Skip LOOKUP_TABLE line
        continue;
      }

      // Parse data based on current section
      if (currentSection === 'velocity' && line && !line.startsWith('SCALARS') && !line.startsWith('VECTORS')) {
        const values = line.split(/\s+/).map(Number).filter(n => !isNaN(n));
        if (values.length === 3) {
          data.velocityField!.push(values);
        }
      } else if (currentSection === 'pressure' && line && !line.startsWith('SCALARS') && !line.startsWith('VECTORS')) {
        const value = parseFloat(line);
        if (!isNaN(value)) {
          data.pressureField!.push(value);
        }
      } else if (currentSection === 'proppant' && line && !line.startsWith('SCALARS') && !line.startsWith('VECTORS')) {
        const value = parseFloat(line);
        if (!isNaN(value)) {
          data.proppantField!.push(value);
        }
      }
    }

    data.cellCount = cellCount || pointCount;

    return data;
  } catch (error) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      `Failed to parse VTK file: ${error instanceof Error ? error.message : String(error)}`,
      { error }
    );
  }
}

/**
 * Parse CSV file to extract simulation fields
 * Requirement: 4.2
 */
function parseCsvFile(content: string): Partial<ParsedSimulationData> {
  try {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      throw new Error('CSV file has insufficient data');
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const data: Partial<ParsedSimulationData> = {
      velocityField: [],
      pressureField: [],
      proppantField: [],
    };

    // Find column indices
    const vxIdx = headers.findIndex(h => h.includes('velocity_x') || h.includes('vx'));
    const vyIdx = headers.findIndex(h => h.includes('velocity_y') || h.includes('vy'));
    const vzIdx = headers.findIndex(h => h.includes('velocity_z') || h.includes('vz'));
    const pressureIdx = headers.findIndex(h => h.includes('pressure') || h.includes('p'));
    const proppantIdx = headers.findIndex(h => h.includes('proppant') || h.includes('concentration') || h.includes('alpha'));

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => parseFloat(v.trim()));

      if (vxIdx >= 0 && vyIdx >= 0 && vzIdx >= 0) {
        data.velocityField!.push([values[vxIdx], values[vyIdx], values[vzIdx]]);
      }
      if (pressureIdx >= 0) {
        data.pressureField!.push(values[pressureIdx]);
      }
      if (proppantIdx >= 0) {
        data.proppantField!.push(values[proppantIdx]);
      }
    }

    data.cellCount = lines.length - 1;

    return data;
  } catch (error) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      `Failed to parse CSV file: ${error instanceof Error ? error.message : String(error)}`,
      { error }
    );
  }
}

/**
 * Parse JSON metrics file (if available)
 * Requirement: 4.2, 4.6
 */
function parseJsonMetrics(content: string): Partial<ParsedSimulationData> {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;

    // Handle nested metrics.json structure from calculate_metrics.py (3D pipeline)
    const simInfo = (json.simulationInfo ?? json) as Record<string, unknown>;

    const result: Partial<ParsedSimulationData> = {
      finalResiduals: (simInfo.finalResiduals ?? json.residuals ?? json.finalResiduals) as ParsedSimulationData['finalResiduals'] | undefined,
      iterations: (simInfo.iterations ?? json.iterations ?? json.iterationCount) as number | undefined,
      cellCount: (simInfo.cellCount ?? json.cellCount ?? json.meshSize) as number | undefined,
      domainSize: (simInfo.domainSize ?? json.domainSize) as ParsedSimulationData['domainSize'] | undefined,
    };

    // Extract pre-computed optimization metrics when present
    const optRaw = json.optimizationMetrics as Record<string, number> | undefined;
    if (optRaw && typeof optRaw.proppantPlacementEfficiency === 'number') {
      result.preComputedOptimization = {
        proppantPlacementEfficiency: optRaw.proppantPlacementEfficiency,
        fractureGeometryScore: optRaw.fractureGeometryScore ?? 0,
        placementUniformity: optRaw.placementUniformity ?? 0,
        nearWellboreConcentration: optRaw.nearWellboreConcentration ?? 0,
      };
    }

    // Extract pre-computed risk metrics when present
    const riskRaw = json.riskMetrics as Record<string, number> | undefined;
    if (riskRaw && typeof riskRaw.screenOutRisk === 'number') {
      result.preComputedRisk = {
        screenOutRisk: riskRaw.screenOutRisk,
        concentrationRisk: riskRaw.concentrationRisk ?? 0,
        velocityRisk: riskRaw.velocityRisk ?? 0,
        pressureRisk: riskRaw.pressureRisk ?? 0,
      };
    }

    // Extract pressure statistics when present
    const pressRaw = json.pressureStats as Record<string, number> | undefined;
    if (pressRaw && typeof pressRaw.inletPressure === 'number') {
      result.pressureStats = {
        min: pressRaw.min ?? 0,
        max: pressRaw.max ?? 0,
        mean: pressRaw.mean ?? 0,
        inletPressure: pressRaw.inletPressure,
        maxGradient: pressRaw.maxGradient ?? 0,
      };
    }

    // Extract time-series data for transient simulations
    if (Array.isArray(json.timeSeries)) {
      result.timeSeries = json.timeSeries as unknown[];
    }

    // Extract predicted max treating pressure
    if (typeof json.predictedMaxTreatingPressure === 'number') {
      result.predictedMaxTreatingPressure = json.predictedMaxTreatingPressure;
    }

    return result;
  } catch (error) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      `Failed to parse JSON metrics: ${error instanceof Error ? error.message : String(error)}`,
      { error }
    );
  }
}

/**
 * Calculate optimization metrics from parsed simulation data
 * Requirement: 4.3
 */
function calculateOptimizationMetrics(data: ParsedSimulationData): OptimizationMetrics {
  // Calculate near-wellbore proppant concentration (average of first 10% of cells)
  const nearWellboreCount = Math.max(1, Math.floor(data.proppantField.length * 0.1));
  const nearWellboreConcentration = 
    data.proppantField.slice(0, nearWellboreCount).reduce((sum, val) => sum + val, 0) / nearWellboreCount;

  // Calculate proppant placement efficiency (near-wellbore concentration / target of 0.3)
  const targetConcentration = 0.3;
  const proppantPlacementEfficiency = Math.min(1.0, nearWellboreConcentration / targetConcentration);

  // Calculate placement uniformity (1 - coefficient of variation)
  const mean = data.proppantField.reduce((sum, val) => sum + val, 0) / data.proppantField.length;
  const variance = data.proppantField.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.proppantField.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? stdDev / mean : 1.0;
  const placementUniformity = Math.max(0, 1.0 - coefficientOfVariation);

  // Calculate fracture geometry score (based on velocity distribution and domain size)
  const avgVelocity = data.velocityField.reduce((sum, v) => {
    const magnitude = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return sum + magnitude;
  }, 0) / data.velocityField.length;

  // Good fracture geometry has moderate, uniform velocity (not too high, not too low)
  const optimalVelocity = 0.5; // m/s
  const velocityScore = Math.exp(-Math.pow((avgVelocity - optimalVelocity) / optimalVelocity, 2));
  
  // Combine with domain size (larger fractures score higher)
  const domainVolume = data.domainSize ? 
    data.domainSize.x * data.domainSize.y * data.domainSize.z : 1000;
  const volumeScore = Math.min(1.0, domainVolume / 10000); // Normalize to 10,000 m³
  
  const fractureGeometryScore = (velocityScore * 0.6 + volumeScore * 0.4);

  return {
    proppantPlacementEfficiency: Math.max(0, Math.min(1, proppantPlacementEfficiency)),
    fractureGeometryScore: Math.max(0, Math.min(1, fractureGeometryScore)),
    placementUniformity: Math.max(0, Math.min(1, placementUniformity)),
    nearWellboreConcentration,
  };
}

/**
 * Calculate risk metrics from parsed simulation data (secondary metrics)
 * Requirement: 6.1, 6.2, 6.3, 6.4
 */
function calculateRiskMetrics(data: ParsedSimulationData): RiskMetrics {
  // Critical thresholds
  const criticalConcentration = 0.4; // volume fraction
  const criticalVelocity = 0.1; // m/s (minimum to prevent settling)
  const criticalPressureGradient = 1000; // psi/ft

  // Calculate concentration risk (max concentration / critical threshold)
  const maxConcentration = Math.max(...data.proppantField);
  const concentrationRisk = Math.min(1.0, maxConcentration / criticalConcentration);

  // Calculate velocity risk (critical velocity / minimum velocity)
  const velocityMagnitudes = data.velocityField.map(v => 
    Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  );
  const minVelocity = Math.min(...velocityMagnitudes);
  const velocityRisk = minVelocity < criticalVelocity ? 
    Math.min(1.0, criticalVelocity / (minVelocity + 0.01)) : 0;

  // Calculate pressure risk (max gradient / critical gradient)
  const pressureGradients: number[] = [];
  for (let i = 1; i < data.pressureField.length; i++) {
    const gradient = Math.abs(data.pressureField[i] - data.pressureField[i - 1]);
    pressureGradients.push(gradient);
  }
  const maxPressureGradient = pressureGradients.length > 0 ? Math.max(...pressureGradients) : 0;
  const pressureRisk = Math.min(1.0, maxPressureGradient / criticalPressureGradient);

  // Calculate composite screen-out risk (weighted average)
  const screenOutRisk = (
    concentrationRisk * 0.5 +
    velocityRisk * 0.3 +
    pressureRisk * 0.2
  );

  // Estimate time to screen-out if risk is high
  let timeToScreenoutSeconds: number | undefined;
  if (screenOutRisk > 0.7) {
    // Simple linear model: higher risk = less time
    const baseTime = 3600; // 1 hour
    timeToScreenoutSeconds = Math.floor(baseTime * (1 - screenOutRisk));
  }

  return {
    screenOutRisk: Math.max(0, Math.min(1, screenOutRisk)),
    concentrationRisk: Math.max(0, Math.min(1, concentrationRisk)),
    velocityRisk: Math.max(0, Math.min(1, velocityRisk)),
    pressureRisk: Math.max(0, Math.min(1, pressureRisk)),
    timeToScreenoutSeconds,
  };
}

/**
 * Calculate confidence score based on simulation convergence
 * Requirement: 4.4
 */
function calculateConfidence(data: ParsedSimulationData): number {
  if (!data.finalResiduals) {
    return 0.5; // Default medium confidence if no residual data
  }

  // Good convergence: residuals < 1e-4
  const targetResidual = 1e-4;
  
  const pressureConfidence = data.finalResiduals.pressure ? 
    Math.exp(-data.finalResiduals.pressure / targetResidual) : 0.5;
  const velocityConfidence = data.finalResiduals.velocity ? 
    Math.exp(-data.finalResiduals.velocity / targetResidual) : 0.5;
  const proppantConfidence = data.finalResiduals.proppant ? 
    Math.exp(-data.finalResiduals.proppant / targetResidual) : 0.5;

  // Weighted average
  const confidence = (
    pressureConfidence * 0.4 +
    velocityConfidence * 0.4 +
    proppantConfidence * 0.2
  );

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Generate optimization recommendations based on metrics
 * Requirement: 10.1, 10.2, 10.3, 10.4, 10.5
 */
function generateRecommendations(
  optimizationMetrics: OptimizationMetrics,
  riskMetrics: RiskMetrics,
  confidence: number,
  simulationParams: any
): OptimizationRecommendation[] {
  const recommendations: OptimizationRecommendation[] = [];

  // Recommendation 1: Improve proppant placement if efficiency is low
  if (optimizationMetrics.proppantPlacementEfficiency < 0.7 && confidence > 0.6) {
    const currentRate = simulationParams.injectionRate || 0.3;
    const recommendedRate = currentRate * 1.15; // Increase by 15%
    
    recommendations.push({
      type: 'INCREASE_PROPPANT_PLACEMENT',
      priority: optimizationMetrics.proppantPlacementEfficiency < 0.5 ? 'HIGH' : 'MEDIUM',
      title: 'Increase Near-Wellbore Proppant Placement',
      description: `Current proppant placement efficiency is ${(optimizationMetrics.proppantPlacementEfficiency * 100).toFixed(1)}%. Increasing injection rate can improve near-wellbore sand concentration.`,
      reasoning: `Simulation shows low near-wellbore proppant concentration (${optimizationMetrics.nearWellboreConcentration.toFixed(3)} vs target 0.3). Higher injection rate will improve proppant transport to near-wellbore region.`,
      parameterAdjustments: [{
        parameter: 'injectionRate',
        currentValue: currentRate,
        recommendedValue: recommendedRate,
        changePercent: 15,
        unit: 'm³/s',
      }],
      expectedImprovements: {
        proppantPlacementIncrease: 20,
        fractureGeometryImprovement: 5,
      },
      supportingModels: ['CFD'],
      confidence,
    });
  }

  // Recommendation 2: Optimize fracture geometry if score is low
  if (optimizationMetrics.fractureGeometryScore < 0.7 && confidence > 0.6) {
    const currentConcentration = simulationParams.proppantConcentration || 0.25;
    const recommendedConcentration = currentConcentration * 1.10; // Increase by 10%
    
    recommendations.push({
      type: 'IMPROVE_FRACTURE_GEOMETRY',
      priority: 'MEDIUM',
      title: 'Optimize Fracture Geometry',
      description: `Fracture geometry score is ${(optimizationMetrics.fractureGeometryScore * 100).toFixed(1)}%. Adjusting proppant concentration can improve fracture width and conductivity.`,
      reasoning: `Simulation indicates suboptimal fracture geometry. Moderate increase in proppant concentration will improve fracture width while maintaining good transport.`,
      parameterAdjustments: [{
        parameter: 'proppantConcentration',
        currentValue: currentConcentration,
        recommendedValue: recommendedConcentration,
        changePercent: 10,
        unit: 'volume fraction',
      }],
      expectedImprovements: {
        fractureGeometryImprovement: 15,
        proppantPlacementIncrease: 8,
      },
      supportingModels: ['CFD'],
      confidence,
    });
  }

  // Recommendation 3: Improve placement uniformity if low
  if (optimizationMetrics.placementUniformity < 0.6 && confidence > 0.6) {
    const currentViscosity = simulationParams.fluidViscosity || 0.05;
    const recommendedViscosity = currentViscosity * 1.12; // Increase by 12%
    
    recommendations.push({
      type: 'ADJUST_PROPPANT_CONCENTRATION',
      priority: 'LOW',
      title: 'Improve Proppant Distribution Uniformity',
      description: `Proppant placement uniformity is ${(optimizationMetrics.placementUniformity * 100).toFixed(1)}%. Increasing fluid viscosity can reduce settling and improve distribution.`,
      reasoning: `Simulation shows non-uniform proppant distribution. Higher fluid viscosity will reduce proppant settling and create more uniform placement.`,
      parameterAdjustments: [{
        parameter: 'fluidViscosity',
        currentValue: currentViscosity,
        recommendedValue: recommendedViscosity,
        changePercent: 12,
        unit: 'Pa·s',
      }],
      expectedImprovements: {
        proppantPlacementIncrease: 10,
      },
      supportingModels: ['CFD'],
      confidence,
    });
  }

  return recommendations;
}

/**
 * Parse simulation result files
 * Requirement: 4.2, 4.6
 */
async function parseSimulationResults(
  vtkFiles: string[],
  csvFiles: string[],
  jsonFiles: string[],
  metricsFile?: string,
  sourceBucket?: string,
  vtkTotalSizeBytes = 0
): Promise<ParsedSimulationData> {
  const parsedData: Partial<ParsedSimulationData> = {
    velocityField: [],
    pressureField: [],
    proppantField: [],
    cellCount: 0,
  };

  // Try to parse metrics file first (JSON)
  if (metricsFile) {
    try {
      const content = await downloadFileContent(metricsFile, sourceBucket);
      const metricsData = parseJsonMetrics(content);
      Object.assign(parsedData, metricsData);
    } catch (error) {
      console.warn('Failed to parse metrics JSON file', error);
    }
  }

  // When metrics.json has pre-computed optimization and risk metrics,
  // skip VTK parsing — the Python calculator already did the work.
  const hasPreComputedMetrics = !!(parsedData.preComputedOptimization && parsedData.preComputedRisk);

  // VTK size guard: skip VTK download if total size > 50 MB
  const VTK_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
  const skipVtk = hasPreComputedMetrics || vtkTotalSizeBytes > VTK_SIZE_LIMIT;
  if (vtkTotalSizeBytes > VTK_SIZE_LIMIT) {
    console.warn(`VTK files total ${(vtkTotalSizeBytes / 1024 / 1024).toFixed(1)} MB — skipping VTK parsing, using metrics.json`);
  }

  // Parse VTK files (preferred format) unless skipped
  if (vtkFiles.length > 0 && !skipVtk) {
    try {
      // Use the latest VTK file (last time step)
      const latestVtk = vtkFiles[vtkFiles.length - 1];
      const content = await downloadFileContent(latestVtk, sourceBucket);
      const vtkData = parseVtkFile(content);
      Object.assign(parsedData, vtkData);
    } catch (error) {
      console.warn('Failed to parse VTK file', error);
    }
  }

  // Parse CSV files if VTK parsing failed or incomplete
  if (csvFiles.length > 0 && (!parsedData.velocityField?.length || !parsedData.pressureField?.length)) {
    try {
      const latestCsv = csvFiles[csvFiles.length - 1];
      const content = await downloadFileContent(latestCsv, sourceBucket);
      const csvData = parseCsvFile(content);
      
      // Merge CSV data (don't overwrite existing data)
      if (!parsedData.velocityField?.length) parsedData.velocityField = csvData.velocityField;
      if (!parsedData.pressureField?.length) parsedData.pressureField = csvData.pressureField;
      if (!parsedData.proppantField?.length) parsedData.proppantField = csvData.proppantField;
      if (!parsedData.cellCount) parsedData.cellCount = csvData.cellCount;
    } catch (error) {
      console.warn('Failed to parse CSV file', error);
    }
  }

  // Validate we have minimum required data
  // When pre-computed metrics exist from metrics.json, field data is optional
  if (!hasPreComputedMetrics && (!parsedData.velocityField?.length || !parsedData.pressureField?.length || !parsedData.proppantField?.length)) {
    throw new ClassifiedError(
      ErrorCategory.PERMANENT,
      ErrorCode.MALFORMED_INPUT,
      'Insufficient data in result files - missing velocity, pressure, or proppant fields and no pre-computed metrics',
      { 
        hasVelocity: !!parsedData.velocityField?.length,
        hasPressure: !!parsedData.pressureField?.length,
        hasProppant: !!parsedData.proppantField?.length,
        hasPreComputedMetrics,
      }
    );
  }

  // Set defaults for missing optional data
  if (!parsedData.domainSize) {
    parsedData.domainSize = { x: 100, y: 100, z: 10 }; // Default domain size
  }
  if (!parsedData.finalResiduals) {
    parsedData.finalResiduals = { pressure: 1e-3, velocity: 1e-3, proppant: 1e-3 };
  }
  if (!parsedData.iterations) {
    parsedData.iterations = 100;
  }

  return parsedData as ParsedSimulationData;
}

/**
 * Handler for getCfdResults query
 */
export const handler: Schema['getCfdResults']['functionHandler'] = async (event) => {
  console.log('Getting CFD results', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { jobId } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'getCfdResults',
  };

  try {
    // ========================================================================
    // Step 1: Retrieve CFDSimulation record to get Slurm job ID and parameters
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

    // Check if simulation is completed
    if (simulationResult.status !== 'completed') {
      return {
        success: false,
        jobId,
        proppantPlacementEfficiency: 0,
        fractureGeometryScore: 0,
        placementUniformity: 0,
        screenOutRisk: 0,
        concentrationRisk: 0,
        velocityRisk: 0,
        pressureRisk: 0,
        timeToScreenoutSeconds: 0,
        confidence: 0,
        error: `Simulation is not completed yet. Current status: ${simulationResult.status}`,
      };
    }

    console.log(`Found Slurm job ID: ${slurmJobId}`);

    // ========================================================================
    // Step 2: Retrieve result files from S3
    // Requirement: 4.1
    // ========================================================================
    console.log('Retrieving result files from S3');
    
    const { vtkFiles, csvFiles, jsonFiles, metricsFile, sourceBucket, vtkTotalSizeBytes } = await retrieveResultFiles(slurmJobId);
    
    console.log(`Found ${vtkFiles.length} VTK files (${(vtkTotalSizeBytes / 1024 / 1024).toFixed(1)} MB), ${csvFiles.length} CSV files, ${jsonFiles.length} JSON files in bucket ${sourceBucket}`);

    // ========================================================================
    // Step 3: Parse result files to extract fields
    // Requirements: 4.2, 4.6
    // ========================================================================
    console.log('Parsing simulation result files');
    
    let parsedData: ParsedSimulationData;
    try {
      parsedData = await parseSimulationResults(vtkFiles, csvFiles, jsonFiles, metricsFile, sourceBucket, vtkTotalSizeBytes);
      console.log('Successfully parsed simulation results');
    } catch (error) {
      // Requirement 4.5: Preserve raw files if parsing fails
      console.error('Failed to parse result files', error);
      
      const classifiedError = classifyError(error, { jobId, slurmJobId });
      logError(classifiedError, COMPONENT_NAME);

      return {
        success: false,
        jobId,
        proppantPlacementEfficiency: 0,
        fractureGeometryScore: 0,
        placementUniformity: 0,
        screenOutRisk: 0,
        concentrationRisk: 0,
        velocityRisk: 0,
        pressureRisk: 0,
        timeToScreenoutSeconds: 0,
        confidence: 0,
        error: `Failed to parse result files: ${classifiedError.message}. Raw files preserved at s3://${STORAGE_BUCKET}/cfd-simulations/results/${slurmJobId}/`,
      };
    }

    // ========================================================================
    // Step 4: Calculate optimization metrics
    // Use pre-computed metrics from metrics.json when available (3D pipeline)
    // Requirement: 4.3
    // ========================================================================
    console.log('Calculating optimization metrics');
    
    const optimizationMetrics = parsedData.preComputedOptimization ?? calculateOptimizationMetrics(parsedData);
    
    console.log('Optimization metrics:', optimizationMetrics);

    // ========================================================================
    // Step 5: Calculate risk metrics (secondary)
    // Use pre-computed metrics from metrics.json when available (3D pipeline)
    // Requirements: 6.1, 6.2, 6.3, 6.4
    // ========================================================================
    console.log('Calculating risk metrics');
    
    const riskMetrics: RiskMetrics = parsedData.preComputedRisk
      ? { ...parsedData.preComputedRisk, timeToScreenoutSeconds: undefined }
      : calculateRiskMetrics(parsedData);
    
    console.log('Risk metrics:', riskMetrics);

    // ========================================================================
    // Step 6: Calculate confidence score
    // Requirement: 4.4
    // ========================================================================
    console.log('Calculating confidence score');
    
    const confidence = calculateConfidence(parsedData);
    
    console.log(`Confidence score: ${confidence.toFixed(3)}`);

    // ========================================================================
    // Step 7: Generate optimization recommendations if opportunities identified
    // Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
    // ========================================================================
    console.log('Generating optimization recommendations');
    
    const simulationParams = {
      injectionRate: simulationResult.fracturingParams?.pumpRate ? 
        simulationResult.fracturingParams.pumpRate / 6.28981 : 0.3, // Convert bbl/min to m³/s
      proppantConcentration: simulationResult.fracturingParams?.proppantConcentration ?
        simulationResult.fracturingParams.proppantConcentration / 8.345 : 0.25, // Convert ppg to volume fraction
      fluidViscosity: simulationResult.fracturingParams?.fluidViscosity ?
        simulationResult.fracturingParams.fluidViscosity / 1000 : 0.05, // Convert cP to Pa·s
    };

    const recommendations = generateRecommendations(
      optimizationMetrics,
      riskMetrics,
      confidence,
      simulationParams
    );
    
    console.log(`Generated ${recommendations.length} recommendations`);

    // ========================================================================
    // Step 8: Store results in CFDSimulation record
    // Requirement: 4.4
    // ========================================================================
    console.log('Updating CFDSimulation record with results');
    
    await withRetry({
      operation: async () => {
        const result = await client.models.CFDSimulation.update({
          id: jobId,
          
          // Optimization metrics (primary)
          proppantPlacementEfficiency: optimizationMetrics.proppantPlacementEfficiency,
          fractureGeometryScore: optimizationMetrics.fractureGeometryScore,
          placementUniformity: optimizationMetrics.placementUniformity,
          nearWellboreConcentration: optimizationMetrics.nearWellboreConcentration,
          
          // Risk metrics (secondary)
          screenOutRisk: riskMetrics.screenOutRisk,
          concentrationRisk: riskMetrics.concentrationRisk,
          velocityRisk: riskMetrics.velocityRisk,
          pressureRisk: riskMetrics.pressureRisk,
          timeToScreenOutSeconds: riskMetrics.timeToScreenoutSeconds,
          
          // Confidence
          confidence,
          
          // Fracture geometry results (extract from domain size)
          fractureWidth: parsedData.domainSize.z,
          fractureLength: parsedData.domainSize.x,
          fractureHeight: parsedData.domainSize.y,

          // Predicted max treating pressure (transient simulations)
          ...(parsedData.predictedMaxTreatingPressure != null
            ? { predictedMaxTreatingPressure: parsedData.predictedMaxTreatingPressure }
            : {}),
        });

        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.SYSTEM,
            ErrorCode.SERVICE_UNAVAILABLE,
            'Failed to update CFDSimulation record',
            { jobId }
          );
        }
      },
      operationName: 'UpdateCFDSimulationResults',
      component: COMPONENT_NAME,
      context: { jobId },
    });

    console.log('Successfully updated CFDSimulation record');

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishSimulationExecutionTime(executionTime, dimensions);

    // ========================================================================
    // Step 9: Return SimulationResultsData with all metrics
    // Requirement: 4.4
    // ========================================================================
    
    // Generate visualization URLs (pre-signed URLs would be generated here in production)
    const visualizationUrls = [
      `https://${STORAGE_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/cfd-simulations/results/${slurmJobId}/visualization.png`,
      `https://${STORAGE_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/cfd-simulations/results/${slurmJobId}/proppant_distribution.png`,
    ];

    return {
      success: true,
      jobId,
      
      // Optimization metrics (primary)
      proppantPlacementEfficiency: optimizationMetrics.proppantPlacementEfficiency,
      fractureGeometryScore: optimizationMetrics.fractureGeometryScore,
      placementUniformity: optimizationMetrics.placementUniformity,
      
      // Risk metrics (secondary)
      screenOutRisk: riskMetrics.screenOutRisk,
      concentrationRisk: riskMetrics.concentrationRisk,
      velocityRisk: riskMetrics.velocityRisk,
      pressureRisk: riskMetrics.pressureRisk,
      timeToScreenoutSeconds: riskMetrics.timeToScreenoutSeconds,
      
      // Confidence and recommendations
      confidence,
      // TODO: recommendations need to be created as OptimizationRecommendation model records
      // For now, returning undefined since the type expects full model records with id, sessionId, etc.
      recommendations: undefined,
      visualizationUrls,
      pressureStats: parsedData.pressureStats ?? null,
      timeSeries: parsedData.timeSeries ?? null,
      predictedMaxTreatingPressurePsi: parsedData.predictedMaxTreatingPressure ?? null,
    };

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
      
      // Return zeros for required numeric fields
      proppantPlacementEfficiency: 0,
      fractureGeometryScore: 0,
      placementUniformity: 0,
      screenOutRisk: 0,
      concentrationRisk: 0,
      velocityRisk: 0,
      pressureRisk: 0,
      timeToScreenoutSeconds: 0,
      confidence: 0,
      
      error: classifiedError.message,
    };
  }
};
