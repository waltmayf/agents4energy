import { a } from '@aws-amplify/backend';
import { startContinuousOptimization, stopContinuousOptimization, getOptimizationRecommendations } from '../../functions/continuous-optimization-engine/resource';
import { submitCfdSimulation, getCfdJobStatus, getCfdResults, cancelCfdJob } from '../../functions/cfd-simulation-manager/resource';

/**
 * Continuous Optimization Schema
 * Models for real-time hydraulic fracturing optimization using multi-fidelity modeling
 * 
 * This schema supports continuous optimization workflows that run parallel models:
 * - Simplified Physics Model (<1s latency)
 * - ML Surrogate/ROM (<30s latency)
 * - Full CFD Simulation (minutes latency)
 * 
 * The system generates proactive recommendations for improving proppant placement
 * and fracture geometry, with screen-out risk as a secondary consideration.
 */
export const optimizationSchema = a.schema({
  
  // ============================================================================
  // ENUMS
  // ============================================================================
  
  OptimizationStatus: a.enum([
    'INITIALIZING',    // Setting up optimization session
    'ACTIVE',          // Actively running optimization
    'PAUSED',          // Temporarily paused
    'STOPPED',         // User stopped
    'FAILED'           // Error occurred
  ]),
  
  ModelType: a.enum([
    'PHYSICS',         // Simplified physics model
    'ROM',             // Reduced-order model / ML surrogate
    'CFD'              // Full CFD simulation
  ]),
  
  OpportunityType: a.enum([
    'INCREASE_PROPPANT_PLACEMENT',  // Improve near-wellbore sand placement
    'IMPROVE_FRACTURE_GEOMETRY',    // Optimize fracture width/length/height
    'OPTIMIZE_INJECTION_RATE',      // Adjust injection rate for better results
    'ADJUST_PROPPANT_CONCENTRATION', // Modify proppant concentration
    'MODIFY_STAGE_PLAN',            // Change stage plan parameters
    'EXTEND_PUMPING_TIME'           // Extend pumping duration
  ]),
  
  RecommendationPriority: a.enum([
    'LOW',             // Minor optimization opportunity
    'MEDIUM',          // Moderate improvement potential
    'HIGH',            // Significant improvement opportunity
    'CRITICAL'         // Urgent action recommended
  ]),
  
  RecommendationStatus: a.enum([
    'PENDING',         // Awaiting review
    'REVIEWED',        // Reviewed by engineer
    'APPROVED',        // Approved for implementation
    'IMPLEMENTED',     // Applied to operation
    'REJECTED'         // Rejected by engineer
  ]),
  
  UpdateType: a.enum([
    'NEW_RESULT',      // New optimization result available
    'NEW_RECOMMENDATION', // New recommendation generated
    'STATUS_CHANGE',   // Session status changed
    'PARAMETER_UPDATE' // Parameters updated
  ]),
  
  JobStatus: a.enum([
    'PENDING',         // Queued in Slurm
    'RUNNING',         // Currently executing
    'COMPLETED',       // Successfully finished
    'FAILED',          // Error occurred
    'CANCELLED'        // User cancelled
  ]),
  
  // ============================================================================
  // CUSTOM TYPES
  // ============================================================================
  
  // Operation parameters for fracturing
  OperationParameters: a.customType({
    injectionRate: a.float().required(),           // m³/s
    proppantConcentration: a.float().required(),   // volume fraction
    fluidViscosity: a.float().required(),          // Pa·s
    treatingPressure: a.float().required(),        // psi
    fractureLengthM: a.float(),                    // meters
    fractureWidthMm: a.float(),                    // millimeters
  }),
  
  // Optimization goals configuration
  OptimizationGoals: a.customType({
    maximizeProppantPlacement: a.boolean().required(),
    optimizeFractureGeometry: a.boolean().required(),
    minimizeScreenOutRisk: a.boolean().required(),
  }),
  
  // Simulation configuration for prototype
  SimulationConfig: a.customType({
    operationDurationHours: a.float(),             // Default: 4 hours
    sensorUpdateFrequencyHz: a.float(),            // Default: 1 Hz
    enableRealisticNoise: a.boolean(),             // Default: true
  }),
  
  // Results from a single model execution
  ModelResult: a.customType({
    modelType: a.ref('ModelType').required(),
    executionTimeMs: a.integer().required(),
    confidence: a.float().required(),              // 0-1
    
    // Proppant metrics
    nearWellboreConcentration: a.float().required(),
    placementEfficiency: a.float().required(),     // 0-1
    
    // Fracture metrics
    fractureWidth: a.float().required(),           // meters
    fractureLength: a.float().required(),          // meters
    fractureHeight: a.float().required(),          // meters
    
    // Risk metrics (secondary)
    screenOutRisk: a.float().required(),           // 0-1
    timeToScreenOutSeconds: a.integer(),
  }),
  
  // Optimization opportunity identified
  OptimizationOpportunity: a.customType({
    type: a.ref('OpportunityType').required(),
    description: a.string().required(),
    confidence: a.float().required(),              // 0-1
    expectedImprovement: a.float().required(),     // Percentage improvement
    recommendation: a.string().required(),
  }),
  
  // Specific parameter adjustment recommendation
  ParameterAdjustment: a.customType({
    parameter: a.string().required(),              // Parameter name
    currentValue: a.float().required(),
    recommendedValue: a.float().required(),
    changePercent: a.float().required(),
    unit: a.string().required(),
  }),
  
  // Expected improvements from implementing recommendation
  ExpectedImprovements: a.customType({
    proppantPlacementIncrease: a.float(),          // Percentage increase
    fractureGeometryImprovement: a.float(),        // Percentage improvement
    screenOutRiskReduction: a.float(),             // Percentage reduction
    estimatedProductionIncrease: a.float(),        // Percentage increase
  }),
  
  // ============================================================================
  // INPUT TYPES
  // ============================================================================
  
  StartOptimizationInput: a.customType({
    operationId: a.id().required(),
    wellName: a.string().required(),
    initialParameters: a.ref('OperationParameters').required(),
    optimizationGoals: a.ref('OptimizationGoals').required(),
    simulationConfig: a.ref('SimulationConfig'),
  }),
  
  CfdSimulationInput: a.customType({
    operationId: a.id().required(),
    optimizationSessionId: a.id(),
    injectionRate: a.float().required(),
    proppantConcentration: a.float().required(),
    fluidViscosity: a.float().required(),
    treatingPressure: a.float().required(),
    fractureLengthM: a.float(),
    fractureWidthMm: a.float(),
    simulationType: a.string().required(),         // 'CONTINUOUS' | 'ONESHOT' | 'WHATIF'
    pumpingSchedule: a.json(),                     // PumpingSchedule as JSON (optional)
  }),
  
  // ============================================================================
  // RESULT TYPES
  // ============================================================================
  
  OptimizationSessionResult: a.customType({
    success: a.boolean().required(),
    sessionId: a.id(),
    status: a.string(),
    message: a.string(),
    error: a.string(),
  }),
  
  StopOptimizationResult: a.customType({
    success: a.boolean().required(),
    sessionId: a.id().required(),
    status: a.string().required(),
    message: a.string(),
    error: a.string(),
  }),
  
  CfdSimulationResult: a.customType({
    success: a.boolean().required(),
    simulationId: a.id(),
    status: a.string(),
    message: a.string(),
    error: a.string(),
  }),
  
  JobStatusResult: a.customType({
    success: a.boolean().required(),
    jobId: a.id().required(),
    status: a.ref('JobStatus').required(),
    elapsedTimeSeconds: a.integer(),
    estimatedCompletionSeconds: a.integer(),
    s3ResultPath: a.string(),
    error: a.string(),
  }),
  
  SimulationResultsData: a.customType({
    success: a.boolean().required(),
    jobId: a.id().required(),
    
    // Optimization metrics (primary)
    proppantPlacementEfficiency: a.float().required(),
    fractureGeometryScore: a.float().required(),
    placementUniformity: a.float().required(),
    
    // Risk metrics (secondary)
    screenOutRisk: a.float().required(),
    concentrationRisk: a.float().required(),
    velocityRisk: a.float().required(),
    pressureRisk: a.float().required(),
    timeToScreenoutSeconds: a.integer(),
    
    // Confidence and recommendations
    confidence: a.float().required(),
    recommendations: a.json(), // JSON array of recommendation objects (not model references)
    visualizationUrls: a.string().array(),
    error: a.string(),

    // Pressure statistics from solver (kinematic pressure m²/s²)
    pressureStats: a.json(),

    // Time-series data for transient simulations
    timeSeries: a.json(),                          // JSON array of per-timestep metrics
    predictedMaxTreatingPressurePsi: a.float(),    // predicted max treating pressure in psi
  }),
  
  CancelJobResult: a.customType({
    success: a.boolean().required(),
    jobId: a.id().required(),
    status: a.string().required(),
    message: a.string(),
    error: a.string(),
  }),
  
  // ============================================================================
  // DATA MODELS
  // ============================================================================
  
  // Optimization Session - tracks continuous optimization for an operation
  OptimizationSession: a.model({
    // Identification
    id: a.id().required(),
    operationId: a.id().required(),
    operation: a.belongsTo('WellOperation', 'operationId'),
    
    // Status
    status: a.ref('OptimizationStatus').required(),
    
    // Configuration
    initialParameters: a.json().required(),        // OperationParameters
    optimizationGoals: a.json().required(),        // OptimizationGoals
    simulationConfig: a.json(),                    // SimulationConfig
    
    // Current state
    currentParameters: a.json(),                   // Latest OperationParameters
    latestResultId: a.id(),
    
    // Timestamps
    startedAt: a.datetime().required(),
    stoppedAt: a.datetime(),
    lastUpdateAt: a.datetime(),
    
    // Performance metrics
    totalIterations: a.integer(),
    physicsModelExecutions: a.integer(),
    romModelExecutions: a.integer(),
    cfdModelExecutions: a.integer(),
    
    // Compute metrics
    totalComputeTimeSeconds: a.integer(),
    totalComputeCostUsd: a.float(),
    
    // Relationships
    results: a.hasMany('OptimizationResult', 'sessionId'),
    recommendations: a.hasMany('OptimizationRecommendation', 'sessionId'),
    simulations: a.hasMany('CFDSimulation', 'optimizationSessionId'),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner()
    ])
    .secondaryIndexes((index) => [
      index('operationId').sortKeys(['startedAt']).queryField('sessionsByOperationAndTime'),
      index('status').sortKeys(['startedAt']).queryField('sessionsByStatusAndTime'),
    ]),
  
  // Optimization Result - stores results from each optimization iteration
  OptimizationResult: a.model({
    // Identification
    id: a.id().required(),
    sessionId: a.id().required(),
    session: a.belongsTo('OptimizationSession', 'sessionId'),
    operationId: a.id().required(),
    operation: a.belongsTo('WellOperation', 'operationId'),
    
    // Timestamp
    timestamp: a.datetime().required(),
    iterationNumber: a.integer().required(),
    
    // Model results (stored as JSON for flexibility)
    physicsModelResult: a.json(),                  // ModelResult
    romModelResult: a.json(),                      // ModelResult
    cfdModelResult: a.json(),                      // ModelResult
    
    // Aggregated optimization metrics
    proppantPlacementEfficiency: a.float().required(),
    fractureGeometryScore: a.float().required(),
    placementUniformity: a.float().required(),
    screenOutRisk: a.float().required(),
    
    // Optimization opportunities
    opportunities: a.json(),                       // [OptimizationOpportunity]
    
    // Parameters used for this iteration
    parameters: a.json().required(),               // OperationParameters
    
    // Sensor data at time of iteration
    sensorData: a.json(),
    
    // Performance
    totalExecutionTimeMs: a.integer(),
    
    // Relationships
    recommendations: a.hasMany('OptimizationRecommendation', 'resultId'),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create']),
      allow.owner()
    ])
    .secondaryIndexes((index) => [
      index('sessionId').sortKeys(['timestamp']).queryField('resultsBySessionAndTime'),
      index('operationId').sortKeys(['timestamp']).queryField('resultsByOperationAndTime'),
    ]),
  
  // Optimization Recommendation - stores optimization recommendations
  OptimizationRecommendation: a.model({
    // Identification
    id: a.id().required(),
    sessionId: a.id().required(),
    session: a.belongsTo('OptimizationSession', 'sessionId'),
    resultId: a.id(),
    result: a.belongsTo('OptimizationResult', 'resultId'),
    operationId: a.id().required(),
    operation: a.belongsTo('WellOperation', 'operationId'),
    
    // Timestamp
    timestamp: a.datetime().required(),
    
    // Recommendation type and priority
    type: a.ref('OpportunityType').required(),
    priority: a.ref('RecommendationPriority').required(),
    
    // Recommendation content
    title: a.string().required(),
    description: a.string().required(),
    reasoning: a.string().required(),
    
    // Parameter adjustments
    parameterAdjustments: a.json().required(),     // [ParameterAdjustment]
    
    // Expected outcomes
    expectedImprovements: a.json().required(),     // ExpectedImprovements
    
    // Supporting data
    supportingModels: a.json().required(),         // [ModelType]
    confidence: a.float().required(),
    
    // Status tracking
    status: a.ref('RecommendationStatus').required(),
    reviewedBy: a.string(),
    reviewedAt: a.datetime(),
    implementedAt: a.datetime(),
    rejectionReason: a.string(),
    
    // Outcome tracking (if implemented)
    actualImprovements: a.json(),                  // ExpectedImprovements (actual measured)
    effectivenessScore: a.float(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner()
    ])
    .secondaryIndexes((index) => [
      index('sessionId').sortKeys(['timestamp']).queryField('recommendationsBySessionAndTime'),
      index('operationId').sortKeys(['priority', 'timestamp']).queryField('recommendationsByOperationAndPriority'),
      index('status').sortKeys(['timestamp']).queryField('recommendationsByStatusAndTime'),
    ]),
  
  // ============================================================================
  // QUERIES
  // ============================================================================
  
  // Note: getOptimizationSession is auto-generated by Amplify for the OptimizationSession model
  // Use the auto-generated query: client.models.OptimizationSession.get({ id: sessionId })
  
  getOptimizationRecommendations: a
    .query()
    .arguments({
      sessionId: a.id().required()
    })
    .returns(a.ref('OptimizationRecommendation').array())
    .authorization((allow) => [allow.authenticated()])
    .handler(
      a.handler.function(getOptimizationRecommendations)
    ),
  
  getCfdJobStatus: a
    .query()
    .arguments({
      jobId: a.id().required()
    })
    .returns(a.ref('JobStatusResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(getCfdJobStatus)),
  
  getCfdResults: a
    .query()
    .arguments({
      jobId: a.id().required()
    })
    .returns(a.ref('SimulationResultsData'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(getCfdResults)),
  
  // ============================================================================
  // MUTATIONS
  // ============================================================================
  
  startContinuousOptimization: a
    .mutation()
    .arguments({
      input: a.ref('StartOptimizationInput').required()
    })
    .returns(a.ref('OptimizationSessionResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(startContinuousOptimization)),
  
  stopContinuousOptimization: a
    .mutation()
    .arguments({
      sessionId: a.id().required()
    })
    .returns(a.ref('StopOptimizationResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(stopContinuousOptimization)),
  
  submitCfdSimulation: a
    .mutation()
    .arguments({
      input: a.ref('CfdSimulationInput').required()
    })
    .returns(a.ref('CfdSimulationResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(submitCfdSimulation)),
  
  cancelCfdJob: a
    .mutation()
    .arguments({
      jobId: a.id().required()
    })
    .returns(a.ref('CancelJobResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(cancelCfdJob)),
  
  // ============================================================================
  // SUBSCRIPTIONS
  // ============================================================================
  
  // Note: Subscriptions for OptimizationResult and OptimizationRecommendation
  // are auto-generated by Amplify based on the model definitions.
  // Use onCreate, onUpdate, onDelete subscriptions for these models.
  
});
