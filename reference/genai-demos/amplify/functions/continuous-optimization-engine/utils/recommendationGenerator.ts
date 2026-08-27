/**
 * Recommendation Generator Utility
 * 
 * Analyzes optimization results to generate actionable recommendations for improving
 * hydraulic fracturing operations. This utility:
 * 
 * 1. Analyzes trends in optimization metrics (proppant placement efficiency, fracture geometry score, etc.)
 * 2. Identifies opportunities for improvement
 * 3. Generates specific parameter adjustments (injection rate, proppant concentration, fluid viscosity)
 * 4. Calculates confidence scores based on model agreement and data quality
 * 5. Estimates expected improvements
 * 6. Assigns priority levels (CRITICAL, HIGH, MEDIUM, LOW)
 * 
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

/**
 * Optimization metrics from multi-fidelity model results
 */
export interface OptimizationMetrics {
  proppantPlacementEfficiency: number;  // 0-1
  fractureGeometryScore: number;        // 0-1
  placementUniformity: number;          // 0-1
  screenOutRisk: number;                // 0-1 (secondary metric)
}

/**
 * Current operation parameters
 */
export interface OperationParameters {
  injectionRate: number;                // m³/s
  proppantConcentration: number;        // volume fraction
  fluidViscosity: number;               // Pa·s
  treatingPressure: number;             // psi
  fractureLengthM?: number;             // meters
  fractureWidthMm?: number;             // millimeters
}

/**
 * Model result for confidence calculation
 */
export interface ModelResult {
  modelType: 'PHYSICS' | 'ROM' | 'CFD';
  confidence: number;                   // 0-1
  placementEfficiency: number;          // 0-1
  fractureWidth: number;                // meters
  fractureLength: number;               // meters
  fractureHeight: number;               // meters
}

/**
 * Historical trend data for trend analysis
 */
export interface TrendData {
  previousMetrics?: OptimizationMetrics;
  iterationNumber: number;
}

/**
 * Generated recommendation
 */
export interface Recommendation {
  type: 'INCREASE_PROPPANT_PLACEMENT' | 'IMPROVE_FRACTURE_GEOMETRY' | 
        'OPTIMIZE_INJECTION_RATE' | 'ADJUST_PROPPANT_CONCENTRATION' | 
        'MODIFY_STAGE_PLAN' | 'EXTEND_PUMPING_TIME';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  description: string;
  reasoning: string;
  parameterAdjustments: ParameterAdjustment[];
  expectedImprovements: ExpectedImprovements;
  supportingModels: Array<'PHYSICS' | 'ROM' | 'CFD'>;
  confidence: number;                   // 0-1
}

/**
 * Specific parameter adjustment
 */
export interface ParameterAdjustment {
  parameter: string;
  currentValue: number;
  recommendedValue: number;
  changePercent: number;
  unit: string;
}

/**
 * Expected improvements from implementing recommendation
 */
export interface ExpectedImprovements {
  proppantPlacementIncrease?: number;   // Percentage increase
  fractureGeometryImprovement?: number; // Percentage improvement
  screenOutRiskReduction?: number;      // Percentage reduction
  estimatedProductionIncrease?: number; // Percentage increase
}

/**
 * Configuration for recommendation generation
 */
export interface RecommendationConfig {
  // Thresholds for identifying opportunities
  minProppantPlacementEfficiency: number;     // Default: 0.85
  minFractureGeometryScore: number;           // Default: 0.80
  minPlacementUniformity: number;             // Default: 0.75
  
  // Confidence thresholds
  minConfidenceForRecommendation: number;     // Default: 0.6
  highConfidenceThreshold: number;            // Default: 0.8
  
  // Improvement thresholds
  minImprovementForRecommendation: number;    // Default: 5% (0.05)
  significantImprovementThreshold: number;    // Default: 15% (0.15)
  criticalImprovementThreshold: number;       // Default: 20% (0.20)
  
  // Trend analysis
  enableTrendAnalysis: boolean;               // Default: true
  trendDeclineThreshold: number;              // Default: -0.05 (-5%)
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: RecommendationConfig = {
  minProppantPlacementEfficiency: 0.85,
  minFractureGeometryScore: 0.80,
  minPlacementUniformity: 0.75,
  minConfidenceForRecommendation: 0.6,
  highConfidenceThreshold: 0.8,
  minImprovementForRecommendation: 0.05,
  significantImprovementThreshold: 0.15,
  criticalImprovementThreshold: 0.20,
  enableTrendAnalysis: true,
  trendDeclineThreshold: -0.05,
};

/**
 * Generate optimization recommendations based on current metrics and trends
 * 
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 * 
 * @param metrics Current optimization metrics
 * @param parameters Current operation parameters
 * @param modelResults Results from available models (for confidence calculation)
 * @param trendData Historical data for trend analysis (optional)
 * @param config Configuration for recommendation generation (optional)
 * @returns Array of recommendations sorted by priority
 */
export function generateRecommendations(
  metrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  trendData?: TrendData,
  config: Partial<RecommendationConfig> = {}
): Recommendation[] {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const recommendations: Recommendation[] = [];

  // Calculate base confidence from model agreement
  const baseConfidence = calculateModelAgreementConfidence(modelResults);

  // Requirement 10.1: Analyze proppant placement efficiency trends
  const placementRecommendation = analyzeProppantPlacement(
    metrics,
    parameters,
    modelResults,
    baseConfidence,
    fullConfig
  );
  if (placementRecommendation) {
    recommendations.push(placementRecommendation);
  }

  // Requirement 10.2: Identify fracture geometry optimization opportunities
  const geometryRecommendation = analyzeFractureGeometry(
    metrics,
    parameters,
    modelResults,
    baseConfidence,
    fullConfig
  );
  if (geometryRecommendation) {
    recommendations.push(geometryRecommendation);
  }

  // Requirement 10.3: Detect pressure response signals for stage plan adjustments
  if (fullConfig.enableTrendAnalysis && trendData?.previousMetrics) {
    const trendRecommendation = analyzeTrends(
      metrics,
      trendData.previousMetrics,
      parameters,
      modelResults,
      baseConfidence,
      fullConfig
    );
    if (trendRecommendation) {
      recommendations.push(trendRecommendation);
    }
  }

  // Analyze placement uniformity
  const uniformityRecommendation = analyzePlacementUniformity(
    metrics,
    parameters,
    modelResults,
    baseConfidence,
    fullConfig
  );
  if (uniformityRecommendation) {
    recommendations.push(uniformityRecommendation);
  }

  // Identify opportunities for extended pumping when conditions are optimal
  const extendedPumpingRecommendation = analyzeExtendedPumpingOpportunity(
    metrics,
    parameters,
    modelResults,
    baseConfidence,
    fullConfig
  );
  if (extendedPumpingRecommendation) {
    recommendations.push(extendedPumpingRecommendation);
  }

  // Requirement 10.6: Determine recommendation priority based on impact and confidence
  // Sort by priority (CRITICAL > HIGH > MEDIUM > LOW) and then by confidence
  return sortRecommendationsByPriority(recommendations);
}

/**
 * Requirement 10.4: Calculate confidence scores based on model agreement and data quality
 * 
 * Confidence is based on:
 * - Number of models available (more models = higher confidence)
 * - Agreement between models (similar results = higher confidence)
 * - Individual model confidence scores
 */
function calculateModelAgreementConfidence(modelResults: ModelResult[]): number {
  if (modelResults.length === 0) {
    return 0;
  }

  // Base confidence from number of models (0.33 per model)
  const modelCountConfidence = modelResults.length / 3;

  // Average individual model confidence
  const avgModelConfidence = modelResults.reduce((sum, m) => sum + m.confidence, 0) / modelResults.length;

  // Calculate agreement between models (variance in placement efficiency)
  let agreementConfidence = 1.0;
  if (modelResults.length > 1) {
    const efficiencies = modelResults.map((m) => m.placementEfficiency);
    const avgEfficiency = efficiencies.reduce((sum, e) => sum + e, 0) / efficiencies.length;
    const variance = efficiencies.reduce((sum, e) => sum + Math.pow(e - avgEfficiency, 2), 0) / efficiencies.length;
    const stdDev = Math.sqrt(variance);
    
    // Lower standard deviation = higher agreement
    // Penalize confidence if stdDev > 0.1 (10% disagreement)
    agreementConfidence = Math.max(0, 1.0 - (stdDev / 0.1));
  }

  // Weighted combination
  const confidence = (modelCountConfidence * 0.4) + (avgModelConfidence * 0.3) + (agreementConfidence * 0.3);

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Requirement 10.1: Analyze proppant placement efficiency trends
 */
function analyzeProppantPlacement(
  metrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  baseConfidence: number,
  config: RecommendationConfig
): Recommendation | null {
  const { proppantPlacementEfficiency } = metrics;
  const { minProppantPlacementEfficiency, minConfidenceForRecommendation } = config;

  // Check if placement efficiency is below target
  if (proppantPlacementEfficiency >= minProppantPlacementEfficiency) {
    return null;
  }

  const improvementPotential = minProppantPlacementEfficiency - proppantPlacementEfficiency;

  // Check if improvement is significant enough
  if (improvementPotential < config.minImprovementForRecommendation) {
    return null;
  }

  // Check confidence threshold
  if (baseConfidence < minConfidenceForRecommendation) {
    return null;
  }

  // Requirement 10.3: Generate specific parameter recommendations
  // Increase injection rate to improve proppant transport
  const currentRate = parameters.injectionRate;
  const rateIncrease = Math.min(0.15, improvementPotential * 0.2); // Cap at 15% increase
  const recommendedRate = currentRate * (1 + rateIncrease);

  // Requirement 10.6: Determine priority based on impact and confidence
  const priority = determinePriority(improvementPotential, baseConfidence, config);

  // Requirement 10.5: Calculate expected improvement metrics
  const expectedImprovements: ExpectedImprovements = {
    proppantPlacementIncrease: improvementPotential * 100,
    estimatedProductionIncrease: improvementPotential * 50, // Conservative: 50% of placement improvement
  };

  return {
    type: 'INCREASE_PROPPANT_PLACEMENT',
    priority,
    title: 'Increase Proppant Placement Efficiency',
    description: `Proppant placement efficiency is ${(proppantPlacementEfficiency * 100).toFixed(1)}%, below optimal ${(minProppantPlacementEfficiency * 100).toFixed(0)}%`,
    reasoning: `Increasing injection rate will improve proppant transport to the near-wellbore region. Current placement efficiency indicates ${(improvementPotential * 100).toFixed(1)}% improvement potential.`,
    parameterAdjustments: [
      {
        parameter: 'injectionRate',
        currentValue: currentRate,
        recommendedValue: recommendedRate,
        changePercent: rateIncrease * 100,
        unit: 'm³/s',
      },
    ],
    expectedImprovements,
    supportingModels: modelResults.map((m) => m.modelType),
    confidence: baseConfidence,
  };
}

/**
 * Requirement 10.2: Identify fracture geometry optimization opportunities
 */
function analyzeFractureGeometry(
  metrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  baseConfidence: number,
  config: RecommendationConfig
): Recommendation | null {
  const { fractureGeometryScore } = metrics;
  const { minFractureGeometryScore, minConfidenceForRecommendation } = config;

  // Check if geometry score is below target
  if (fractureGeometryScore >= minFractureGeometryScore) {
    return null;
  }

  const improvementPotential = minFractureGeometryScore - fractureGeometryScore;

  // Check if improvement is significant enough
  if (improvementPotential < config.minImprovementForRecommendation) {
    return null;
  }

  // Check confidence threshold
  if (baseConfidence < minConfidenceForRecommendation) {
    return null;
  }

  // Analyze fracture dimensions from model results to determine best adjustment
  const avgWidth = modelResults.reduce((sum, m) => sum + m.fractureWidth, 0) / modelResults.length;
  const avgLength = modelResults.reduce((sum, m) => sum + m.fractureLength, 0) / modelResults.length;

  // Determine if width or length is limiting factor
  const targetWidth = 0.005; // 5mm
  const targetLength = 100;  // 100m
  
  const widthDeficit = Math.max(0, (targetWidth - avgWidth) / targetWidth);
  const lengthDeficit = Math.max(0, (targetLength - avgLength) / targetLength);

  // Adjust fluid viscosity to improve fracture width (primary concern)
  const currentViscosity = parameters.fluidViscosity;
  const viscosityIncrease = Math.min(0.12, improvementPotential * 0.15); // Cap at 12% increase
  const recommendedViscosity = currentViscosity * (1 + viscosityIncrease);

  const priority = determinePriority(improvementPotential, baseConfidence * 0.9, config);

  const expectedImprovements: ExpectedImprovements = {
    fractureGeometryImprovement: improvementPotential * 100,
    estimatedProductionIncrease: improvementPotential * 40, // Conservative: 40% of geometry improvement
  };

  return {
    type: 'IMPROVE_FRACTURE_GEOMETRY',
    priority,
    title: 'Optimize Fracture Geometry',
    description: `Fracture geometry score is ${(fractureGeometryScore * 100).toFixed(1)}%, below optimal ${(minFractureGeometryScore * 100).toFixed(0)}%`,
    reasoning: `Increasing fluid viscosity will improve fracture width and overall geometry. Current width is ${(avgWidth * 1000).toFixed(2)}mm (target: ${(targetWidth * 1000).toFixed(0)}mm), length is ${avgLength.toFixed(1)}m (target: ${targetLength}m).`,
    parameterAdjustments: [
      {
        parameter: 'fluidViscosity',
        currentValue: currentViscosity,
        recommendedValue: recommendedViscosity,
        changePercent: viscosityIncrease * 100,
        unit: 'Pa·s',
      },
    ],
    expectedImprovements,
    supportingModels: modelResults.map((m) => m.modelType),
    confidence: baseConfidence * 0.9, // Slightly lower confidence for geometry predictions
  };
}

/**
 * Requirement 10.3: Detect pressure response signals for stage plan adjustments
 * 
 * Analyzes trends between iterations to identify declining performance
 */
function analyzeTrends(
  currentMetrics: OptimizationMetrics,
  previousMetrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  baseConfidence: number,
  config: RecommendationConfig
): Recommendation | null {
  const { trendDeclineThreshold, minConfidenceForRecommendation } = config;

  // Calculate trend in proppant placement efficiency
  const efficiencyTrend = currentMetrics.proppantPlacementEfficiency - previousMetrics.proppantPlacementEfficiency;

  // Check if efficiency is declining significantly
  if (efficiencyTrend >= trendDeclineThreshold) {
    return null;
  }

  // Check confidence threshold
  if (baseConfidence < minConfidenceForRecommendation) {
    return null;
  }

  // Declining efficiency suggests need to reduce injection rate
  const currentRate = parameters.injectionRate;
  const rateReduction = 0.08; // 8% reduction
  const recommendedRate = currentRate * (1 - rateReduction);

  const improvementPotential = Math.abs(efficiencyTrend);
  const priority = determinePriority(improvementPotential, baseConfidence * 0.85, config);

  const expectedImprovements: ExpectedImprovements = {
    proppantPlacementIncrease: improvementPotential * 100,
    estimatedProductionIncrease: improvementPotential * 45,
  };

  return {
    type: 'OPTIMIZE_INJECTION_RATE',
    priority,
    title: 'Stabilize Declining Placement Efficiency',
    description: `Proppant placement efficiency declining by ${(Math.abs(efficiencyTrend) * 100).toFixed(1)}% per iteration`,
    reasoning: `Reducing injection rate will stabilize proppant transport and prevent further efficiency decline. Current trend indicates ${(improvementPotential * 100).toFixed(1)}% recovery potential.`,
    parameterAdjustments: [
      {
        parameter: 'injectionRate',
        currentValue: currentRate,
        recommendedValue: recommendedRate,
        changePercent: -rateReduction * 100,
        unit: 'm³/s',
      },
    ],
    expectedImprovements,
    supportingModels: modelResults.map((m) => m.modelType),
    confidence: baseConfidence * 0.85, // Slightly lower confidence for trend-based predictions
  };
}

/**
 * Analyze placement uniformity and recommend adjustments
 */
function analyzePlacementUniformity(
  metrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  baseConfidence: number,
  config: RecommendationConfig
): Recommendation | null {
  const { placementUniformity } = metrics;
  const { minPlacementUniformity, minConfidenceForRecommendation } = config;

  // Check if uniformity is below target
  if (placementUniformity >= minPlacementUniformity) {
    return null;
  }

  const improvementPotential = minPlacementUniformity - placementUniformity;

  // Check if improvement is significant enough
  if (improvementPotential < config.minImprovementForRecommendation) {
    return null;
  }

  // Check confidence threshold
  if (baseConfidence < minConfidenceForRecommendation) {
    return null;
  }

  // Increase proppant concentration gradually to improve uniformity
  const currentConcentration = parameters.proppantConcentration;
  const concentrationIncrease = Math.min(0.10, improvementPotential * 0.12); // Cap at 10% increase
  const recommendedConcentration = currentConcentration * (1 + concentrationIncrease);

  const priority = determinePriority(improvementPotential, baseConfidence * 0.8, config);

  const expectedImprovements: ExpectedImprovements = {
    proppantPlacementIncrease: improvementPotential * 80, // Uniformity strongly affects placement
    estimatedProductionIncrease: improvementPotential * 35,
  };

  return {
    type: 'ADJUST_PROPPANT_CONCENTRATION',
    priority,
    title: 'Improve Proppant Placement Uniformity',
    description: `Placement uniformity is ${(placementUniformity * 100).toFixed(1)}%, indicating uneven distribution`,
    reasoning: `Gradually increasing proppant concentration will improve distribution uniformity. Current uniformity indicates ${(improvementPotential * 100).toFixed(1)}% improvement potential.`,
    parameterAdjustments: [
      {
        parameter: 'proppantConcentration',
        currentValue: currentConcentration,
        recommendedValue: recommendedConcentration,
        changePercent: concentrationIncrease * 100,
        unit: 'volume fraction',
      },
    ],
    expectedImprovements,
    supportingModels: modelResults.map((m) => m.modelType),
    confidence: baseConfidence * 0.8,
  };
}

/**
 * Identify opportunities for extended pumping when all conditions are optimal
 */
function analyzeExtendedPumpingOpportunity(
  metrics: OptimizationMetrics,
  parameters: OperationParameters,
  modelResults: ModelResult[],
  baseConfidence: number,
  config: RecommendationConfig
): Recommendation | null {
  const {
    proppantPlacementEfficiency,
    fractureGeometryScore,
    placementUniformity,
    screenOutRisk,
  } = metrics;

  const {
    minProppantPlacementEfficiency,
    minFractureGeometryScore,
    minPlacementUniformity,
    minConfidenceForRecommendation,
  } = config;

  // Check if all metrics are above target and risk is low
  const allMetricsOptimal =
    proppantPlacementEfficiency > minProppantPlacementEfficiency &&
    fractureGeometryScore > minFractureGeometryScore &&
    placementUniformity > minPlacementUniformity &&
    screenOutRisk < 0.3; // Low risk threshold

  if (!allMetricsOptimal) {
    return null;
  }

  // Check confidence threshold
  if (baseConfidence < minConfidenceForRecommendation) {
    return null;
  }

  // Calculate how much better than target we are
  const placementExcess = proppantPlacementEfficiency - minProppantPlacementEfficiency;
  const geometryExcess = fractureGeometryScore - minFractureGeometryScore;
  const uniformityExcess = placementUniformity - minPlacementUniformity;
  
  const avgExcess = (placementExcess + geometryExcess + uniformityExcess) / 3;

  // Recommend extending pumping time
  const baselineDuration = 60; // Assume 60 minutes baseline
  const extensionPercent = Math.min(0.25, avgExcess * 0.5); // Cap at 25% extension
  const recommendedDuration = baselineDuration * (1 + extensionPercent);

  const priority = determinePriority(avgExcess, baseConfidence, config);

  const expectedImprovements: ExpectedImprovements = {
    estimatedProductionIncrease: 15, // Extended pumping under optimal conditions
  };

  return {
    type: 'EXTEND_PUMPING_TIME',
    priority,
    title: 'Extend Pumping Under Optimal Conditions',
    description: 'All optimization metrics are above target, favorable conditions for extended pumping',
    reasoning: `Current conditions are optimal for fracture development. Extending stage duration will maximize fracture development and production potential. Placement efficiency: ${(proppantPlacementEfficiency * 100).toFixed(1)}%, geometry: ${(fractureGeometryScore * 100).toFixed(1)}%, uniformity: ${(placementUniformity * 100).toFixed(1)}%.`,
    parameterAdjustments: [
      {
        parameter: 'stageDuration',
        currentValue: baselineDuration,
        recommendedValue: recommendedDuration,
        changePercent: extensionPercent * 100,
        unit: 'minutes',
      },
    ],
    expectedImprovements,
    supportingModels: modelResults.map((m) => m.modelType),
    confidence: baseConfidence,
  };
}

/**
 * Requirement 10.6: Determine recommendation priority based on impact and confidence
 */
function determinePriority(
  improvementPotential: number,
  confidence: number,
  config: RecommendationConfig
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const { criticalImprovementThreshold, significantImprovementThreshold, highConfidenceThreshold } = config;

  // CRITICAL: High improvement potential + high confidence
  if (improvementPotential > criticalImprovementThreshold && confidence > highConfidenceThreshold) {
    return 'CRITICAL';
  }

  // HIGH: Significant improvement + good confidence
  if (improvementPotential > significantImprovementThreshold && confidence > 0.7) {
    return 'HIGH';
  }

  // MEDIUM: Moderate improvement or moderate confidence
  if (improvementPotential > 0.10 || confidence > 0.7) {
    return 'MEDIUM';
  }

  // LOW: Small improvement or lower confidence
  return 'LOW';
}

/**
 * Sort recommendations by priority and confidence
 */
function sortRecommendationsByPriority(recommendations: Recommendation[]): Recommendation[] {
  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  return recommendations.sort((a, b) => {
    // First sort by priority
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    // Then sort by confidence (descending)
    return b.confidence - a.confidence;
  });
}
