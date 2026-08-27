/**
 * Result Aggregator Utility
 * 
 * Aggregates multi-fidelity model results into unified optimization assessment.
 * 
 * Weights results by model fidelity:
 * - Physics model: 0.2 (high frequency, low fidelity)
 * - ROM model: 0.3 (medium frequency, medium fidelity)
 * - CFD model: 0.5 (low frequency, high fidelity)
 * 
 * Combines results into unified metrics with confidence intervals.
 * Identifies opportunities where models agree.
 * Flags discrepancies between models.
 * 
 * Requirements: 4.3, 6.4, 6.6
 */

import { ModelType, ModelExecutionResult } from './modelOrchestrator';

/**
 * Model fidelity weights
 * Higher weight = higher fidelity/trust in results
 */
const MODEL_WEIGHTS: Record<ModelType, number> = {
  [ModelType.PHYSICS]: 0.2,  // Fast but simplified
  [ModelType.ROM]: 0.3,      // Medium fidelity surrogate
  [ModelType.CFD]: 0.5,      // High fidelity but slow
};

/**
 * Aggregated optimization metrics with confidence intervals
 */
export interface AggregatedMetrics {
  // Primary optimization metrics
  proppantPlacementEfficiency: number;
  proppantPlacementEfficiencyCI: [number, number]; // [lower, upper] 95% confidence interval
  
  fractureGeometryScore: number;
  fractureGeometryScoreCI: [number, number];
  
  placementUniformity: number;
  placementUniformityCI: [number, number];
  
  nearWellboreConcentration: number;
  nearWellboreConcentrationCI: [number, number];
  
  // Secondary risk metrics
  screenOutRisk: number;
  screenOutRiskCI: [number, number];
  
  // Fracture geometry
  fractureWidth: number;
  fractureWidthCI: [number, number];
  
  fractureLength: number;
  fractureLengthCI: [number, number];
  
  fractureHeight: number;
  fractureHeightCI: [number, number];
  
  // Overall confidence
  overallConfidence: number; // 0-1, based on model agreement
  
  // Model agreement analysis
  modelAgreement: ModelAgreementAnalysis;
}

/**
 * Analysis of agreement/disagreement between models
 */
export interface ModelAgreementAnalysis {
  // Overall agreement score (0-1)
  overallAgreement: number;
  
  // Per-metric agreement
  metricAgreement: {
    proppantPlacementEfficiency: number;
    fractureGeometryScore: number;
    placementUniformity: number;
    screenOutRisk: number;
  };
  
  // Opportunities where models agree (high confidence)
  agreements: OpportunityIdentification[];
  
  // Discrepancies between models (low confidence)
  discrepancies: ModelDiscrepancy[];
}

/**
 * Identified optimization opportunity
 */
export interface OpportunityIdentification {
  metric: string;
  currentValue: number;
  targetValue: number;
  improvement: number; // Percentage improvement possible
  confidence: number; // 0-1, based on model agreement
  supportingModels: ModelType[];
  reasoning: string;
}

/**
 * Discrepancy between model predictions
 */
export interface ModelDiscrepancy {
  metric: string;
  values: Record<ModelType, number | undefined>;
  standardDeviation: number;
  maxDifference: number;
  reasoning: string;
  recommendation: string;
}

/**
 * Calculate weighted average of metric values
 */
function calculateWeightedAverage(
  values: Record<ModelType, number | undefined>,
  weights: Record<ModelType, number>
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const modelType of Object.values(ModelType)) {
    const value = values[modelType];
    if (value !== undefined && !isNaN(value)) {
      weightedSum += value * weights[modelType];
      totalWeight += weights[modelType];
    }
  }
  
  // If no valid values, return 0
  if (totalWeight === 0) {
    return 0;
  }
  
  return weightedSum / totalWeight;
}

/**
 * Calculate standard deviation of metric values
 */
function calculateStandardDeviation(
  values: Record<ModelType, number | undefined>
): number {
  const validValues = Object.values(values).filter(
    v => v !== undefined && !isNaN(v)
  ) as number[];
  
  if (validValues.length < 2) {
    return 0;
  }
  
  const mean = validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
  const squaredDiffs = validValues.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / validValues.length;
  
  return Math.sqrt(variance);
}

/**
 * Calculate 95% confidence interval
 * Uses standard deviation and number of models
 */
function calculateConfidenceInterval(
  mean: number,
  stdDev: number,
  numModels: number
): [number, number] {
  // t-value for 95% confidence with small sample sizes
  const tValues: Record<number, number> = {
    1: 12.706, // Not really applicable, but included for completeness
    2: 4.303,
    3: 3.182,
  };
  
  const tValue = tValues[numModels] || 3.182;
  const marginOfError = tValue * (stdDev / Math.sqrt(numModels));
  
  return [
    Math.max(0, mean - marginOfError), // Lower bound (clamp to 0)
    Math.min(1, mean + marginOfError), // Upper bound (clamp to 1 for normalized metrics)
  ];
}

/**
 * Calculate model agreement score for a metric
 * Higher score = better agreement between models
 */
function calculateMetricAgreement(
  values: Record<ModelType, number | undefined>
): number {
  const validValues = Object.values(values).filter(
    v => v !== undefined && !isNaN(v)
  ) as number[];
  
  if (validValues.length < 2) {
    return 0; // Can't assess agreement with less than 2 models
  }
  
  const stdDev = calculateStandardDeviation(values);
  const mean = validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
  
  // Coefficient of variation (normalized standard deviation)
  const cv = mean > 0 ? stdDev / mean : 0;
  
  // Convert to agreement score (0-1)
  // Lower CV = higher agreement
  // CV > 0.5 is considered poor agreement
  return Math.max(0, 1 - (cv / 0.5));
}

/**
 * Identify optimization opportunities where models agree
 */
function identifyOpportunities(
  results: Record<ModelType, ModelExecutionResult>,
  aggregatedMetrics: Partial<AggregatedMetrics>
): OpportunityIdentification[] {
  const opportunities: OpportunityIdentification[] = [];
  
  // Check proppant placement efficiency
  const placementValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].proppantPlacementEfficiency,
    [ModelType.ROM]: results[ModelType.ROM].proppantPlacementEfficiency,
    [ModelType.CFD]: results[ModelType.CFD].proppantPlacementEfficiency,
  };
  
  const placementAgreement = calculateMetricAgreement(placementValues);
  const currentPlacement = aggregatedMetrics.proppantPlacementEfficiency || 0;
  
  // If current placement is below 0.8 and models agree, it's an opportunity
  if (currentPlacement < 0.8 && placementAgreement > 0.7) {
    const supportingModels = Object.entries(placementValues)
      .filter(([_, value]) => value !== undefined && value < 0.8)
      .map(([modelType, _]) => modelType as ModelType);
    
    opportunities.push({
      metric: 'proppantPlacementEfficiency',
      currentValue: currentPlacement,
      targetValue: 0.85,
      improvement: ((0.85 - currentPlacement) / currentPlacement) * 100,
      confidence: placementAgreement,
      supportingModels,
      reasoning: `Current proppant placement efficiency (${(currentPlacement * 100).toFixed(1)}%) is below target. All models agree on improvement potential.`,
    });
  }
  
  // Check fracture geometry score
  const geometryValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].fractureGeometryScore,
    [ModelType.ROM]: results[ModelType.ROM].fractureGeometryScore,
    [ModelType.CFD]: results[ModelType.CFD].fractureGeometryScore,
  };
  
  const geometryAgreement = calculateMetricAgreement(geometryValues);
  const currentGeometry = aggregatedMetrics.fractureGeometryScore || 0;
  
  if (currentGeometry < 0.75 && geometryAgreement > 0.7) {
    const supportingModels = Object.entries(geometryValues)
      .filter(([_, value]) => value !== undefined && value < 0.75)
      .map(([modelType, _]) => modelType as ModelType);
    
    opportunities.push({
      metric: 'fractureGeometryScore',
      currentValue: currentGeometry,
      targetValue: 0.8,
      improvement: ((0.8 - currentGeometry) / currentGeometry) * 100,
      confidence: geometryAgreement,
      supportingModels,
      reasoning: `Fracture geometry score (${(currentGeometry * 100).toFixed(1)}%) indicates suboptimal fracture shape. Models agree on optimization potential.`,
    });
  }
  
  // Check placement uniformity
  const uniformityValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].placementUniformity,
    [ModelType.ROM]: results[ModelType.ROM].placementUniformity,
    [ModelType.CFD]: results[ModelType.CFD].placementUniformity,
  };
  
  const uniformityAgreement = calculateMetricAgreement(uniformityValues);
  const currentUniformity = aggregatedMetrics.placementUniformity || 0;
  
  if (currentUniformity < 0.7 && uniformityAgreement > 0.7) {
    const supportingModels = Object.entries(uniformityValues)
      .filter(([_, value]) => value !== undefined && value < 0.7)
      .map(([modelType, _]) => modelType as ModelType);
    
    opportunities.push({
      metric: 'placementUniformity',
      currentValue: currentUniformity,
      targetValue: 0.8,
      improvement: ((0.8 - currentUniformity) / currentUniformity) * 100,
      confidence: uniformityAgreement,
      supportingModels,
      reasoning: `Proppant placement uniformity (${(currentUniformity * 100).toFixed(1)}%) shows uneven distribution. Improving uniformity will enhance production.`,
    });
  }
  
  return opportunities;
}

/**
 * Identify discrepancies between model predictions
 */
function identifyDiscrepancies(
  results: Record<ModelType, ModelExecutionResult>
): ModelDiscrepancy[] {
  const discrepancies: ModelDiscrepancy[] = [];
  
  // Check each metric for significant disagreement
  const metricsToCheck = [
    {
      name: 'proppantPlacementEfficiency',
      getter: (r: ModelExecutionResult) => r.proppantPlacementEfficiency,
    },
    {
      name: 'fractureGeometryScore',
      getter: (r: ModelExecutionResult) => r.fractureGeometryScore,
    },
    {
      name: 'placementUniformity',
      getter: (r: ModelExecutionResult) => r.placementUniformity,
    },
    {
      name: 'screenOutRisk',
      getter: (r: ModelExecutionResult) => r.screenOutRisk,
    },
  ];
  
  for (const metric of metricsToCheck) {
    const values: Record<ModelType, number | undefined> = {
      [ModelType.PHYSICS]: metric.getter(results[ModelType.PHYSICS]),
      [ModelType.ROM]: metric.getter(results[ModelType.ROM]),
      [ModelType.CFD]: metric.getter(results[ModelType.CFD]),
    };
    
    const validValues = Object.values(values).filter(
      v => v !== undefined && !isNaN(v)
    ) as number[];
    
    if (validValues.length < 2) {
      continue; // Can't assess discrepancy with less than 2 models
    }
    
    const stdDev = calculateStandardDeviation(values);
    const mean = validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
    const cv = mean > 0 ? stdDev / mean : 0;
    
    // Flag as discrepancy if coefficient of variation > 0.3 (30%)
    if (cv > 0.3) {
      const maxValue = Math.max(...validValues);
      const minValue = Math.min(...validValues);
      const maxDifference = maxValue - minValue;
      
      discrepancies.push({
        metric: metric.name,
        values,
        standardDeviation: stdDev,
        maxDifference,
        reasoning: `Models show significant disagreement on ${metric.name} (CV: ${(cv * 100).toFixed(1)}%). This indicates uncertainty in predictions.`,
        recommendation: `Consider running additional CFD iterations or validating model assumptions. Trust CFD results more heavily (weight: 0.5) due to higher fidelity.`,
      });
    }
  }
  
  return discrepancies;
}

/**
 * Aggregate multi-fidelity model results into unified optimization assessment
 * 
 * Requirements: 4.3, 6.4, 6.6
 */
export function aggregateResults(
  results: Record<ModelType, ModelExecutionResult>
): AggregatedMetrics {
  console.log('Aggregating multi-fidelity model results');
  
  // Extract metric values from each model
  const proppantPlacementValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].proppantPlacementEfficiency,
    [ModelType.ROM]: results[ModelType.ROM].proppantPlacementEfficiency,
    [ModelType.CFD]: results[ModelType.CFD].proppantPlacementEfficiency,
  };
  
  const fractureGeometryValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].fractureGeometryScore,
    [ModelType.ROM]: results[ModelType.ROM].fractureGeometryScore,
    [ModelType.CFD]: results[ModelType.CFD].fractureGeometryScore,
  };
  
  const placementUniformityValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].placementUniformity,
    [ModelType.ROM]: results[ModelType.ROM].placementUniformity,
    [ModelType.CFD]: results[ModelType.CFD].placementUniformity,
  };
  
  const nearWellboreValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].nearWellboreConcentration,
    [ModelType.ROM]: results[ModelType.ROM].nearWellboreConcentration,
    [ModelType.CFD]: results[ModelType.CFD].nearWellboreConcentration,
  };
  
  const screenOutRiskValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].screenOutRisk,
    [ModelType.ROM]: results[ModelType.ROM].screenOutRisk,
    [ModelType.CFD]: results[ModelType.CFD].screenOutRisk,
  };
  
  const fractureWidthValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].fractureWidth,
    [ModelType.ROM]: results[ModelType.ROM].fractureWidth,
    [ModelType.CFD]: results[ModelType.CFD].fractureWidth,
  };
  
  const fractureLengthValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].fractureLength,
    [ModelType.ROM]: results[ModelType.ROM].fractureLength,
    [ModelType.CFD]: results[ModelType.CFD].fractureLength,
  };
  
  const fractureHeightValues: Record<ModelType, number | undefined> = {
    [ModelType.PHYSICS]: results[ModelType.PHYSICS].fractureHeight,
    [ModelType.ROM]: results[ModelType.ROM].fractureHeight,
    [ModelType.CFD]: results[ModelType.CFD].fractureHeight,
  };
  
  // Calculate weighted averages
  const proppantPlacement = calculateWeightedAverage(proppantPlacementValues, MODEL_WEIGHTS);
  const fractureGeometry = calculateWeightedAverage(fractureGeometryValues, MODEL_WEIGHTS);
  const placementUniformity = calculateWeightedAverage(placementUniformityValues, MODEL_WEIGHTS);
  const nearWellbore = calculateWeightedAverage(nearWellboreValues, MODEL_WEIGHTS);
  const screenOutRisk = calculateWeightedAverage(screenOutRiskValues, MODEL_WEIGHTS);
  const fractureWidth = calculateWeightedAverage(fractureWidthValues, MODEL_WEIGHTS);
  const fractureLength = calculateWeightedAverage(fractureLengthValues, MODEL_WEIGHTS);
  const fractureHeight = calculateWeightedAverage(fractureHeightValues, MODEL_WEIGHTS);
  
  // Calculate standard deviations
  const proppantPlacementStdDev = calculateStandardDeviation(proppantPlacementValues);
  const fractureGeometryStdDev = calculateStandardDeviation(fractureGeometryValues);
  const placementUniformityStdDev = calculateStandardDeviation(placementUniformityValues);
  const nearWellboreStdDev = calculateStandardDeviation(nearWellboreValues);
  const screenOutRiskStdDev = calculateStandardDeviation(screenOutRiskValues);
  const fractureWidthStdDev = calculateStandardDeviation(fractureWidthValues);
  const fractureLengthStdDev = calculateStandardDeviation(fractureLengthValues);
  const fractureHeightStdDev = calculateStandardDeviation(fractureHeightValues);
  
  // Count number of successful models
  const numSuccessfulModels = Object.values(results).filter(r => r.success).length;
  
  // Calculate confidence intervals
  const proppantPlacementCI = calculateConfidenceInterval(
    proppantPlacement,
    proppantPlacementStdDev,
    numSuccessfulModels
  );
  const fractureGeometryCI = calculateConfidenceInterval(
    fractureGeometry,
    fractureGeometryStdDev,
    numSuccessfulModels
  );
  const placementUniformityCI = calculateConfidenceInterval(
    placementUniformity,
    placementUniformityStdDev,
    numSuccessfulModels
  );
  const nearWellboreCI = calculateConfidenceInterval(
    nearWellbore,
    nearWellboreStdDev,
    numSuccessfulModels
  );
  const screenOutRiskCI = calculateConfidenceInterval(
    screenOutRisk,
    screenOutRiskStdDev,
    numSuccessfulModels
  );
  
  // For fracture dimensions, use absolute values for CI
  const fractureWidthCI: [number, number] = [
    Math.max(0, fractureWidth - fractureWidthStdDev),
    fractureWidth + fractureWidthStdDev,
  ];
  const fractureLengthCI: [number, number] = [
    Math.max(0, fractureLength - fractureLengthStdDev),
    fractureLength + fractureLengthStdDev,
  ];
  const fractureHeightCI: [number, number] = [
    Math.max(0, fractureHeight - fractureHeightStdDev),
    fractureHeight + fractureHeightStdDev,
  ];
  
  // Calculate per-metric agreement
  const proppantAgreement = calculateMetricAgreement(proppantPlacementValues);
  const geometryAgreement = calculateMetricAgreement(fractureGeometryValues);
  const uniformityAgreement = calculateMetricAgreement(placementUniformityValues);
  const riskAgreement = calculateMetricAgreement(screenOutRiskValues);
  
  // Calculate overall agreement (average of metric agreements)
  const overallAgreement = (
    proppantAgreement +
    geometryAgreement +
    uniformityAgreement +
    riskAgreement
  ) / 4;
  
  // Overall confidence based on:
  // 1. Number of successful models (more models = higher confidence)
  // 2. Model agreement (higher agreement = higher confidence)
  const modelCountFactor = numSuccessfulModels / 3; // 0-1
  const overallConfidence = (modelCountFactor * 0.4) + (overallAgreement * 0.6);
  
  // Build partial aggregated metrics for opportunity identification
  const partialMetrics: Partial<AggregatedMetrics> = {
    proppantPlacementEfficiency: proppantPlacement,
    fractureGeometryScore: fractureGeometry,
    placementUniformity: placementUniformity,
    screenOutRisk: screenOutRisk,
  };
  
  // Identify opportunities and discrepancies
  const agreements = identifyOpportunities(results, partialMetrics);
  const discrepancies = identifyDiscrepancies(results);
  
  // Build model agreement analysis
  const modelAgreement: ModelAgreementAnalysis = {
    overallAgreement,
    metricAgreement: {
      proppantPlacementEfficiency: proppantAgreement,
      fractureGeometryScore: geometryAgreement,
      placementUniformity: uniformityAgreement,
      screenOutRisk: riskAgreement,
    },
    agreements,
    discrepancies,
  };
  
  console.log(`Aggregation complete: ${numSuccessfulModels}/3 models, overall confidence: ${(overallConfidence * 100).toFixed(1)}%`);
  console.log(`Identified ${agreements.length} opportunities and ${discrepancies.length} discrepancies`);
  
  return {
    proppantPlacementEfficiency: proppantPlacement,
    proppantPlacementEfficiencyCI: proppantPlacementCI,
    
    fractureGeometryScore: fractureGeometry,
    fractureGeometryScoreCI: fractureGeometryCI,
    
    placementUniformity: placementUniformity,
    placementUniformityCI: placementUniformityCI,
    
    nearWellboreConcentration: nearWellbore,
    nearWellboreConcentrationCI: nearWellboreCI,
    
    screenOutRisk: screenOutRisk,
    screenOutRiskCI: screenOutRiskCI,
    
    fractureWidth: fractureWidth,
    fractureWidthCI: fractureWidthCI,
    
    fractureLength: fractureLength,
    fractureLengthCI: fractureLengthCI,
    
    fractureHeight: fractureHeight,
    fractureHeightCI: fractureHeightCI,
    
    overallConfidence: overallConfidence,
    
    modelAgreement: modelAgreement,
  };
}
