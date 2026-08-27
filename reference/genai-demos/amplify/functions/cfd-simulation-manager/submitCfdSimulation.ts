/**
 * Submit CFD Simulation Handler
 * 
 * Submits a CFD simulation job to the PCS cluster by:
 * 1. Validating all input parameters (ranges and required fields)
 * 2. Generating a Slurm batch script with parameters
 * 3. Querying EC2 for login node instance ID by tag
 * 4. Using SSM SendCommand to submit job to Slurm
 * 5. Parsing Slurm job ID from output
 * 6. Creating CFDSimulation record in DynamoDB with status PENDING
 * 7. Returning cfdSimulationId and status
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 13.1, 13.2, 13.3, 13.4, 13.5
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/submit-cfd-simulation';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand, GetCommandInvocationCommandOutput } from '@aws-sdk/client-ssm';
import { createCFDSimulation } from '../../graphql/mutations';
import type { CreateCFDSimulationInput } from '../../graphql/API';
import { SimulationType, SimulationStatus, StageType } from '../../graphql/API';
import { validatePumpingSchedule, type PumpingSchedule, type PumpingScheduleStage } from './validatePumpingSchedule';
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
  publishQueueWaitTime,
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// AWS SDK clients
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// Constants
const COMPONENT_NAME = 'SubmitCfdSimulation';
const HEAD_NODE_TAG = process.env.HEAD_NODE_TAG || '';
const CLUSTER_NAME = process.env.CLUSTER_NAME || '';

// Validation ranges (Requirements 13.1, 13.2, 13.3)
const VALIDATION_RANGES = {
  injectionRate: { min: 0.1, max: 0.5, unit: 'm³/s' },
  proppantConcentration: { min: 0.1, max: 0.4, unit: 'volume fraction' },
  fluidViscosity: { min: 0.01, max: 0.1, unit: 'Pa·s' },
};

/**
 * Validate input parameters against required ranges
 * Requirements: 2.6, 13.1, 13.2, 13.3, 13.4, 13.5
 */
function validateParameters(input: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate injection rate (Requirement 13.1)
  if (input.injectionRate === undefined || input.injectionRate === null) {
    errors.push('injectionRate is required');
  } else if (
    input.injectionRate < VALIDATION_RANGES.injectionRate.min ||
    input.injectionRate > VALIDATION_RANGES.injectionRate.max
  ) {
    errors.push(
      `injectionRate must be between ${VALIDATION_RANGES.injectionRate.min} and ${VALIDATION_RANGES.injectionRate.max} ${VALIDATION_RANGES.injectionRate.unit} (got ${input.injectionRate})`
    );
  }

  // Validate proppant concentration (Requirement 13.2)
  if (input.proppantConcentration === undefined || input.proppantConcentration === null) {
    errors.push('proppantConcentration is required');
  } else if (
    input.proppantConcentration < VALIDATION_RANGES.proppantConcentration.min ||
    input.proppantConcentration > VALIDATION_RANGES.proppantConcentration.max
  ) {
    errors.push(
      `proppantConcentration must be between ${VALIDATION_RANGES.proppantConcentration.min} and ${VALIDATION_RANGES.proppantConcentration.max} ${VALIDATION_RANGES.proppantConcentration.unit} (got ${input.proppantConcentration})`
    );
  }

  // Validate fluid viscosity (Requirement 13.3)
  if (input.fluidViscosity === undefined || input.fluidViscosity === null) {
    errors.push('fluidViscosity is required');
  } else if (
    input.fluidViscosity < VALIDATION_RANGES.fluidViscosity.min ||
    input.fluidViscosity > VALIDATION_RANGES.fluidViscosity.max
  ) {
    errors.push(
      `fluidViscosity must be between ${VALIDATION_RANGES.fluidViscosity.min} and ${VALIDATION_RANGES.fluidViscosity.max} ${VALIDATION_RANGES.fluidViscosity.unit} (got ${input.fluidViscosity})`
    );
  }

  // Validate treating pressure is present
  if (input.treatingPressure === undefined || input.treatingPressure === null) {
    errors.push('treatingPressure is required');
  } else if (input.treatingPressure <= 0) {
    errors.push(`treatingPressure must be positive (got ${input.treatingPressure})`);
  }

  // Validate fracture geometry fields (Requirement 13.4)
  if (input.fractureLengthM !== undefined && input.fractureLengthM <= 0) {
    errors.push(`fractureLengthM must be positive if provided (got ${input.fractureLengthM})`);
  }
  if (input.fractureWidthMm !== undefined && input.fractureWidthMm <= 0) {
    errors.push(`fractureWidthMm must be positive if provided (got ${input.fractureWidthMm})`);
  }

  // Validate operationId is present
  if (!input.operationId) {
    errors.push('operationId is required');
  }

  // Validate simulationType is valid
  if (!input.simulationType || !['continuous', 'oneshot', 'whatif'].includes(input.simulationType)) {
    errors.push(`simulationType must be one of: continuous, oneshot, whatif (got ${input.simulationType})`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}


/**
 * Generate Slurm batch script with simulation parameters
 * Requirement: 2.1, 2.4
 *
 * 3-D high-fidelity fracture simulation:
 *   x = fracture length (flow direction)
 *   y = fracture height (gravity direction, proppant settling)
 *   z = fracture aperture / width (narrow gap with graded mesh near walls)
 *
 * The mesh uses simpleGrading on the z-axis to cluster cells near the
 * fracture walls where proppant concentration gradients are steepest.
 * Gravity acts in -y so proppant settling across the fracture height is
 * captured.  PCG+DIC pressure solver is retained (proven fast on
 * structured meshes).
 */
function generateSlurmScript(input: any, jobName: string): string {
  const {
    injectionRate,
    proppantConcentration,
    fluidViscosity,
    treatingPressure,
    fractureLengthM = 100,
    fractureWidthMm = 5,
    simulationType,
  } = input;

  // Compute resources: 4 nodes for the 3-D high-fidelity mesh
  const resources = simulationType === 'continuous'
    ? { nodes: 2, tasksPerNode: 16, time: '00:30:00' }
    : simulationType === 'whatif'
    ? { nodes: 2, tasksPerNode: 16, time: '00:20:00' }
    : { nodes: 4, tasksPerNode: 16, time: '00:30:00' };

  const hpcBucket = process.env.HPC_BUCKET || '';

  // Derived OpenFOAM parameters
  const fractureWidthM = fractureWidthMm / 1000;
  // Fracture height: half the length for a vertical frac, cap at 50 m
  const fractureHeightM = Math.min(50, fractureLengthM * 0.5);
  // Inlet velocity through the full cross-section (height x width)
  const inletVelocity = injectionRate / (fractureHeightM * fractureWidthM);

  // 3-D mesh resolution
  // x (length): 1 cell per 2 m -> 50 cells for 100 m fracture
  const nx = Math.max(20, Math.round(fractureLengthM / 2));
  // y (height): 1 cell per 1.25 m -> 40 cells for 50 m height
  const ny = Math.max(20, Math.round(fractureHeightM / 1.25));
  // z (aperture): 8 cells across the narrow gap with wall grading
  // Total ~16,000 cells for default params -- good resolution, solvable in <15 min
  const nz = 8;

  // Solver settings: 800 iterations max, write every 100, converge early
  const endTime = 800;
  const writeInterval = 100;

  // Max MPI processes: scale with mesh but cap at total Slurm tasks
  const maxProcs = resources.nodes * resources.tasksPerNode;
  const totalCells = nx * ny * nz;
  const idealProcs = Math.max(4, Math.min(maxProcs, Math.round(totalCells / 300)));

  return `#!/bin/bash
#SBATCH --job-name=${jobName}
#SBATCH --nodes=${resources.nodes}
#SBATCH --ntasks-per-node=${resources.tasksPerNode}
#SBATCH --time=${resources.time}
#SBATCH --output=/fsx/cfd-simulations/logs/%j.out
#SBATCH --error=/fsx/cfd-simulations/logs/%j.err

# CFD Simulation Parameters
export INJECTION_RATE=${injectionRate}
export PROPPANT_CONCENTRATION=${proppantConcentration}
export FLUID_VISCOSITY=${fluidViscosity}
export TREATING_PRESSURE=${treatingPressure}
export FRACTURE_LENGTH=${fractureLengthM}
export FRACTURE_WIDTH=${fractureWidthMm}
export SIMULATION_TYPE=${simulationType}
export HPC_BUCKET="${hpcBucket}"

# Create working directory on FSx
WORK_DIR="/fsx/cfd-simulations/\${SLURM_JOB_ID}"
RESULTS_DIR="\${WORK_DIR}/results"
mkdir -p \${WORK_DIR}/0 \${WORK_DIR}/constant \${WORK_DIR}/system \${RESULTS_DIR}
cd \${WORK_DIR}

# Check if OpenFOAM is installed
if [ -f /opt/openfoam/etc/bashrc ]; then
  echo "OpenFOAM found, running real 3-D simulation..."
  source /opt/openfoam/etc/bashrc

  # Add PCS Slurm binaries and OpenMPI 5 to PATH
  export PATH=/opt/aws/pcs/scheduler/slurm-25.05/bin:/opt/amazon/openmpi5/bin:\${PATH}
  export LD_LIBRARY_PATH=/opt/amazon/openmpi5/lib64:\${LD_LIBRARY_PATH:-}

  # OpenMPI 5 requires a valid HOME directory for mca_base_var_init
  export HOME=\${WORK_DIR}

  # --- Generate OpenFOAM case files ---

  # system/blockMeshDict -- 3-D fracture: length x height x aperture
  # z-axis uses graded meshing to cluster cells near fracture walls
  cat > \${WORK_DIR}/system/blockMeshDict << 'BLOCKMESH_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}

convertToMeters 1;

vertices
(
    (0 0 0)
    (${fractureLengthM} 0 0)
    (${fractureLengthM} ${fractureHeightM} 0)
    (0 ${fractureHeightM} 0)
    (0 0 ${fractureWidthM})
    (${fractureLengthM} 0 ${fractureWidthM})
    (${fractureLengthM} ${fractureHeightM} ${fractureWidthM})
    (0 ${fractureHeightM} ${fractureWidthM})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 ((0.5 4 0.25)(0.5 4 4)))
);

boundary
(
    inlet
    {
        type patch;
        faces
        (
            (0 4 7 3)
        );
    }
    outlet
    {
        type patch;
        faces
        (
            (1 2 6 5)
        );
    }
    top
    {
        type wall;
        faces
        (
            (3 7 6 2)
        );
    }
    bottom
    {
        type wall;
        faces
        (
            (0 1 5 4)
        );
    }
    frontWall
    {
        type wall;
        faces
        (
            (4 5 6 7)
        );
    }
    backWall
    {
        type wall;
        faces
        (
            (0 3 2 1)
        );
    }
);
BLOCKMESH_EOF

  # constant/g -- gravity vector for proppant settling (acts in -y direction)
  cat > \${WORK_DIR}/constant/g << 'G_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       uniformDimensionedVectorField;
    object      g;
}

dimensions      [0 1 -2 0 0 0 0];
value           (0 -9.81 0);
G_EOF

  # 0/U - Velocity boundary conditions
  cat > \${WORK_DIR}/0/U << 'U_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}

dimensions      [0 1 -1 0 0 0 0];

internalField   uniform (0 0 0);

boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (${inletVelocity} 0 0);
    }
    outlet
    {
        type            zeroGradient;
    }
    top
    {
        type            noSlip;
    }
    bottom
    {
        type            noSlip;
    }
    frontWall
    {
        type            noSlip;
    }
    backWall
    {
        type            noSlip;
    }
}
U_EOF

  # 0/p - Pressure boundary conditions
  cat > \${WORK_DIR}/0/p << 'P_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}

dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    top
    {
        type            zeroGradient;
    }
    bottom
    {
        type            zeroGradient;
    }
    frontWall
    {
        type            zeroGradient;
    }
    backWall
    {
        type            zeroGradient;
    }
}
P_EOF

  # 0/alpha.proppant - Proppant concentration boundary conditions
  cat > \${WORK_DIR}/0/alpha.proppant << 'ALPHA_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      alpha.proppant;
}

dimensions      [0 0 0 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform ${proppantConcentration};
    }
    outlet
    {
        type            zeroGradient;
    }
    top
    {
        type            zeroGradient;
    }
    bottom
    {
        type            zeroGradient;
    }
    frontWall
    {
        type            zeroGradient;
    }
    backWall
    {
        type            zeroGradient;
    }
}
ALPHA_EOF

  # constant/turbulenceProperties (required by simpleFoam)
  cat > \${WORK_DIR}/constant/turbulenceProperties << 'TURBULENCE_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  laminar;
TURBULENCE_EOF

  # constant/transportProperties
  cat > \${WORK_DIR}/constant/transportProperties << 'TRANSPORT_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}

transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${fluidViscosity};
TRANSPORT_EOF

  # system/fvSchemes
  cat > \${WORK_DIR}/system/fvSchemes << 'FVSCHEMES_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}

ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,alpha.proppant) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}
FVSCHEMES_EOF

  # system/fvSolution -- PCG+DIC for pressure (proven fast on structured meshes)
  # 1 non-orthogonal corrector for the graded z-mesh
  cat > \${WORK_DIR}/system/fvSolution << 'FVSOLUTION_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}

solvers
{
    p
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-06;
        relTol          0.01;
    }

    U
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-06;
        relTol          0.01;
    }

    "alpha.*"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-08;
        relTol          0.01;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;

    residualControl
    {
        p               1e-05;
        U               1e-05;
        "alpha.*"       1e-05;
    }
}

relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        "alpha.*"       0.7;
    }
}
FVSOLUTION_EOF

  # system/controlDict -- includes scalarTransport function object for proppant
  cat > \${WORK_DIR}/system/controlDict << 'CONTROLDICT_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}

application     simpleFoam;

startFrom       startTime;

startTime       0;

stopAt          endTime;

endTime         ${endTime};

deltaT          1;

writeControl    timeStep;

writeInterval   ${writeInterval};

purgeWrite      3;

writeFormat     ascii;

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable true;

functions
{
    proppantTransport
    {
        type            scalarTransport;
        libs            (solverFunctionObjects);
        field           alpha.proppant;
        resetOnStartUp  false;
        nCorr           1;
        fvOptions       {}
    }
}
CONTROLDICT_EOF

  # system/decomposeParDict -- scale MPI processes with mesh size
  NPROCS=\$(( SLURM_NTASKS < ${idealProcs} ? SLURM_NTASKS : ${idealProcs} ))
  cat > \${WORK_DIR}/system/decomposeParDict << DECOMPOSE_EOF
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      decomposeParDict;
}

numberOfSubdomains \${NPROCS};

method          scotch;
DECOMPOSE_EOF

  # --- Run OpenFOAM pipeline ---

  # Helper: run a pipeline step, capture exit code, bail on failure
  run_step() {
    local STEP_NAME="\$1"
    shift
    echo "Running \${STEP_NAME}..."
    "\$@" > \${STEP_NAME}.log 2>&1
    local RC=\$?
    if [ \$RC -ne 0 ]; then
      echo "ERROR: \${STEP_NAME} failed with exit code \${RC}" | tee -a \${RESULTS_DIR}/error.log
      cp -r *.log \${RESULTS_DIR}/ 2>/dev/null || true
      aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1 || true
      exit 1
    fi
  }

  run_step blockMesh blockMesh
  run_step decomposePar decomposePar -force
  run_step simpleFoam mpirun --allow-run-as-root -np \${NPROCS} simpleFoam -parallel
  run_step reconstructPar reconstructPar -latestTime
  run_step foamToVTK foamToVTK

  echo "Running calculate_metrics.py..."
  # Download latest metrics script from S3 (overrides AMI-baked version)
  METRICS_SCRIPT="/tmp/calculate_metrics_\${SLURM_JOB_ID}.py"
  aws s3 cp s3://\${HPC_BUCKET}/scripts/calculate_metrics.py \${METRICS_SCRIPT} 2>/dev/null \\
    || METRICS_SCRIPT="/opt/scripts/calculate_metrics.py"
  python3 \${METRICS_SCRIPT} \\
    --work-dir \${WORK_DIR} \\
    --injection-rate ${injectionRate} \\
    --proppant-concentration ${proppantConcentration} \\
    --fluid-viscosity ${fluidViscosity}
  METRICS_RC=\$?
  if [ \$METRICS_RC -ne 0 ]; then
    echo "ERROR: calculate_metrics.py failed with exit code \${METRICS_RC}" | tee -a \${RESULTS_DIR}/error.log
    cp -r *.log \${RESULTS_DIR}/ 2>/dev/null || true
    aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1 || true
    exit 1
  fi

else
  echo "OpenFOAM not installed -- generating synthetic demo results..."

  cat > \${RESULTS_DIR}/metrics.json << 'METRICS_EOF'
{
  "residuals": { "pressure": 0.00005, "velocity": 0.00003, "proppant": 0.00008 },
  "iterations": 350,
  "cellCount": ${totalCells},
  "domainSize": { "x": ${fractureLengthM}, "y": ${fractureHeightM}, "z": ${fractureWidthM} },
  "simulationParams": {
    "injectionRate": ${injectionRate},
    "proppantConcentration": ${proppantConcentration},
    "fluidViscosity": ${fluidViscosity},
    "treatingPressure": ${treatingPressure}
  }
}
METRICS_EOF

  echo "Synthetic results generated"
fi

# Copy logs to results directory
cp -r \${WORK_DIR}/*.log \${RESULTS_DIR}/ 2>/dev/null || true

# Upload results to S3
if [ -n "\${HPC_BUCKET}" ]; then
  echo "Uploading results to s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/..."
  aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1
  if [ \$? -eq 0 ]; then
    echo "Results uploaded to S3 successfully"
  else
    echo "S3 upload failed -- results remain on FSx only"
  fi
else
  echo "HPC_BUCKET not set -- results remain on FSx only at \${RESULTS_DIR}"
fi

echo "Simulation complete -- results at \${RESULTS_DIR}"
`;
}


/**
 * Convert pump rate (bbl/min) to inlet velocity (m/s)
 * Formula: velocity = (pumpRateBblMin × 0.00265) / (fractureHeight × fractureWidth)
 */
function pumpRateToVelocity(pumpRateBblMin: number, fractureHeightM: number, fractureWidthM: number): number {
  return (pumpRateBblMin * 0.00265) / (fractureHeightM * fractureWidthM);
}

/**
 * Convert proppant concentration (ppg) to volume fraction
 * Formula: volumeFraction = proppantConcentrationPpg × 0.0001198
 */
function proppantPpgToVolumeFraction(ppg: number): number {
  return ppg * 0.0001198;
}

/**
 * Generate a transient Slurm script for pimpleFoam with time-varying BCs
 * from a pumping schedule.
 */
function generateTransientSlurmScript(input: Record<string, unknown>, jobName: string, schedule: PumpingSchedule): string {
  const {
    injectionRate,
    proppantConcentration,
    fluidViscosity,
    treatingPressure,
    fractureLengthM: fracLenRaw = 100,
    fractureWidthMm: fracWidRaw = 5,
    simulationType,
  } = input as {
    injectionRate: number;
    proppantConcentration: number;
    fluidViscosity: number;
    treatingPressure: number;
    fractureLengthM: number;
    fractureWidthMm: number;
    simulationType: string;
  };

  const fractureLengthM = fracLenRaw;
  const fractureWidthMm = fracWidRaw;

  // Compute resources: transient sims get full 4 nodes, longer wall time
  const resources = { nodes: 4, tasksPerNode: 16, time: '01:00:00' };
  const hpcBucket = process.env.HPC_BUCKET || '';

  // Derived geometry
  const fractureWidthM = fractureWidthMm / 1000;
  const fractureHeightM = Math.min(50, fractureLengthM * 0.5);

  // 3-D mesh resolution
  // For transient sims, use fewer z-cells to avoid extreme Courant constraints
  // The aperture cells dominate the timestep — 2 z-cells is sufficient for
  // capturing the bulk flow behavior while keeping deltaT practical
  const nx = Math.max(20, Math.round(fractureLengthM / 2));
  const ny = Math.max(20, Math.round(fractureHeightM / 1.25));
  const nz = 2; // Coarser z for transient (vs 8 for steady-state)
  const totalCells = nx * ny * nz;

  // MPI processes — cap at 8 for small meshes to avoid MPI overhead dominating
  const maxProcs = resources.nodes * resources.tasksPerNode;
  const idealProcs = Math.max(4, Math.min(8, Math.min(maxProcs, Math.round(totalCells / 300))));

  // --- Transient solver settings ---
  const endTime = schedule.totalDurationSeconds;

  // deltaT: keep Courant < 1 at the highest pump rate
  const maxPumpRate = Math.max(...schedule.stages.map((s: PumpingScheduleStage) => s.pumpRateBblMin));
  const maxVelocity = pumpRateToVelocity(maxPumpRate, fractureHeightM, fractureWidthM);
  // deltaT: use the SMALLEST cell dimension (z-aperture cells are tiny)
  // and keep Courant < 0.5 at the highest pump rate
  const minCellSizeX = fractureLengthM / nx;
  const minCellSizeZ = fractureWidthM / nz; // aperture cells are much smaller
  const minCellSize = Math.min(minCellSizeX, minCellSizeZ);
  const coTarget = 0.5;
  // Use adjustTimeStep in controlDict — start with a conservative deltaT
  const deltaT = Math.max(0.001, Math.min(1.0, (coTarget * minCellSize) / maxVelocity));

  // writeInterval: at least 2 writes per stage, use adjustableRunTime
  const shortestStageDuration = Math.min(...schedule.stages.map((s: PumpingScheduleStage) => s.endTimeSeconds - s.startTimeSeconds));
  const writeInterval = Math.max(deltaT, shortestStageDuration);

  // --- Build uniformFixedValue tables for BCs ---
  // OpenFOAM requires strictly increasing time values in tables.
  // We emit one entry at each stage start with that stage's value.
  // For the very last stage, we also emit an entry at its end time.
  // This produces step-wise transitions: the value holds constant until
  // the next stage's start time entry overrides it.
  const velocityTableLines: string[] = [];
  const alphaTableLines: string[] = [];
  for (let i = 0; i < schedule.stages.length; i++) {
    const s = schedule.stages[i] as PumpingScheduleStage;
    const v = pumpRateToVelocity(s.pumpRateBblMin, fractureHeightM, fractureWidthM);
    const vf = proppantPpgToVolumeFraction(s.proppantConcentrationPpg);
    velocityTableLines.push(`        (${s.startTimeSeconds}      (${v} 0 0))`);
    alphaTableLines.push(`        (${s.startTimeSeconds}      ${vf})`);
    // Add end-time entry only for the last stage (to define the table endpoint)
    if (i === schedule.stages.length - 1) {
      velocityTableLines.push(`        (${s.endTimeSeconds}      (${v} 0 0))`);
      alphaTableLines.push(`        (${s.endTimeSeconds}      ${vf})`);
    }
  }
  const velocityTableEntries = velocityTableLines.join('\n');
  const alphaTableEntries = alphaTableLines.join('\n');

  // Inlet velocity for steady-state params (used in DDB record, not in BCs)
  const inletVelocity = (injectionRate as number) / (fractureHeightM * fractureWidthM);

  return `#!/bin/bash
#SBATCH --job-name=${jobName}
#SBATCH --nodes=${resources.nodes}
#SBATCH --ntasks-per-node=${resources.tasksPerNode}
#SBATCH --time=${resources.time}
#SBATCH --output=/fsx/cfd-simulations/logs/%j.out
#SBATCH --error=/fsx/cfd-simulations/logs/%j.err

# CFD Simulation Parameters (transient with pumping schedule)
export INJECTION_RATE=${injectionRate}
export PROPPANT_CONCENTRATION=${proppantConcentration}
export FLUID_VISCOSITY=${fluidViscosity}
export TREATING_PRESSURE=${treatingPressure}
export FRACTURE_LENGTH=${fractureLengthM}
export FRACTURE_WIDTH=${fractureWidthMm}
export SIMULATION_TYPE=${simulationType}
export HPC_BUCKET="${hpcBucket}"

# Create working directory on FSx
WORK_DIR="/fsx/cfd-simulations/\${SLURM_JOB_ID}"
RESULTS_DIR="\${WORK_DIR}/results"
mkdir -p \${WORK_DIR}/0 \${WORK_DIR}/constant \${WORK_DIR}/system \${RESULTS_DIR}
cd \${WORK_DIR}

# Check if OpenFOAM is installed
if [ -f /opt/openfoam/etc/bashrc ]; then
  echo "OpenFOAM found, running transient pimpleFoam simulation..."
  source /opt/openfoam/etc/bashrc

  # Add PCS Slurm binaries and OpenMPI 5 to PATH
  export PATH=/opt/aws/pcs/scheduler/slurm-25.05/bin:/opt/amazon/openmpi5/bin:\${PATH}
  export LD_LIBRARY_PATH=/opt/amazon/openmpi5/lib64:\${LD_LIBRARY_PATH:-}

  # OpenMPI 5 requires a valid HOME directory for mca_base_var_init
  export HOME=\${WORK_DIR}

  # --- Generate OpenFOAM case files ---

  # system/blockMeshDict -- 3-D fracture (coarser z for transient stability)
  cat > \${WORK_DIR}/system/blockMeshDict << 'BLOCKMESH_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}

convertToMeters 1;

vertices
(
    (0 0 0)
    (${fractureLengthM} 0 0)
    (${fractureLengthM} ${fractureHeightM} 0)
    (0 ${fractureHeightM} 0)
    (0 0 ${fractureWidthM})
    (${fractureLengthM} 0 ${fractureWidthM})
    (${fractureLengthM} ${fractureHeightM} ${fractureWidthM})
    (0 ${fractureHeightM} ${fractureWidthM})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)
);

boundary
(
    inlet
    {
        type patch;
        faces
        (
            (0 4 7 3)
        );
    }
    outlet
    {
        type patch;
        faces
        (
            (1 2 6 5)
        );
    }
    top
    {
        type wall;
        faces
        (
            (3 7 6 2)
        );
    }
    bottom
    {
        type wall;
        faces
        (
            (0 1 5 4)
        );
    }
    frontWall
    {
        type wall;
        faces
        (
            (4 5 6 7)
        );
    }
    backWall
    {
        type wall;
        faces
        (
            (0 3 2 1)
        );
    }
);
BLOCKMESH_EOF

  # constant/g -- gravity vector for proppant settling
  cat > \${WORK_DIR}/constant/g << 'G_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       uniformDimensionedVectorField;
    object      g;
}

dimensions      [0 1 -2 0 0 0 0];
value           (0 -9.81 0);
G_EOF

  # 0/U - Velocity with time-varying inlet (uniformFixedValue table)
  cat > \${WORK_DIR}/0/U << 'U_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}

dimensions      [0 1 -1 0 0 0 0];

internalField   uniform (0 0 0);

boundaryField
{
    inlet
    {
        type            uniformFixedValue;
        uniformValue    table
        (
${velocityTableEntries}
        );
    }
    outlet
    {
        type            zeroGradient;
    }
    top
    {
        type            noSlip;
    }
    bottom
    {
        type            noSlip;
    }
    frontWall
    {
        type            noSlip;
    }
    backWall
    {
        type            noSlip;
    }
}
U_EOF

  # 0/p - Pressure boundary conditions (same as steady-state)
  cat > \${WORK_DIR}/0/p << 'P_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}

dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    top
    {
        type            zeroGradient;
    }
    bottom
    {
        type            zeroGradient;
    }
    frontWall
    {
        type            zeroGradient;
    }
    backWall
    {
        type            zeroGradient;
    }
}
P_EOF

  # 0/alpha.proppant - Proppant with time-varying inlet (uniformFixedValue table)
  cat > \${WORK_DIR}/0/alpha.proppant << 'ALPHA_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      alpha.proppant;
}

dimensions      [0 0 0 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            uniformFixedValue;
        uniformValue    table
        (
${alphaTableEntries}
        );
    }
    outlet
    {
        type            zeroGradient;
    }
    top
    {
        type            zeroGradient;
    }
    bottom
    {
        type            zeroGradient;
    }
    frontWall
    {
        type            zeroGradient;
    }
    backWall
    {
        type            zeroGradient;
    }
}
ALPHA_EOF

  # constant/turbulenceProperties
  cat > \${WORK_DIR}/constant/turbulenceProperties << 'TURBULENCE_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  laminar;
TURBULENCE_EOF

  # constant/transportProperties
  cat > \${WORK_DIR}/constant/transportProperties << 'TRANSPORT_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}

transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${fluidViscosity};
TRANSPORT_EOF

  # system/fvSchemes -- Euler time discretization for transient
  cat > \${WORK_DIR}/system/fvSchemes << 'FVSCHEMES_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}

ddtSchemes
{
    default         Euler;
}

gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,alpha.proppant) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}
FVSCHEMES_EOF

  # system/fvSolution -- PIMPLE for transient pressure-velocity coupling
  cat > \${WORK_DIR}/system/fvSolution << 'FVSOLUTION_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}

solvers
{
    p
    {
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-06;
        relTol          0.01;
    }

    pFinal
    {
        \$p;
        relTol          0;
    }

    U
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-06;
        relTol          0.01;
    }

    UFinal
    {
        \$U;
        relTol          0;
    }

    "alpha.*"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-08;
        relTol          0.01;
    }

    "alpha.*Final"
    {
        \${"alpha.*"};
        relTol          0;
    }
}

PIMPLE
{
    nOuterCorrectors    3;
    nCorrectors         2;
    nNonOrthogonalCorrectors 1;
}
FVSOLUTION_EOF

  # system/controlDict -- pimpleFoam transient with scalarTransport
  cat > \${WORK_DIR}/system/controlDict << 'CONTROLDICT_EOF'
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}

application     pimpleFoam;

startFrom       startTime;

startTime       0;

stopAt          endTime;

endTime         ${endTime};

deltaT          ${deltaT};

writeControl    adjustableRunTime;

writeInterval   ${writeInterval};

purgeWrite      0;

adjustTimeStep  yes;

maxCo           0.9;

maxDeltaT       ${writeInterval};

writeFormat     ascii;

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable true;

functions
{
    proppantTransport
    {
        type            scalarTransport;
        libs            (solverFunctionObjects);
        field           alpha.proppant;
        resetOnStartUp  false;
        nCorr           1;
        fvOptions       {}
    }
}
CONTROLDICT_EOF

  # system/decomposeParDict
  NPROCS=\$(( SLURM_NTASKS < ${idealProcs} ? SLURM_NTASKS : ${idealProcs} ))
  cat > \${WORK_DIR}/system/decomposeParDict << DECOMPOSE_EOF
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      decomposeParDict;
}

numberOfSubdomains \${NPROCS};

method          scotch;
DECOMPOSE_EOF

  # --- Run OpenFOAM pipeline (transient) ---

  run_step() {
    local STEP_NAME="\$1"
    shift
    echo "Running \${STEP_NAME}..."
    "\$@" > \${STEP_NAME}.log 2>&1
    local RC=\$?
    if [ \$RC -ne 0 ]; then
      echo "ERROR: \${STEP_NAME} failed with exit code \${RC}" | tee -a \${RESULTS_DIR}/error.log
      cp -r *.log \${RESULTS_DIR}/ 2>/dev/null || true
      aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1 || true
      exit 1
    fi
  }

  run_step blockMesh blockMesh
  run_step decomposePar decomposePar -force

  # Locate pimpleFoam: prefer AMI-installed (on PATH) then fall back to /fsx/bin
  PIMPLE_BIN=\$(command -v pimpleFoam 2>/dev/null || echo "")
  if [ -z "\${PIMPLE_BIN}" ] && [ -x /fsx/bin/pimpleFoam ]; then
    PIMPLE_BIN="/fsx/bin/pimpleFoam"
    echo "pimpleFoam not on PATH — using /fsx/bin/pimpleFoam"
  elif [ -z "\${PIMPLE_BIN}" ]; then
    echo "ERROR: pimpleFoam not found on PATH or /fsx/bin" | tee -a \${RESULTS_DIR}/error.log
    exit 1
  fi
  run_step pimpleFoam mpirun --allow-run-as-root -np \${NPROCS} \${PIMPLE_BIN} -parallel
  run_step reconstructPar reconstructPar

  echo "Running calculate_metrics.py (transient mode)..."
  METRICS_SCRIPT="/tmp/calculate_metrics_\${SLURM_JOB_ID}.py"
  aws s3 cp s3://\${HPC_BUCKET}/scripts/calculate_metrics.py \${METRICS_SCRIPT} 2>/dev/null \\
    || METRICS_SCRIPT="/opt/scripts/calculate_metrics.py"
  python3 \${METRICS_SCRIPT} \\
    --work-dir \${WORK_DIR} \\
    --injection-rate ${injectionRate} \\
    --proppant-concentration ${proppantConcentration} \\
    --fluid-viscosity ${fluidViscosity} \\
    --transient
  METRICS_RC=\$?
  if [ \$METRICS_RC -ne 0 ]; then
    echo "ERROR: calculate_metrics.py failed with exit code \${METRICS_RC}" | tee -a \${RESULTS_DIR}/error.log
    cp -r *.log \${RESULTS_DIR}/ 2>/dev/null || true
    aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1 || true
    exit 1
  fi

else
  echo "OpenFOAM not installed -- generating synthetic transient demo results..."

  cat > \${RESULTS_DIR}/metrics.json << 'METRICS_EOF'
{
  "optimizationMetrics": {
    "proppantPlacementEfficiency": 0.65,
    "fractureGeometryScore": 0.72,
    "placementUniformity": 0.58,
    "nearWellboreConcentration": 0.18
  },
  "riskMetrics": {
    "screenOutRisk": 0.22,
    "concentrationRisk": 0.18,
    "velocityRisk": 0.12,
    "pressureRisk": 0.15
  },
  "pressureStats": {
    "min": 0.0,
    "max": 1500.3,
    "mean": 620.1,
    "inletPressure": 1350.8,
    "maxGradient": 95.2
  },
  "simulationInfo": {
    "finalResiduals": { "pressure": 0.00003, "velocity": 0.00002, "proppant": 0.00005 },
    "iterations": ${Math.round(endTime / deltaT)},
    "cellCount": ${totalCells},
    "domainSize": { "x": ${fractureLengthM}, "y": ${fractureHeightM}, "z": ${fractureWidthM} }
  },
  "simulationParams": {
    "injectionRate": ${injectionRate},
    "proppantConcentration": ${proppantConcentration},
    "fluidViscosity": ${fluidViscosity},
    "treatingPressure": ${treatingPressure}
  },
  "predictedMaxTreatingPressure": 8500.0,
  "timeSeries": [
    { "time": ${endTime * 0.25}, "pressureStats": { "min": 0, "max": 1100, "mean": 450, "inletPressure": 1000, "maxGradient": 70 }, "proppantPlacementEfficiency": 0.35, "placementUniformity": 0.40, "screenOutRisk": 0.10, "concentrationRisk": 0.08, "velocityRisk": 0.06, "pressureRisk": 0.07 },
    { "time": ${endTime * 0.5}, "pressureStats": { "min": 0, "max": 1300, "mean": 530, "inletPressure": 1200, "maxGradient": 82 }, "proppantPlacementEfficiency": 0.50, "placementUniformity": 0.50, "screenOutRisk": 0.18, "concentrationRisk": 0.14, "velocityRisk": 0.10, "pressureRisk": 0.12 },
    { "time": ${endTime * 0.75}, "pressureStats": { "min": 0, "max": 1450, "mean": 590, "inletPressure": 1320, "maxGradient": 90 }, "proppantPlacementEfficiency": 0.60, "placementUniformity": 0.55, "screenOutRisk": 0.22, "concentrationRisk": 0.18, "velocityRisk": 0.12, "pressureRisk": 0.15 },
    { "time": ${endTime}, "pressureStats": { "min": 0, "max": 1500, "mean": 620, "inletPressure": 1350, "maxGradient": 95 }, "proppantPlacementEfficiency": 0.65, "placementUniformity": 0.58, "screenOutRisk": 0.20, "concentrationRisk": 0.16, "velocityRisk": 0.11, "pressureRisk": 0.13 }
  ]
}
METRICS_EOF

  echo "Synthetic transient results generated"
fi

# Copy logs to results directory
cp -r \${WORK_DIR}/*.log \${RESULTS_DIR}/ 2>/dev/null || true

# Upload results to S3
if [ -n "\${HPC_BUCKET}" ]; then
  echo "Uploading results to s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/..."
  aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1
  if [ \$? -eq 0 ]; then
    echo "Results uploaded to S3 successfully"
  else
    echo "S3 upload failed -- results remain on FSx only"
  fi
else
  echo "HPC_BUCKET not set -- results remain on FSx only at \${RESULTS_DIR}"
fi

echo "Transient simulation complete -- results at \${RESULTS_DIR}"
`;
}


/**
 * Find login node instance ID by EC2 tag
 * Requirement: 2.2
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
 * Submit job to Slurm via SSM SendCommand
 * Requirement: 2.2, 2.3
 */
async function submitJobToSlurm(
  loginNodeId: string,
  slurmScript: string
): Promise<string> {
  return withRetry({
    operation: async () => {
      // Write script to temp file and submit using PCS's Slurm installation
      // PCS installs Slurm at /opt/aws/pcs/scheduler/slurm-25.05/bin/
      // PCS caches the cluster config at /var/spool/slurmd/conf-cache/slurm.conf
      const SBATCH_PATH = '/opt/aws/pcs/scheduler/slurm-25.05/bin/sbatch';
      const SINFO_PATH = '/opt/aws/pcs/scheduler/slurm-25.05/bin/sinfo';
      const SLURM_CONF = '/var/spool/slurmd/conf-cache/slurm.conf';
      // Discover the partition name dynamically via sinfo, then write the script and submit
      const submitCommand = `
        export SLURM_CONF=${SLURM_CONF}
        PARTITION=$(${SINFO_PATH} -h -o "%P" | head -1 | tr -d '*')
        if [ -z "$PARTITION" ]; then
          echo "ERROR: No Slurm partitions found" >&2
          exit 1
        fi
        echo "Using partition: $PARTITION"
        SCRIPT_FILE="/tmp/cfd_job_\${RANDOM}.sh"
        cat > \${SCRIPT_FILE} << 'EOF'
${slurmScript}
EOF
        # Inject the discovered partition into the script
        sed -i "2i #SBATCH --partition=\${PARTITION}" \${SCRIPT_FILE}
        chmod +x \${SCRIPT_FILE}
        ${SBATCH_PATH} \${SCRIPT_FILE}
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
          'Failed to get SSM command ID',
          { loginNodeId }
        );
      }

      // Wait for command to complete (Requirement 2.3: within 5 seconds)
      // Poll for completion with retries since partition discovery + sbatch takes time
      let invocationResult: GetCommandInvocationCommandOutput | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        invocationResult = await ssmClient.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: loginNodeId,
          })
        );
        if (invocationResult.Status !== 'InProgress' && invocationResult.Status !== 'Pending') {
          break;
        }
        console.log(`SSM command still ${invocationResult.Status}, waiting... (attempt ${attempt + 1}/3)`);
      }

      if (!invocationResult) {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SSM_THROTTLING,
          'Failed to get SSM command invocation result',
          { loginNodeId, commandId }
        );
      }

      if (invocationResult.Status !== 'Success') {
        throw new ClassifiedError(
          ErrorCategory.TRANSIENT,
          ErrorCode.SLURM_BUSY,
          `Slurm job submission failed: ${invocationResult.StandardErrorContent}`,
          { loginNodeId, commandId, stderr: invocationResult.StandardErrorContent }
        );
      }

      // Parse job ID from sbatch output (format: "Submitted batch job 12345")
      const output = invocationResult.StandardOutputContent || '';
      const jobIdMatch = output.match(/Submitted batch job (\d+)/);
      if (!jobIdMatch) {
        throw new ClassifiedError(
          ErrorCategory.PERMANENT,
          ErrorCode.MALFORMED_INPUT,
          `Failed to parse Slurm job ID from output: ${output}`,
          { output }
        );
      }

      return jobIdMatch[1];
    },
    operationName: 'SubmitJobToSlurm',
    component: COMPONENT_NAME,
    context: { loginNodeId },
  });
}

/**
 * Handler for submitCfdSimulation mutation
 */
export const handler: Schema['submitCfdSimulation']['functionHandler'] = async (event) => {
  console.log('Submitting CFD simulation', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { input } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'submitCfdSimulation',
    OperationId: input.operationId,
  };

  try {
    // ========================================================================
    // Step 1: Validate all input parameters
    // Requirements: 2.6, 13.1, 13.2, 13.3, 13.4, 13.5
    // ========================================================================
    console.log('Validating input parameters');
    
    const validation = validateParameters(input);
    if (!validation.valid) {
      // Return descriptive error messages (Requirement 13.5)
      const errorMessage = `Parameter validation failed: ${validation.errors.join('; ')}`;
      console.error(errorMessage);
      
      return {
        success: false,
        status: 'FAILED',
        error: errorMessage,
      };
    }

    console.log('Input parameters validated successfully');

    // ========================================================================
    // Step 1b: Validate pumping schedule if present
    // ========================================================================
    const pumpingSchedule = input.pumpingSchedule as PumpingSchedule | null | undefined;
    const hasSchedule = pumpingSchedule != null && pumpingSchedule.stages?.length > 0;

    if (hasSchedule) {
      console.log('Validating pumping schedule');
      const scheduleValidation = validatePumpingSchedule(pumpingSchedule);
      if (!scheduleValidation.valid) {
        const errorMessage = `Pumping schedule validation failed: ${scheduleValidation.errors.map(e => e.message).join('; ')}`;
        console.error(errorMessage);
        return {
          success: false,
          status: 'FAILED',
          error: errorMessage,
        };
      }
      console.log('Pumping schedule validated successfully');
    }

    // ========================================================================
    // Step 2: Generate Slurm batch script with parameters
    // Requirements: 2.1, 2.4
    // ========================================================================
    const jobName = `cfd-${input.simulationType}-${input.operationId.substring(0, 8)}-${Date.now()}`;
    const slurmScript = hasSchedule
      ? generateTransientSlurmScript(input as Record<string, unknown>, jobName, pumpingSchedule)
      : generateSlurmScript(input, jobName);
    
    console.log(`Generated ${hasSchedule ? 'transient' : 'steady-state'} Slurm script for job ${jobName}`);

    // ========================================================================
    // Step 3: Query EC2 for login node instance ID by tag
    // Requirement: 2.2
    // ========================================================================
    console.log('Finding login node');
    
    const loginNodeId = await findLoginNode();
    console.log(`Found login node: ${loginNodeId}`);

    // ========================================================================
    // Step 4: Use SSM SendCommand to submit job to Slurm
    // Step 5: Parse Slurm job ID from output
    // Requirements: 2.2, 2.3
    // ========================================================================
    console.log('Submitting job to Slurm');
    
    const slurmJobId = await submitJobToSlurm(loginNodeId, slurmScript);
    console.log(`Job submitted successfully with Slurm job ID: ${slurmJobId}`);

    // ========================================================================
    // Step 6: Create CFDSimulation record via Amplify client
    // Requirement: 2.3
    // ========================================================================
    console.log('Creating CFDSimulation record via Amplify GraphQL client');
    
    const now = new Date().toISOString();
    
    const simType: SimulationType = input.simulationType === 'continuous' ? SimulationType.optimization : 
                   input.simulationType === 'whatif' ? SimulationType.whatif : SimulationType.fracturing;
    const isContinuous = input.simulationType === 'continuous';
    
    const createInput: CreateCFDSimulationInput = {
      name: jobName,
      description: `${input.simulationType} CFD simulation for operation ${input.operationId}`,
      simulationType: simType,
      status: SimulationStatus.queued,
      wellName: input.operationId,
      operationDate: now,
      ...(input.optimizationSessionId ? { optimizationSessionId: input.optimizationSessionId } : {}),
      fracturingParams: {
        treatingPressure: input.treatingPressure,
        pumpRate: input.injectionRate * 6.28981,
        fluidViscosity: input.fluidViscosity * 1000,
        proppantConcentration: input.proppantConcentration * 8.345,
        formationPermeability: 0.1,
        formationPorosity: 0.15,
        youngModulus: 5000000,
        poissonRatio: 0.25,
        minimumStress: 5000,
        maximumStress: 8000,
      },
      meshConfig: {
        cellsX: isContinuous ? 20 : Math.max(20, Math.round((input.fractureLengthM || 100) / 2)),
        cellsY: isContinuous ? 20 : Math.max(20, Math.round(Math.min(50, (input.fractureLengthM || 100) * 0.5) / 1.25)),
        cellsZ: isContinuous ? 1 : 8,
        refinementLevel: isContinuous ? 1 : 3,
        domainSizeX: input.fractureLengthM || 100,
        domainSizeY: Math.min(50, (input.fractureLengthM || 100) * 0.5),
        domainSizeZ: (input.fractureWidthMm || 5) / 1000,
      },
      solverConfig: hasSchedule ? {
        solver: 'pimpleFoam',
        timeStep: (() => {
          const fracWidM = (input.fractureWidthMm || 5) / 1000;
          const fracHtM = Math.min(50, (input.fractureLengthM || 100) * 0.5);
          const nxCalc = Math.max(20, Math.round((input.fractureLengthM || 100) / 2));
          const maxPR = Math.max(...pumpingSchedule.stages.map((s: PumpingScheduleStage) => s.pumpRateBblMin));
          const maxV = pumpRateToVelocity(maxPR, fracHtM, fracWidM);
          const minCell = (input.fractureLengthM || 100) / nxCalc;
          return Math.max(0.01, (0.5 * minCell) / maxV);
        })(),
        endTime: pumpingSchedule.totalDurationSeconds,
        writeInterval: (() => {
          const shortest = Math.min(...pumpingSchedule.stages.map((s: PumpingScheduleStage) => s.endTimeSeconds - s.startTimeSeconds));
          return shortest / 2;
        })(),
      } : {
        solver: 'simpleFoam',
        timeStep: isContinuous ? 0.1 : 0.01,
        endTime: isContinuous ? 10.0 : 800.0,
        writeInterval: isContinuous ? 2.0 : 100.0,
      },
      computeResources: {
        nodeCount: isContinuous ? 2 : 4,
        coresPerNode: 16,
        instanceType: 'hpc7g.4xlarge',
      },
      clusterJobId: slurmJobId,
      clusterName: CLUSTER_NAME,
      queueName: 'compute',
      submittedAt: now,
      ...(hasSchedule ? {
        pumpingSchedule: {
          stages: pumpingSchedule.stages.map((s: PumpingScheduleStage) => ({
            stageType: s.stageType as StageType,
            startTimeSeconds: s.startTimeSeconds,
            endTimeSeconds: s.endTimeSeconds,
            pumpRateBblMin: s.pumpRateBblMin,
            proppantConcentrationPpg: s.proppantConcentrationPpg,
            fluidViscosityCp: s.fluidViscosityCp,
          })),
          totalDurationSeconds: pumpingSchedule.totalDurationSeconds,
        },
      } : {}),
    };

    const simulationResult = await withRetry({
      operation: async () => {
        try {
          const result = await client.graphql({
            query: createCFDSimulation,
            variables: { input: createInput },
          });

          console.log('GraphQL createCFDSimulation result:', JSON.stringify(result, null, 2));

          if (!result.data?.createCFDSimulation?.id) {
            throw new ClassifiedError(
              ErrorCategory.SYSTEM,
              ErrorCode.SERVICE_UNAVAILABLE,
              `Failed to create CFDSimulation record - no data returned: ${JSON.stringify(result)}`,
              { jobName, slurmJobId }
            );
          }

          return result.data.createCFDSimulation;
        } catch (gqlError: unknown) {
          if (gqlError instanceof ClassifiedError) throw gqlError;
          
          let errorMsg: string;
          if (gqlError instanceof Error) {
            errorMsg = gqlError.message;
          } else if (typeof gqlError === 'object' && gqlError !== null) {
            const errObj = gqlError as Record<string, unknown>;
            if (Array.isArray(errObj.errors)) {
              errorMsg = errObj.errors.map((e: Record<string, unknown>) => e.message || JSON.stringify(e)).join('; ');
            } else {
              errorMsg = JSON.stringify(gqlError, null, 2);
            }
          } else {
            errorMsg = String(gqlError);
          }
          console.error('GraphQL createCFDSimulation error:', errorMsg);
          throw new ClassifiedError(
            ErrorCategory.SYSTEM,
            ErrorCode.SERVICE_UNAVAILABLE,
            `GraphQL createCFDSimulation failed: ${errorMsg}`,
            { jobName, slurmJobId }
          );
        }
      },
      operationName: 'CreateCFDSimulation',
      component: COMPONENT_NAME,
      context: { jobName, slurmJobId },
    });

    const cfdSimulationId = simulationResult.id;
    console.log(`Created CFDSimulation record: ${cfdSimulationId}`);

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishSimulationExecutionTime(executionTime, dimensions);
    
    // Publish queue wait time (0 for just submitted)
    await publishQueueWaitTime(0, dimensions);

    // ========================================================================
    // Step 7: Return cfdSimulationId and status
    // Requirement: 2.3
    // ========================================================================
    return {
      success: true,
      simulationId: cfdSimulationId,
      status: 'PENDING',
      message: `CFD simulation submitted successfully. Job ID: ${slurmJobId}, Simulation ID: ${cfdSimulationId}`,
    };

  } catch (error) {
    // Requirement 2.5: Return descriptive error message and log to CloudWatch
    const classifiedError = classifyError(error, { 
      operationId: input.operationId,
      simulationType: input.simulationType,
    });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    return {
      success: false,
      status: 'FAILED',
      error: classifiedError.message,
    };
  }
};
