import type { Schema } from '../../data/resource';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { getConfiguredAmplifyClient } from '@/../utils/amplifyUtils';

const s3Client  = new S3Client({});
const ssmClient = new SSMClient({});
const ec2Client = new EC2Client({});

// DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME is auto-injected by Amplify Gen 2 via allow.resource() in storage/resource.ts.
// STORAGE_BUCKET was manually set to 'PLACEHOLDER' in backend.ts due to cross-stack circular dependency.
const STORAGE_BUCKET = process.env.DIGITAL_OPERATIONS_STORAGE_BUCKET_NAME || process.env.STORAGE_BUCKET || '';
const CLUSTER_NAME   = process.env.CLUSTER_NAME ?? '';

const SHARED_DIR = '/shared';

async function getHeadNodeInstanceId(): Promise<string | null> {
  const resp = await ec2Client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:parallelcluster:cluster-name', Values: [CLUSTER_NAME] },
      { Name: 'tag:parallelcluster:node-type',    Values: ['HeadNode'] },
      { Name: 'instance-state-name',              Values: ['running'] },
    ],
  }));
  for (const reservation of resp.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (instance.InstanceId) return instance.InstanceId;
    }
  }
  return null;
}

interface SimulationInput {
  simulationId: string;
  name: string;
  simulationType: string;
  fracturingParams?: any;
  meshConfig: any;
  solverConfig: any;
  computeResources: any;
  parentSimulationId?: string;
  restartFromTime?: number;
}

interface GetStatusInput {
  simulationId: string;
}

interface CancelSimulationInput {
  simulationId: string;
}

interface GenerateSnapshotsInput {
  simulationId: string;
  timeSteps: number[];
}

type OperationInput = 
  | { operation: 'submitSimulation'; input: SimulationInput }
  | { operation: 'getStatus'; input: GetStatusInput }
  | { operation: 'cancelSimulation'; input: CancelSimulationInput }
  | { operation: 'generateSnapshots'; input: GenerateSnapshotsInput };

export const handler: Schema['processCfdValidation']['functionHandler'] = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const parsed = typeof event.arguments.input === 'string'
      ? JSON.parse(event.arguments.input)
      : event.arguments.input;
    
    const { operation, input } = parsed as OperationInput;
    return await dispatchOperation(operation, input);
  } catch (error) {
    console.error('Handler error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

async function dispatchOperation(operation: string, input: any) {
  switch (operation) {
    case 'submitSimulation':
      return await submitSimulation(input);
    case 'getStatus':
      return await getSimulationStatus(input.simulationId);
    case 'cancelSimulation':
      return await cancelSimulation(input.simulationId);
    case 'generateSnapshots':
      return await generateSnapshots(input.simulationId, input.timeSteps);
    default:
      return {
        success: false,
        error: `Unknown operation: ${operation}`,
      };
  }
}

async function submitSimulation(input: SimulationInput) {
  try {
    const { simulationId, name, simulationType, fracturingParams, meshConfig, solverConfig, parentSimulationId, restartFromTime } = input;

    const client = getConfiguredAmplifyClient();

    const s3Prefix = `cfd-simulations/${simulationId}`;
    
    const config = {
      simulationId,
      name,
      simulationType,
      fracturingParams,
      meshConfig,
      solverConfig,
      parentSimulationId,
      restartFromTime,
      s3Bucket: STORAGE_BUCKET,
      s3Prefix,
    };

    await s3Client.send(new PutObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: `${s3Prefix}/config.json`,
      Body: JSON.stringify(config, null, 2),
      ContentType: 'application/json',
    }));

    const jobScript = generateSlurmScript(config);
    
    await s3Client.send(new PutObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: `${s3Prefix}/job.sh`,
      Body: jobScript,
      ContentType: 'text/plain',
    }));

    const headNodeId = await getHeadNodeInstanceId();
    if (!headNodeId) {
      throw new Error('Head node not found. Cluster may not be running.');
    }

    const jobDir = `${SHARED_DIR}/jobs/${simulationId}`;
    const commands = [
      `mkdir -p ${jobDir}`,
      `aws s3 cp s3://${STORAGE_BUCKET}/${s3Prefix}/config.json ${jobDir}/`,
      `aws s3 cp s3://${STORAGE_BUCKET}/${s3Prefix}/job.sh ${jobDir}/`,
      `chmod +x ${jobDir}/job.sh`,
      `cd ${jobDir}`,
      `sbatch job.sh`,
    ];

    const ssmResp = await ssmClient.send(new SendCommandCommand({
      InstanceIds: [headNodeId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands },
    }));

    const commandId = ssmResp.Command?.CommandId;

    await client.models.CFDSimulation.update({
      id: simulationId,
      status: 'queued',
      clusterJobId: commandId,
      submittedAt: new Date().toISOString(),
    });

    return {
      success: true,
      simulationId,
      commandId,
      message: 'Simulation submitted successfully',
    };
  } catch (error) {
    console.error('Submit simulation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function getSimulationStatus(simulationId: string) {
  try {
    const client = getConfiguredAmplifyClient();
    
    const { data: simulation } = await client.models.CFDSimulation.get({ id: simulationId });
    
    if (!simulation) {
      return {
        success: false,
        error: 'Simulation not found',
      };
    }

    return {
      success: true,
      status: simulation.status,
      progress: simulation.progress,
      message: simulation.errorMessage,
    };
  } catch (error) {
    console.error('Get status error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function cancelSimulation(simulationId: string) {
  try {
    const client = getConfiguredAmplifyClient();
    
    const { data: simulation } = await client.models.CFDSimulation.get({ id: simulationId });
    
    if (!simulation || !simulation.clusterJobId) {
      return {
        success: false,
        error: 'Simulation not found or not submitted',
      };
    }

    const headNodeId = await getHeadNodeInstanceId();
    if (!headNodeId) {
      throw new Error('Head node not found');
    }

    await ssmClient.send(new SendCommandCommand({
      InstanceIds: [headNodeId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: [`scancel ${simulation.clusterJobId}`],
      },
    }));

    await client.models.CFDSimulation.update({
      id: simulationId,
      status: 'cancelled',
      errorMessage: 'Cancelled by user',
    });

    return {
      success: true,
      message: 'Simulation cancelled',
    };
  } catch (error) {
    console.error('Cancel simulation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function generateSnapshots(simulationId: string, timeSteps: number[]) {
  try {
    const s3Prefix = `cfd-simulations/${simulationId}`;
    
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: STORAGE_BUCKET,
      Prefix: `${s3Prefix}/results/`,
    }));

    const snapshots = [];
    for (const obj of listResp.Contents ?? []) {
      if (obj.Key?.endsWith('.vtk') || obj.Key?.endsWith('.vtu')) {
        snapshots.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }
    }

    return {
      success: true,
      snapshots,
      count: snapshots.length,
    };
  } catch (error) {
    console.error('Generate snapshots error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function generateSlurmScript(config: any): string {
  return `#!/bin/bash
#SBATCH --job-name=${config.simulationId}
#SBATCH --output=${SHARED_DIR}/jobs/${config.simulationId}/slurm-%j.out
#SBATCH --error=${SHARED_DIR}/jobs/${config.simulationId}/slurm-%j.err
#SBATCH --nodes=${config.solverConfig?.nodes || 1}
#SBATCH --ntasks-per-node=${config.solverConfig?.coresPerNode || 4}
#SBATCH --time=${config.solverConfig?.wallTime || '01:00:00'}

# Load OpenFOAM environment
source /opt/openfoam/etc/bashrc

# Run simulation
cd ${SHARED_DIR}/jobs/${config.simulationId}
mpirun -np $SLURM_NTASKS simpleFoam -parallel

# Upload results to S3
aws s3 sync . s3://${config.s3Bucket}/${config.s3Prefix}/results/ --exclude "*" --include "*.vtk" --include "*.vtu"
`;
}
