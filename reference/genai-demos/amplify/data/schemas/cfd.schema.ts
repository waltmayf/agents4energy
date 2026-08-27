import { a } from '@aws-amplify/backend';
import {
  submitCfdSimulation,
  getCfdSimulationStatus,
  cancelCfdSimulation,
  generateSimulationSnapshots
} from '../../functions/cfd-simulation-manager/resource';
import {
  runEnsembleSimulation,
  interpretPressureResponse,
  runHypothesisSimulations,
} from '../../functions/ensemble-fracture-interpreter/resource';

/**
 * CFD Simulation Schema
 * Models for OpenFOAM simulations on AWS Parallel Cluster
 */
export const cfdSchema = a.schema({
  
  // Simulation Types
  SimulationType: a.enum([
    "fracturing",           // Well fracturing simulation
    "production",           // Production flow simulation
    "whatif",              // What-if analysis (restart from existing)
    "optimization"         // Parameter optimization
  ]),
  
  SimulationStatus: a.enum([
    "queued",              // Waiting to start
    "initializing",        // Setting up on cluster
    "running",             // Currently executing
    "completed",           // Successfully finished
    "failed",              // Error occurred
    "cancelled"            // User cancelled
  ]),

  // Pumping Schedule Stage Types
  StageType: a.enum(["pad", "slurry", "flush"]),

  // Individual stage in a pumping schedule
  PumpingScheduleStage: a.customType({
    stageType: a.ref("StageType").required(),
    startTimeSeconds: a.float().required(),
    endTimeSeconds: a.float().required(),
    pumpRateBblMin: a.float().required(),
    proppantConcentrationPpg: a.float().required(),
    fluidViscosityCp: a.float().required(),
  }),

  // Complete pumping schedule
  PumpingSchedule: a.customType({
    stages: a.ref("PumpingScheduleStage").required().array().required(),
    totalDurationSeconds: a.float().required(),
  }),

  // Simulation Parameters for Fracturing
  FracturingParameters: a.customType({
    treatingPressure: a.float().required(),      // psi
    pumpRate: a.float().required(),              // bbl/min
    fluidViscosity: a.float().required(),        // cP
    proppantConcentration: a.float(),            // ppg
    formationPermeability: a.float().required(), // mD
    formationPorosity: a.float().required(),     // fraction
    youngModulus: a.float().required(),          // psi
    poissonRatio: a.float().required(),          // dimensionless
    minimumStress: a.float().required(),         // psi
    maximumStress: a.float().required(),         // psi
  }),

  // Mesh Configuration
  MeshConfiguration: a.customType({
    cellsX: a.integer().required(),
    cellsY: a.integer().required(),
    cellsZ: a.integer().required(),
    refinementLevel: a.integer().required(),     // 0-3
    domainSizeX: a.float().required(),           // meters
    domainSizeY: a.float().required(),
    domainSizeZ: a.float().required(),
  }),

  // Solver Configuration
  SolverConfiguration: a.customType({
    solver: a.string().required(),               // e.g., "simpleFoam", "pimpleFoam"
    timeStep: a.float().required(),              // seconds
    endTime: a.float().required(),               // seconds
    writeInterval: a.float().required(),         // seconds
    maxIterations: a.integer(),
    convergenceTolerance: a.float(),
  }),

  // Compute Resources
  ComputeResources: a.customType({
    nodeCount: a.integer().required(),
    coresPerNode: a.integer().required(),
    instanceType: a.string().required(),         // e.g., "c5n.18xlarge"
    estimatedCostPerHour: a.float(),
  }),

  // Simulation Progress
  SimulationProgress: a.customType({
    currentTime: a.float().required(),           // Current simulation time
    percentComplete: a.float().required(),       // 0-100
    iterationsCompleted: a.integer(),
    residuals: a.json(),                         // Latest residuals
    estimatedTimeRemaining: a.integer(),         // seconds
    lastUpdateTime: a.datetime().required(),
  }),

  // Output Files
  SimulationOutput: a.customType({
    s3Prefix: a.string().required(),             // S3 path prefix
    meshFile: a.string(),                        // Path to mesh
    solutionFiles: a.string().array(),           // Time step solutions
    postProcessingFiles: a.string().array(),     // Charts, images
    logFile: a.string(),                         // Solver log
    errorFile: a.string(),                       // Error log if failed
    visualizationReady: a.boolean().required(),  // Ready for ParaView
  }),

  // ============================================================================
  // CFD SIMULATION MODELS
  // ============================================================================

  // Main Simulation Model
  CFDSimulation: a.model({
    name: a.string().required(),
    description: a.string(),
    simulationType: a.ref("SimulationType").required(),
    status: a.ref("SimulationStatus").required(),
    
    // Well/Operation Context
    wellName: a.string(),
    operationDate: a.datetime(),
    
    // Optimization Context
    optimizationSessionId: a.id(),
    
    // Configuration
    fracturingParams: a.ref("FracturingParameters"),
    meshConfig: a.ref("MeshConfiguration").required(),
    solverConfig: a.ref("SolverConfiguration").required(),
    computeResources: a.ref("ComputeResources").required(),
    
    // Execution Details
    clusterJobId: a.string(),                    // AWS Batch or Slurm job ID
    clusterName: a.string(),
    queueName: a.string(),
    
    // Progress and Results
    progress: a.ref("SimulationProgress"),
    output: a.ref("SimulationOutput"),
    
    // Optimization Metrics (primary)
    proppantPlacementEfficiency: a.float(),      // 0-1 - near-wellbore proppant placement quality
    fractureGeometryScore: a.float(),            // 0-1 - fracture width/length/height quality
    placementUniformity: a.float(),              // 0-1 - uniformity of proppant distribution
    nearWellboreConcentration: a.float(),        // volume fraction - proppant concentration near wellbore
    
    // Fracture Geometry Results
    fractureWidth: a.float(),                    // meters - fracture width
    fractureLength: a.float(),                   // meters - fracture length
    fractureHeight: a.float(),                   // meters - fracture height
    
    // Risk Metrics (secondary)
    screenOutRisk: a.float(),                    // 0-1 - composite screen-out risk
    concentrationRisk: a.float(),                // 0-1 - proppant concentration risk
    velocityRisk: a.float(),                     // 0-1 - fluid velocity risk
    pressureRisk: a.float(),                     // 0-1 - pressure gradient risk
    timeToScreenOutSeconds: a.integer(),         // seconds - estimated time to screen-out
    confidence: a.float(),                       // 0-1 - confidence in results
    
    // Timestamps
    submittedAt: a.datetime().required(),
    startedAt: a.datetime(),
    completedAt: a.datetime(),
    
    // Parent simulation for what-if analysis
    parentSimulationId: a.id(),
    restartFromTime: a.float(),                  // Time to restart from
    
    // Error information
    errorMessage: a.string(),
    errorDetails: a.json(),
    
    // Pumping Schedule (transient simulations)
    pumpingSchedule: a.ref("PumpingSchedule"),
    predictedMaxTreatingPressure: a.float(),     // psi
    
    // Cost tracking
    estimatedCost: a.float(),
    actualCost: a.float(),
    
    // Relationships
    optimizationSession: a.belongsTo('OptimizationSession', 'optimizationSessionId'),
    snapshots: a.hasMany('SimulationSnapshot', 'simulationId'),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create']),
      allow.owner()
    ]),

  // Visualization Snapshots
  SimulationSnapshot: a.model({
    simulationId: a.id().required(),
    simulation: a.belongsTo('CFDSimulation', 'simulationId'),
    
    timeStep: a.float().required(),
    snapshotType: a.string().required(),         // "pressure", "velocity", "fracture"
    
    // Image/data location
    imageUrl: a.string(),                        // S3 URL for rendered image
    dataUrl: a.string(),                         // S3 URL for raw data
    
    // Metadata
    minValue: a.float(),
    maxValue: a.float(),
    units: a.string(),
    colormap: a.string(),
    
    generatedAt: a.datetime().required(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.owner()
    ]),

  // Cluster Configuration
  ParallelClusterConfig: a.model({
    clusterName: a.string().required(),
    region: a.string().required(),
    status: a.string().required(),               // "CREATE_COMPLETE", "RUNNING", etc.
    
    headNodeInstanceType: a.string().required(),
    computeNodeInstanceType: a.string().required(),
    maxNodeCount: a.integer().required(),
    
    schedulerType: a.string().required(),        // "slurm" or "awsbatch"
    queueName: a.string().required(),
    
    // S3 paths
    sharedStoragePath: a.string(),
    openfoamVersion: a.string().required(),
    
    // Endpoints
    headNodeIp: a.string(),
    apiEndpoint: a.string(),
    
    lastHealthCheck: a.datetime(),
    isActive: a.boolean().required(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.owner()
    ]),

  // ============================================================================
  // FRACTURE DEMO SESSIONS
  // ============================================================================

  // Persists a fracture demo session: drawn pressure curve, interpretation result,
  // and a link to the chat session so the list page can show the sparkline + metadata.
  FractureDemoSession: a.model({
    chatSessionId: a.id().required(),     // FK to ChatSession
    // Drawn pressure curve stored as JSON: [{t: number, p: number}]
    drawnCurveJson: a.string().required(),
    // Interpretation snapshot stored as JSON: InterpretationResult
    interpretationJson: a.string(),
    // Denormalised summary fields for fast list rendering
    topScenarioName: a.string(),
    topScenarioConfidence: a.float(),
    breakdownPsi: a.float(),
    durationSec: a.float(),
    peakPressurePsi: a.float(),
  })
    .authorization((allow) => [allow.owner(), allow.authenticated()]),

  // ============================================================================
  // ENSEMBLE FRACTURE INTERPRETATION MODELS
  // ============================================================================

  // Groups N scenario simulations submitted from the same base treatment plan
  EnsembleSimulationRun: a.model({
    name: a.string().required(),
    wellId: a.string(),
    status: a.string().required(),                // "running" | "completed" | "failed"
    baseTreatmentPlanJson: a.string(),            // JSON of base treatment plan
    scenarioResults: a.hasMany('ScenarioSimulationResult', 'ensembleRunId'),
    completedAt: a.datetime(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner(),
    ]),

  // One simulation within an ensemble (one scenario archetype)
  ScenarioSimulationResult: a.model({
    ensembleRunId: a.id().required(),
    ensembleRun: a.belongsTo('EnsembleSimulationRun', 'ensembleRunId'),
    scenarioId: a.string().required(),            // "S01"–"S10"
    scenarioName: a.string().required(),
    cfdSimulationId: a.string(),                  // FK to CFDSimulation
    pressureTimeSeriesJson: a.string(),           // JSON array [{t,p}]
    derivativeTimeSeriesJson: a.string(),         // JSON array [{t,dpdt}]
    nolteSmithSlope: a.float(),
    isip: a.float(),
    closurePressure: a.float(),
    fractureLength: a.float(),
    fractureHeight: a.float(),
    fractureWidth: a.float(),
    placementEfficiency: a.float(),
    status: a.string().required(),               // "running" | "completed" | "failed"
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner(),
    ]),

  // Tracks a multi-iteration adaptive investigation session
  InvestigationSession: a.model({
    ensembleRunId: a.string(),
    wellId: a.string(),
    operationId: a.string(),
    measuredCurveJson: a.string().required(),    // input curve that triggered investigation
    status: a.string().required(),               // "running" | "converged" | "stopped" | "failed"
    finalInferredParametersJson: a.string(),     // JSON Partial<FormationParameters>
    finalResidualRMS: a.float(),
    finalRecommendation: a.string(),
    iterations: a.hasMany('InvestigationIteration', 'sessionId'),
    startedAt: a.datetime().required(),
    completedAt: a.datetime(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner(),
    ]),

  // One iteration of hypothesis testing within an investigation session
  InvestigationIteration: a.model({
    sessionId: a.id().required(),
    session: a.belongsTo('InvestigationSession', 'sessionId'),
    iterationNumber: a.integer().required(),
    hypothesesJson: a.string().required(),       // JSON array of hypothesis objects
    simulationIds: a.string(),                   // JSON array of CFDSimulation IDs
    bestHypothesisId: a.string(),
    residualRMSBefore: a.float(),
    residualRMSAfter: a.float(),
    converged: a.boolean(),
    agentReasoning: a.string(),                  // Claude's explanation for this iteration
    completedAt: a.datetime(),
  })
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update']),
      allow.owner(),
    ]),

  // Custom Mutations — Ensemble Fracture Interpretation
  runEnsembleSimulation: a
    .mutation()
    .arguments({ input: a.json().required() })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(runEnsembleSimulation)),

  interpretPressureResponse: a
    .mutation()
    .arguments({ input: a.json().required() })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(interpretPressureResponse)),

  runHypothesisSimulations: a
    .mutation()
    .arguments({ input: a.json().required() })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(runHypothesisSimulations)),

  // Custom Mutations
  submitCFDSimulation: a
    .mutation()
    .arguments({
      input: a.json().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(submitCfdSimulation)),

  getCFDSimulationStatus: a
    .query()
    .arguments({
      simulationId: a.string().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(getCfdSimulationStatus)),

  cancelCFDSimulation: a
    .mutation()
    .arguments({
      simulationId: a.string().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(cancelCfdSimulation)),

  generateSimulationSnapshots: a
    .mutation()
    .arguments({
      simulationId: a.string().required(),
      timeSteps: a.float().array()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(generateSimulationSnapshots)),
});
