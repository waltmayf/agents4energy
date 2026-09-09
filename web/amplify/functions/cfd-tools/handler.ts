import type { Context } from 'aws-lambda';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { validateTreatmentPlan, type TreatmentPlan } from './cfd-types';
import { buildCfdSlurmScript } from './cfd-slurm-script';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG ?? '';
const HPC_BUCKET = process.env.HPC_BUCKET ?? '';
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET ?? '';

const ec2 = new EC2Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// PCS installs Slurm at a non-standard path and caches the cluster's config
// at a fixed location — see web/amplify/constructs/realTimeParallelCluster.
const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
const PCS_BIN = '/opt/aws/pcs/scheduler/slurm-25.05/bin';

// Same client-context convention as web/amplify/functions/s3-tools/handler.ts —
// the gateway invokes this Lambda directly with the tool's input as the event.
interface GatewayClientContext {
  custom?: { bedrockAgentCoreToolName?: string };
}

function extractToolName(context: Context): string {
  const raw = (context.clientContext as GatewayClientContext | undefined)?.custom?.bedrockAgentCoreToolName;
  if (!raw) throw new Error('Missing bedrockAgentCoreToolName in Lambda client context');
  const idx = raw.lastIndexOf('___');
  return idx === -1 ? raw : raw.slice(idx + 3);
}

async function findLoginNodeInstanceId(): Promise<string> {
  if (!HEAD_NODE_TAG) throw new Error('HEAD_NODE_TAG is not configured');

  const result = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Name', Values: [HEAD_NODE_TAG] },
      { Name: 'instance-state-name', Values: ['running'] },
    ],
  }));
  const instanceId = result.Reservations?.flatMap((r) => r.Instances ?? [])?.[0]?.InstanceId;
  if (!instanceId) throw new Error(`Login node not found with tag Name=${HEAD_NODE_TAG}`);
  return instanceId;
}

async function runShellOnLoginNode(instanceId: string, command: string, pollAttempts = 3, pollDelayMs = 3000): Promise<{ stdout: string; stderr: string }> {
  const sent = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [command] },
  }));
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error('SSM SendCommand did not return a CommandId');

  let invocation;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await new Promise((res) => setTimeout(res, pollDelayMs));
    invocation = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
    if (invocation.Status !== 'InProgress' && invocation.Status !== 'Pending') break;
  }
  if (!invocation) throw new Error('Failed to retrieve SSM command invocation result');
  if (invocation.Status !== 'Success') {
    throw new Error(`SSM command failed (status=${invocation.Status}): ${invocation.StandardErrorContent ?? ''}`);
  }
  return { stdout: invocation.StandardOutputContent ?? '', stderr: invocation.StandardErrorContent ?? '' };
}

// ─── SubmitCfdSimulation ──────────────────────────────────────────────────

interface SubmitEvent extends Partial<TreatmentPlan> {
  planName?: string;
}

async function handleSubmit(event: SubmitEvent): Promise<unknown> {
  const validation = validateTreatmentPlan(event);
  if (!validation.valid) {
    return { success: false, error: `Treatment plan validation failed: ${validation.errors.join('; ')}` };
  }
  const plan = event as TreatmentPlan;

  const jobName = `cfd-${(event.planName ?? 'plan').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24)}-${Date.now()}`;
  const script = buildCfdSlurmScript(plan, jobName, HPC_BUCKET);

  const instanceId = await findLoginNodeInstanceId();

  // Discover the Slurm partition at submit time (PCS clusters don't have a
  // fixed name) and inject it into the script, matching the sbatch flow in
  // reference/genai-demos' submitCfdSimulation.ts.
  const submitCommand = `
    export SLURM_CONF=${SLURM_CONF}
    PARTITION=$(${PCS_BIN}/sinfo -h -o "%P" | head -1 | tr -d '*')
    if [ -z "$PARTITION" ]; then
      echo "ERROR: No Slurm partitions found" >&2
      exit 1
    fi
    SCRIPT_FILE="/tmp/cfd_job_\${RANDOM}.sh"
    cat > \${SCRIPT_FILE} << 'CFD_SCRIPT_EOF'
${script}
CFD_SCRIPT_EOF
    sed -i "2i #SBATCH --partition=\${PARTITION}" \${SCRIPT_FILE}
    chmod +x \${SCRIPT_FILE}
    ${PCS_BIN}/sbatch \${SCRIPT_FILE}
    rm \${SCRIPT_FILE}
  `;

  const { stdout, stderr } = await runShellOnLoginNode(instanceId, submitCommand);
  const jobIdMatch = stdout.match(/Submitted batch job (\d+)/);
  if (!jobIdMatch) {
    throw new Error(`Failed to parse Slurm job ID from sbatch output: ${stdout || stderr}`);
  }

  return {
    success: true,
    jobId: jobIdMatch[1],
    status: 'PENDING',
    message: `CFD simulation submitted. Slurm job ID: ${jobIdMatch[1]}`,
  };
}

// ─── GetCfdJobStatus ──────────────────────────────────────────────────────

const SLURM_STATE_MAP: Record<string, 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'> = {
  PENDING: 'PENDING',
  CONFIGURING: 'PENDING',
  REQUEUED: 'PENDING',
  RESIZING: 'PENDING',
  SUSPENDED: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETING: 'RUNNING',
  STAGE_OUT: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMEOUT: 'FAILED',
  NODE_FAIL: 'FAILED',
  PREEMPTED: 'FAILED',
  OUT_OF_MEMORY: 'FAILED',
  BOOT_FAIL: 'FAILED',
  DEADLINE: 'FAILED',
  CANCELLED: 'CANCELLED',
  REVOKED: 'CANCELLED',
};

function normalizeSlurmState(rawState: string): string {
  return rawState.replace(/\+$/, '').replace(/\s+by\s+\d+$/, '').trim();
}

async function handleGetStatus(event: { jobId?: string }): Promise<unknown> {
  const { jobId } = event;
  if (!jobId) throw new Error('jobId is required');

  const instanceId = await findLoginNodeInstanceId();

  const queryCommand = `
    export SLURM_CONF=${SLURM_CONF}
    SQUEUE_OUTPUT=$(${PCS_BIN}/squeue -j ${jobId} --format="%i|%T|%M|%l" --noheader 2>/dev/null || echo "")
    if [ -n "$SQUEUE_OUTPUT" ]; then
      echo "STATE:$SQUEUE_OUTPUT"
    else
      SACCT_OUTPUT=$(${PCS_BIN}/sacct -j ${jobId} --format=JobID,State,Elapsed,Timelimit --noheader --parsable2 2>/dev/null | head -1 || echo "")
      if [ -n "$SACCT_OUTPUT" ]; then
        echo "STATE:$SACCT_OUTPUT"
      else
        S3_CHECK=$(aws s3 ls s3://\${HPC_BUCKET:-no-bucket}/cfd-simulations/${jobId}/results/ 2>/dev/null | head -1 || echo "")
        if [ -n "$S3_CHECK" ]; then
          echo "STATE:${jobId}|COMPLETED|N/A|N/A"
        else
          echo "NOT_FOUND"
        fi
      fi
    fi
  `;

  const { stdout } = await runShellOnLoginNode(instanceId, `export HPC_BUCKET="${HPC_BUCKET}"\n${queryCommand}`, 1, 1500);
  const output = stdout.trim();

  if (output === 'NOT_FOUND' || !output) {
    return { success: false, jobId, status: 'FAILED', error: `Job ${jobId} not found in Slurm queue or history` };
  }

  const fields = output.replace(/^STATE:/, '').split('|');
  const [, rawState, elapsed] = fields;
  const mappedStatus = SLURM_STATE_MAP[normalizeSlurmState(rawState ?? '')] ?? 'FAILED';

  const response: Record<string, unknown> = { success: true, jobId, status: mappedStatus };
  if (mappedStatus === 'RUNNING' && elapsed) {
    response.elapsedTime = elapsed;
  }
  if (mappedStatus === 'COMPLETED') {
    response.s3ResultPath = `s3://${HPC_BUCKET}/cfd-simulations/${jobId}/results/`;
  }
  return response;
}

// ─── GetCfdResults ────────────────────────────────────────────────────────

interface CfdMetricsJson {
  optimizationMetrics?: { proppantPlacementEfficiency?: number; fractureGeometryScore?: number; placementUniformity?: number; nearWellboreConcentration?: number };
  riskMetrics?: { screenOutRisk?: number; concentrationRisk?: number; velocityRisk?: number; pressureRisk?: number };
  confidence?: number;
  predictedMaxTreatingPressure?: number;
  simulationInfo?: { cellCount?: number; domainSize?: { x: number; y: number; z: number }; iterations?: number; finalResiduals?: Record<string, number> };
  simulationParams?: Record<string, number>;
}

async function handleGetResults(event: { jobId?: string }): Promise<unknown> {
  const { jobId } = event;
  if (!jobId) throw new Error('jobId is required');
  if (!HPC_BUCKET) throw new Error('HPC_BUCKET is not configured');

  const prefix = `cfd-simulations/${jobId}/results/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: HPC_BUCKET, Prefix: prefix }));
  const metricsKey = (listed.Contents ?? []).find((obj) => obj.Key?.endsWith('metrics.json'))?.Key;
  if (!metricsKey) {
    return { success: false, jobId, error: `No metrics.json found yet under s3://${HPC_BUCKET}/${prefix} — job may still be running` };
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: HPC_BUCKET, Key: metricsKey }));
  const raw = await object.Body!.transformToString('utf-8');
  const parsed = JSON.parse(raw) as CfdMetricsJson;

  const metrics = {
    proppantPlacementEfficiency: parsed.optimizationMetrics?.proppantPlacementEfficiency ?? 0,
    fractureGeometryScore: parsed.optimizationMetrics?.fractureGeometryScore ?? 0,
    placementUniformity: parsed.optimizationMetrics?.placementUniformity ?? 0,
    nearWellboreConcentration: parsed.optimizationMetrics?.nearWellboreConcentration,
    screenOutRisk: parsed.riskMetrics?.screenOutRisk ?? 0,
    concentrationRisk: parsed.riskMetrics?.concentrationRisk ?? 0,
    velocityRisk: parsed.riskMetrics?.velocityRisk ?? 0,
    pressureRisk: parsed.riskMetrics?.pressureRisk ?? 0,
    // predictedMaxTreatingPressure (psi) is field-derived (max inlet pressure
    // across timesteps) — only present when calculate_metrics.py ran, so the
    // agent can tell a real solve from the heuristic fallback.
    predictedMaxTreatingPressure: parsed.predictedMaxTreatingPressure,
    iterations: parsed.simulationInfo?.iterations,
    finalResiduals: parsed.simulationInfo?.finalResiduals,
    confidence: parsed.confidence ?? 0,
  };

  const s3ResultPath = `s3://${HPC_BUCKET}/${prefix}`;

  // Best-effort: mirror a summary artifact into files/artifacts/ so it shows
  // up via the /file artifact route (issue #501/#512) — non-fatal on failure.
  if (WORKSPACE_BUCKET) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: WORKSPACE_BUCKET,
        Key: `files/artifacts/cfd-simulations/${jobId}/results.json`,
        Body: JSON.stringify({ jobId, metrics, s3ResultPath }, null, 2),
        ContentType: 'application/json',
      }));
    } catch (err) {
      console.warn('Failed to mirror CFD results artifact', err);
    }
  }

  return { success: true, jobId, metrics, s3ResultPath };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

export const handler = async (event: Record<string, unknown>, context: Context): Promise<unknown> => {
  const toolName = extractToolName(context);

  try {
    switch (toolName) {
      case 'SubmitCfdSimulation':
        return await handleSubmit(event as SubmitEvent);
      case 'GetCfdJobStatus':
        return await handleGetStatus(event as { jobId?: string });
      case 'GetCfdResults':
        return await handleGetResults(event as { jobId?: string });
      default:
        throw new Error(`Unknown tool: "${toolName}"`);
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};
