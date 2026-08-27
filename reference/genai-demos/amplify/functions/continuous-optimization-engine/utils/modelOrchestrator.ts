/**
 * Model Orchestrator Utility
 * 
 * Orchestrates parallel execution of three model types:
 * - Physics model: Continuous execution, <1s per iteration
 * - ROM model: Continuous execution, <30s per iteration
 * - CFD model: Continuous execution, minutes per iteration
 * 
 * Monitors all three job streams in parallel, collects results independently,
 * and handles model failures gracefully (continues with remaining models).
 * 
 * Requirements: 2.1, 2.2, 12.1, 12.2
 */

import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import {
  withRetry,
  classifyError,
  logError,
  handlePartialFailure,
  ErrorCategory,
  ErrorCode,
  ClassifiedError,
} from '../../shared/utils/errorHandler';

// AWS SDK clients
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'ModelOrchestrator';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';

/**
 * Model types supported by the orchestrator
 */
export enum ModelType {
  PHYSICS = 'physics',
  ROM = 'rom',
  CFD = 'cfd',
}

/**
 * Model execution configuration
 */
export interface ModelConfig {
  type: ModelType;
  iterationTimeMs: number; // Expected iteration time
  scriptPath: string; // Path to model execution script on cluster
  resourceRequirements: {
    nodes: number;
    tasksPerNode: number;
    memoryMb: number;
  };
}

/**
 * Model execution parameters
 */
export interface ModelExecutionParams {
  operationId: string;
  sessionId: string;
  injectionRate: number;
  proppantConcentration: number;
  fluidViscosity: number;
  treatingPressure: number;
  fractureLengthM?: number;
  fractureWidthMm?: number;
  sensorData?: Record<string, unknown>;
}

/**
 * Model execution result
 */
export interface ModelExecutionResult {
  modelType: ModelType;
  success: boolean;
  jobId?: string;
  executionTimeMs?: number;
  confidence?: number;
  
  // Optimization metrics
  proppantPlacementEfficiency?: number;
  fractureGeometryScore?: number;
  placementUniformity?: number;
  nearWellboreConcentration?: number;
  
  // Fracture metrics
  fractureWidth?: number;
  fractureLength?: number;
  fractureHeight?: number;
  
  // Risk metrics (secondary)
  screenOutRisk?: number;
  timeToScreenOutSeconds?: number;
  
  // Error information
  error?: string;
  errorDetails?: Record<string, unknown>;
}

/**
 * Model configurations for each type
 */
const MODEL_CONFIGS: Record<ModelType, ModelConfig> = {
  [ModelType.PHYSICS]: {
    type: ModelType.PHYSICS,
    iterationTimeMs: 1000, // <1s per iteration
    scriptPath: '/opt/models/physics/run_physics_model.py',
    resourceRequirements: {
      nodes: 1,
      tasksPerNode: 1,
      memoryMb: 512,
    },
  },
  [ModelType.ROM]: {
    type: ModelType.ROM,
    iterationTimeMs: 30000, // <30s per iteration
    scriptPath: '/opt/models/rom/run_rom_model.py',
    resourceRequirements: {
      nodes: 1,
      tasksPerNode: 4,
      memoryMb: 2048,
    },
  },
  [ModelType.CFD]: {
    type: ModelType.CFD,
    iterationTimeMs: 300000, // ~5 minutes per iteration
    scriptPath: '/opt/models/cfd/run_cfd_model.sh',
    resourceRequirements: {
      nodes: 2,
      tasksPerNode: 8,
      memoryMb: 4096,
    },
  },
};

/**
 * Find login node instance ID by EC2 tag
 */
async function findLoginNode(): Promise<string> {
  return withRetry({
    operation: async () => {
      const describeResult = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'tag:Name',
              Values: [HEAD_NODE_TAG],
            },
            {
              Name: 'instance-state-name',
              Values: ['running'],
            },
          ],
        })
      );

      const instances = describeResult.Reservations?.flatMap((r) => r.Instances || []) || [];
      if (instances.length === 0) {
        throw new ClassifiedError(
          ErrorCategory.SYSTEM,
          ErrorCode.CLUSTER_UNAVAILABLE,
          `Login node not found with tag ${HEAD_NODE_TAG}`,
          { headNodeTag: HEAD_NODE_TAG }
        );
      }

      return instances[0].InstanceId!;
    },
    operationName: 'FindLoginNode',
    component: COMPONENT_NAME,
    context: { headNodeTag: HEAD_NODE_TAG },
  });
}

/**
 * Generate Slurm script for model execution
 */
function generateModelScript(
  modelType: ModelType,
  params: ModelExecutionParams,
  config: ModelConfig
): string {
  const {
    operationId,
    sessionId,
    injectionRate,
    proppantConcentration,
    fluidViscosity,
    treatingPressure,
    fractureLengthM = 100,
    fractureWidthMm = 5,
    sensorData = {},
  } = params;

  const jobName = `${modelType}-${sessionId.substring(0, 8)}-${Date.now()}`;
  const workDir = `/fsx/optimization/${sessionId}/${modelType}`;

  return `#!/bin/bash
#SBATCH --job-name=${jobName}
#SBATCH --nodes=${config.resourceRequirements.nodes}
#SBATCH --ntasks-per-node=${config.resourceRequirements.tasksPerNode}
#SBATCH --mem=${config.resourceRequirements.memoryMb}M
#SBATCH --time=00:30:00
#SBATCH --output=${workDir}/logs/%j.out
#SBATCH --error=${workDir}/logs/%j.err

# Create working directory
mkdir -p ${workDir}/logs
mkdir -p ${workDir}/results
cd ${workDir}

# Export parameters
export OPERATION_ID="${operationId}"
export SESSION_ID="${sessionId}"
export MODEL_TYPE="${modelType}"
export INJECTION_RATE=${injectionRate}
export PROPPANT_CONCENTRATION=${proppantConcentration}
export FLUID_VISCOSITY=${fluidViscosity}
export TREATING_PRESSURE=${treatingPressure}
export FRACTURE_LENGTH=${fractureLengthM}
export FRACTURE_WIDTH=${fractureWidthMm}

# Write sensor data to file
cat > sensor_data.json << 'EOF'
${JSON.stringify(sensorData)}
EOF

# Execute model
echo "Starting ${modelType} model execution at \$(date)"
START_TIME=\$(date +%s)

${config.scriptPath} \\
  --operation-id "${operationId}" \\
  --session-id "${sessionId}" \\
  --injection-rate ${injectionRate} \\
  --proppant-concentration ${proppantConcentration} \\
  --fluid-viscosity ${fluidViscosity} \\
  --treating-pressure ${treatingPressure} \\
  --fracture-length ${fractureLengthM} \\
  --fracture-width ${fractureWidthMm} \\
  --sensor-data sensor_data.json \\
  --output-dir results \\
  > execution.log 2>&1

EXIT_CODE=$?
END_TIME=\$(date +%s)
EXECUTION_TIME=$((END_TIME - START_TIME))

echo "Model execution completed at \$(date)"
echo "Exit code: \${EXIT_CODE}"
echo "Execution time: \${EXECUTION_TIME} seconds"

# Write execution metadata
cat > results/metadata.json << EOF
{
  "modelType": "${modelType}",
  "exitCode": \${EXIT_CODE},
  "executionTimeSeconds": \${EXECUTION_TIME},
  "startTime": \${START_TIME},
  "endTime": \${END_TIME}
}
EOF

exit \${EXIT_CODE}
`;
}

/**
 * Submit a model job to Slurm
 * Requirement: 2.1, 2.2
 */
async function submitModelJob(
  loginNodeId: string,
  modelType: ModelType,
  params: ModelExecutionParams
): Promise<string> {
  const config = MODEL_CONFIGS[modelType];
  const slurmScript = generateModelScript(modelType, params, config);

  return withRetry({
    operation: async () => {
      // Write script to temp file and submit
      const submitCommand = `
        SCRIPT_FILE="/tmp/${modelType}_job_\${RANDOM}.sh"
        cat > \${SCRIPT_FILE} << 'EOF'
${slurmScript}
EOF
        chmod +x \${SCRIPT_FILE}
        sbatch \${SCRIPT_FILE}
        rm \${SCRIPT_FILE}
      `;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [submitCommand],
          },
        })
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          `Failed to get SSM command ID for ${modelType} model`,
          { loginNodeId, modelType }
        );
      }

      // Wait for command to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        })
      );

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Slurm job submission failed for ${modelType} model: ${invocationResult.StandardErrorContent}`,
          { loginNodeId, commandId, modelType, stderr: invocationResult.StandardErrorContent }
        );
      }

      // Parse job ID from sbatch output
      const output = invocationResult.StandardOutputContent || '';
      const jobIdMatch = output.match(/Submitted batch job (\d+)/);
      if (!jobIdMatch) {
        throw new ClassifiedError(
          ErrorCategory.PERMANENT,
          ErrorCode.MALFORMED_INPUT,
          `Failed to parse Slurm job ID for ${modelType} model from output: ${output}`,
          { output, modelType }
        );
      }

      return jobIdMatch[1];
    },
    operationName: `SubmitModelJob_${modelType}`,
    component: COMPONENT_NAME,
    context: { loginNodeId, modelType, sessionId: params.sessionId },
  });
}

/**
 * Check job status via Slurm
 */
async function checkJobStatus(
  loginNodeId: string,
  jobId: string,
  modelType: ModelType
): Promise<{ status: string; exitCode?: number }> {
  return withRetry({
    operation: async () => {
      const checkCommand = `squeue -j ${jobId} -h -o "%T" 2>/dev/null || sacct -j ${jobId} -n -o State%20 | head -1`;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [checkCommand],
          },
        })
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          `Failed to get SSM command ID for status check`,
          { loginNodeId, jobId, modelType }
        );
      }

      // Wait for command to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        })
      );

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Failed to check job status for ${modelType} model`,
          { loginNodeId, commandId, jobId, modelType }
        );
      }

      const output = (invocationResult.StandardOutputContent || '').trim();
      
      // Map Slurm states to our status
      const statusMap: Record<string, string> = {
        'PENDING': 'PENDING',
        'RUNNING': 'RUNNING',
        'COMPLETED': 'COMPLETED',
        'FAILED': 'FAILED',
        'CANCELLED': 'CANCELLED',
        'TIMEOUT': 'FAILED',
        'NODE_FAIL': 'FAILED',
        'PREEMPTED': 'FAILED',
      };

      const status = statusMap[output] || 'UNKNOWN';

      return { status };
    },
    operationName: `CheckJobStatus_${modelType}`,
    component: COMPONENT_NAME,
    context: { loginNodeId, jobId, modelType },
  });
}

/**
 * Retrieve model results from FSx
 */
async function retrieveModelResults(
  loginNodeId: string,
  jobId: string,
  modelType: ModelType,
  sessionId: string
): Promise<ModelExecutionResult> {
  return withRetry({
    operation: async () => {
      const workDir = `/fsx/optimization/${sessionId}/${modelType}`;
      const retrieveCommand = `
        if [ -f ${workDir}/results/metadata.json ]; then
          cat ${workDir}/results/metadata.json
        else
          echo '{"error": "Results not found"}'
        fi
      `;

      const commandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [retrieveCommand],
          },
        })
      );

      const commandId = commandResult.Command?.CommandId;
      if (!commandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          `Failed to get SSM command ID for result retrieval`,
          { loginNodeId, jobId, modelType }
        );
      }

      // Wait for command to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const invocationResult = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: loginNodeId,
        })
      );

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Failed to retrieve results for ${modelType} model`,
          { loginNodeId, commandId, jobId, modelType }
        );
      }

      const output = invocationResult.StandardOutputContent || '{}';
      const metadata = JSON.parse(output);

      if (metadata.error) {
        return {
          modelType,
          success: false,
          jobId,
          error: metadata.error,
        };
      }

      // Parse results file
      const resultsCommand = `
        if [ -f ${workDir}/results/results.json ]; then
          cat ${workDir}/results/results.json
        else
          echo '{}'
        fi
      `;

      const resultsCommandResult = await ssmClient.send(
        new SendCommandCommand({
          InstanceIds: [loginNodeId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: {
            commands: [resultsCommand],
          },
        })
      );

      const resultsCommandId = resultsCommandResult.Command?.CommandId;
      if (!resultsCommandId) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          `Failed to get SSM command ID for results file`,
          { loginNodeId, jobId, modelType }
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const resultsInvocation = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: resultsCommandId,
          InstanceId: loginNodeId,
        })
      );

      const resultsOutput = resultsInvocation.StandardOutputContent || '{}';
      const results = JSON.parse(resultsOutput);

      return {
        modelType,
        success: metadata.exitCode === 0,
        jobId,
        executionTimeMs: (metadata.executionTimeSeconds || 0) * 1000,
        confidence: results.confidence || 0.5,
        
        // Optimization metrics
        proppantPlacementEfficiency: results.proppantPlacementEfficiency,
        fractureGeometryScore: results.fractureGeometryScore,
        placementUniformity: results.placementUniformity,
        nearWellboreConcentration: results.nearWellboreConcentration,
        
        // Fracture metrics
        fractureWidth: results.fractureWidth,
        fractureLength: results.fractureLength,
        fractureHeight: results.fractureHeight,
        
        // Risk metrics
        screenOutRisk: results.screenOutRisk,
        timeToScreenOutSeconds: results.timeToScreenOutSeconds,
      };
    },
    operationName: `RetrieveModelResults_${modelType}`,
    component: COMPONENT_NAME,
    context: { loginNodeId, jobId, modelType, sessionId },
  });
}

/**
 * Submit all three model jobs in parallel
 * Requirement: 2.1, 2.2, 12.1
 */
export async function submitAllModels(
  params: ModelExecutionParams
): Promise<Record<ModelType, { jobId: string; success: boolean; error?: string }>> {
  console.log(`Submitting all models for session ${params.sessionId}`);

  try {
    // Find login node
    const loginNodeId = await findLoginNode();
    console.log(`Found login node: ${loginNodeId}`);

    // Submit all three models in parallel
    const submissions = await Promise.allSettled([
      submitModelJob(loginNodeId, ModelType.PHYSICS, params),
      submitModelJob(loginNodeId, ModelType.ROM, params),
      submitModelJob(loginNodeId, ModelType.CFD, params),
    ]);

    const results: Record<ModelType, { jobId: string; success: boolean; error?: string }> = {
      [ModelType.PHYSICS]: { jobId: '', success: false },
      [ModelType.ROM]: { jobId: '', success: false },
      [ModelType.CFD]: { jobId: '', success: false },
    };

    const modelTypes = [ModelType.PHYSICS, ModelType.ROM, ModelType.CFD];

    submissions.forEach((result, index) => {
      const modelType = modelTypes[index];
      
      if (result.status === 'fulfilled') {
        results[modelType] = {
          jobId: result.value,
          success: true,
        };
        console.log(`${modelType} model submitted successfully: ${result.value}`);
      } else {
        const error = classifyError(result.reason, { modelType, sessionId: params.sessionId });
        logError(error, COMPONENT_NAME, { modelType, sessionId: params.sessionId });
        
        results[modelType] = {
          jobId: '',
          success: false,
          error: error.message,
        };
        console.error(`${modelType} model submission failed: ${error.message}`);
      }
    });

    return results;

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId: params.sessionId });
    logError(classifiedError, COMPONENT_NAME, { sessionId: params.sessionId });
    
    // Return all failures
    return {
      [ModelType.PHYSICS]: { jobId: '', success: false, error: classifiedError.message },
      [ModelType.ROM]: { jobId: '', success: false, error: classifiedError.message },
      [ModelType.CFD]: { jobId: '', success: false, error: classifiedError.message },
    };
  }
}

/**
 * Monitor all three job streams in parallel
 * Requirement: 12.1, 12.2
 */
export async function monitorAllJobs(
  sessionId: string,
  jobIds: Record<ModelType, string>
): Promise<Record<ModelType, { status: string; success: boolean; error?: string }>> {
  console.log(`Monitoring all jobs for session ${sessionId}`);

  try {
    // Find login node
    const loginNodeId = await findLoginNode();

    // Check status of all three models in parallel
    const statusChecks = await Promise.allSettled([
      jobIds[ModelType.PHYSICS] ? checkJobStatus(loginNodeId, jobIds[ModelType.PHYSICS], ModelType.PHYSICS) : Promise.resolve({ status: 'NOT_SUBMITTED' }),
      jobIds[ModelType.ROM] ? checkJobStatus(loginNodeId, jobIds[ModelType.ROM], ModelType.ROM) : Promise.resolve({ status: 'NOT_SUBMITTED' }),
      jobIds[ModelType.CFD] ? checkJobStatus(loginNodeId, jobIds[ModelType.CFD], ModelType.CFD) : Promise.resolve({ status: 'NOT_SUBMITTED' }),
    ]);

    const results: Record<ModelType, { status: string; success: boolean; error?: string }> = {
      [ModelType.PHYSICS]: { status: 'UNKNOWN', success: false },
      [ModelType.ROM]: { status: 'UNKNOWN', success: false },
      [ModelType.CFD]: { status: 'UNKNOWN', success: false },
    };

    const modelTypes = [ModelType.PHYSICS, ModelType.ROM, ModelType.CFD];

    statusChecks.forEach((result, index) => {
      const modelType = modelTypes[index];
      
      if (result.status === 'fulfilled') {
        results[modelType] = {
          status: result.value.status,
          success: true,
        };
      } else {
        const error = classifyError(result.reason, { modelType, sessionId });
        logError(error, COMPONENT_NAME, { modelType, sessionId });
        
        results[modelType] = {
          status: 'ERROR',
          success: false,
          error: error.message,
        };
      }
    });

    return results;

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId });
    logError(classifiedError, COMPONENT_NAME, { sessionId });
    
    // Return all errors
    return {
      [ModelType.PHYSICS]: { status: 'ERROR', success: false, error: classifiedError.message },
      [ModelType.ROM]: { status: 'ERROR', success: false, error: classifiedError.message },
      [ModelType.CFD]: { status: 'ERROR', success: false, error: classifiedError.message },
    };
  }
}

/**
 * Collect results from each model independently
 * Handles model failures gracefully - continues with remaining models
 * Requirement: 12.2
 */
export async function collectAllResults(
  sessionId: string,
  jobIds: Record<ModelType, string>
): Promise<Record<ModelType, ModelExecutionResult>> {
  console.log(`Collecting results from all models for session ${sessionId}`);

  try {
    // Find login node
    const loginNodeId = await findLoginNode();

    // Retrieve results from all three models in parallel
    // Use Promise.allSettled to handle failures gracefully
    const resultRetrievals = await Promise.allSettled([
      jobIds[ModelType.PHYSICS] 
        ? retrieveModelResults(loginNodeId, jobIds[ModelType.PHYSICS], ModelType.PHYSICS, sessionId)
        : Promise.resolve({ modelType: ModelType.PHYSICS, success: false, error: 'Job not submitted' } as ModelExecutionResult),
      jobIds[ModelType.ROM]
        ? retrieveModelResults(loginNodeId, jobIds[ModelType.ROM], ModelType.ROM, sessionId)
        : Promise.resolve({ modelType: ModelType.ROM, success: false, error: 'Job not submitted' } as ModelExecutionResult),
      jobIds[ModelType.CFD]
        ? retrieveModelResults(loginNodeId, jobIds[ModelType.CFD], ModelType.CFD, sessionId)
        : Promise.resolve({ modelType: ModelType.CFD, success: false, error: 'Job not submitted' } as ModelExecutionResult),
    ]);

    const results: Record<ModelType, ModelExecutionResult> = {
      [ModelType.PHYSICS]: { modelType: ModelType.PHYSICS, success: false, error: 'Unknown error' },
      [ModelType.ROM]: { modelType: ModelType.ROM, success: false, error: 'Unknown error' },
      [ModelType.CFD]: { modelType: ModelType.CFD, success: false, error: 'Unknown error' },
    };

    const modelTypes = [ModelType.PHYSICS, ModelType.ROM, ModelType.CFD];

    resultRetrievals.forEach((result, index) => {
      const modelType = modelTypes[index];
      
      if (result.status === 'fulfilled') {
        results[modelType] = result.value;
        
        if (result.value.success) {
          console.log(`${modelType} model results collected successfully`);
        } else {
          console.warn(`${modelType} model execution failed: ${result.value.error}`);
        }
      } else {
        const error = classifyError(result.reason, { modelType, sessionId });
        logError(error, COMPONENT_NAME, { modelType, sessionId });
        
        results[modelType] = {
          modelType,
          success: false,
          error: error.message,
          errorDetails: { originalError: result.reason },
        };
        console.error(`${modelType} model result retrieval failed: ${error.message}`);
      }
    });

    // Log summary
    const successCount = Object.values(results).filter(r => r.success).length;
    console.log(`Collected results: ${successCount}/3 models succeeded`);

    return results;

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId });
    logError(classifiedError, COMPONENT_NAME, { sessionId });
    
    // Return all failures
    return {
      [ModelType.PHYSICS]: { 
        modelType: ModelType.PHYSICS, 
        success: false, 
        error: classifiedError.message 
      },
      [ModelType.ROM]: { 
        modelType: ModelType.ROM, 
        success: false, 
        error: classifiedError.message 
      },
      [ModelType.CFD]: { 
        modelType: ModelType.CFD, 
        success: false, 
        error: classifiedError.message 
      },
    };
  }
}

/**
 * Execute one complete iteration of all three models
 * Submits jobs, monitors execution, and collects results
 * Handles failures gracefully - continues with available models
 * Requirement: 2.1, 2.2, 12.1, 12.2
 */
export async function executeModelIteration(
  params: ModelExecutionParams
): Promise<{
  success: boolean;
  results: Record<ModelType, ModelExecutionResult>;
  successCount: number;
  failureCount: number;
}> {
  console.log(`Executing model iteration for session ${params.sessionId}`);

  // Step 1: Submit all models in parallel
  const submissions = await submitAllModels(params);
  
  const jobIds: Record<ModelType, string> = {
    [ModelType.PHYSICS]: submissions[ModelType.PHYSICS].jobId,
    [ModelType.ROM]: submissions[ModelType.ROM].jobId,
    [ModelType.CFD]: submissions[ModelType.CFD].jobId,
  };

  // Step 2: Wait for jobs to complete (with timeout)
  const maxWaitTimeMs = 600000; // 10 minutes max wait
  const pollIntervalMs = 5000; // Poll every 5 seconds
  const startTime = Date.now();
  
  let allCompleted = false;
  while (!allCompleted && (Date.now() - startTime) < maxWaitTimeMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    
    const statuses = await monitorAllJobs(params.sessionId, jobIds);
    
    // Check if all jobs are in terminal state
    allCompleted = Object.values(statuses).every(
      s => ['COMPLETED', 'FAILED', 'CANCELLED', 'ERROR', 'NOT_SUBMITTED'].includes(s.status)
    );
    
    if (!allCompleted) {
      console.log(`Waiting for jobs to complete... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
    }
  }

  // Step 3: Collect results from all models
  const results = await collectAllResults(params.sessionId, jobIds);

  // Step 4: Calculate success/failure counts
  const successCount = Object.values(results).filter(r => r.success).length;
  const failureCount = 3 - successCount;

  console.log(`Model iteration complete: ${successCount}/3 models succeeded`);

  return {
    success: successCount > 0, // Success if at least one model succeeded
    results,
    successCount,
    failureCount,
  };
}
