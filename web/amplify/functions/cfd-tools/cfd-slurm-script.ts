// Inline Slurm/OpenFOAM script generation for the CFD tools (issue #504,
// epic #498 slice 6). Ported and consolidated from reference/genai-demos'
// cfd-simulation-manager/submitCfdSimulation.ts (generateSlurmScript /
// generateTransientSlurmScript) into a single generator parameterized on
// whether a pumping schedule (stages[]) was supplied — steady-state
// `simpleFoam` when it wasn't, transient `pimpleFoam` when it was.
//
// Metrics (issue #527): when OpenFOAM is present the script runs the real
// field-extraction pipeline — after the solver + `reconstructPar` it runs
// `foamToVTK` and then `scripts/calculate_metrics.py` (ported verbatim from
// genai-demos, vendored at `web/amplify/functions/cfd-tools/scripts/` and
// shipped to `s3://<HPC_BUCKET>/scripts/calculate_metrics.py`). That script
// reads the solved `alpha.proppant`/`U`/`p` fields and writes
// `results/metrics.json` with screen-out risk, placement efficiency,
// fracture-geometry score and predicted max treating pressure — its output
// schema matches `handler.ts`'s `CfdMetricsJson` parser. The bash heuristic
// `metricsJsonHeredoc` (computed from input params only) is now the fallback:
// used when OpenFOAM isn't installed, or if `calculate_metrics.py` fails, so
// `GetCfdResults` always returns something.

import type { TreatmentPlan, PumpingScheduleStage } from './cfd-types';

function pumpRateToVelocity(pumpRateBblMin: number, fractureHeightM: number, fractureWidthM: number): number {
  return (pumpRateBblMin * 0.00265) / (fractureHeightM * fractureWidthM);
}

function proppantPpgToVolumeFraction(ppg: number): number {
  return ppg * 0.0001198;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface ScriptGeometry {
  fractureWidthM: number;
  fractureHeightM: number;
  nx: number;
  ny: number;
  nz: number;
  idealProcs: number;
  totalCells: number;
}

function computeGeometry(plan: TreatmentPlan, transient: boolean, maxProcs: number): ScriptGeometry {
  const fractureLengthM = plan.fractureLengthM ?? 100;
  const fractureWidthMm = plan.fractureWidthMm ?? 5;
  const fractureWidthM = fractureWidthMm / 1000;
  const fractureHeightM = Math.min(50, fractureLengthM * 0.5);

  const nx = Math.max(20, Math.round(fractureLengthM / 2));
  const ny = Math.max(20, Math.round(fractureHeightM / 1.25));
  // 8 z-cells for the steady mesh (fine aperture resolution); 2 for transient
  // sims, which would otherwise face an impractically small Courant-limited deltaT.
  const nz = transient ? 2 : 8;
  const totalCells = nx * ny * nz;

  const idealProcs = transient
    ? Math.max(4, Math.min(8, Math.min(maxProcs, Math.round(totalCells / 300))))
    : Math.max(4, Math.min(maxProcs, Math.round(totalCells / 300)));

  return { fractureWidthM, fractureHeightM, nx, ny, nz, idealProcs, totalCells };
}

/** Heuristic risk/optimization metrics, computed directly from the plan's parameters (see module doc for why). */
function metricsJsonHeredoc(plan: TreatmentPlan, geometry: ScriptGeometry): string {
  const concentrationRisk = clamp01(plan.proppantConcentration / 0.4);
  const velocityRisk = clamp01(0.1 / (plan.injectionRate + 0.01) - 0.2);
  const pressureRisk = clamp01(plan.treatingPressure / 10000);
  const screenOutRisk = clamp01(concentrationRisk * 0.5 + velocityRisk * 0.3 + pressureRisk * 0.2);
  const proppantPlacementEfficiency = clamp01(1 - screenOutRisk * 0.6);
  const fractureGeometryScore = clamp01(1 - Math.abs(plan.injectionRate - 0.3) / 0.3);
  const placementUniformity = clamp01(0.4 + plan.fluidViscosity * 5);

  return `cat > \${RESULTS_DIR}/metrics.json << METRICS_EOF
{
  "optimizationMetrics": {
    "proppantPlacementEfficiency": ${proppantPlacementEfficiency.toFixed(4)},
    "fractureGeometryScore": ${fractureGeometryScore.toFixed(4)},
    "placementUniformity": ${placementUniformity.toFixed(4)}
  },
  "riskMetrics": {
    "screenOutRisk": ${screenOutRisk.toFixed(4)},
    "concentrationRisk": ${concentrationRisk.toFixed(4)},
    "velocityRisk": ${velocityRisk.toFixed(4)},
    "pressureRisk": ${pressureRisk.toFixed(4)}
  },
  "confidence": \$( [ -f \${WORK_DIR}/simpleFoam.log ] || [ -f \${WORK_DIR}/pimpleFoam.log ] && echo 0.75 || echo 0.4 ),
  "simulationInfo": {
    "cellCount": ${geometry.totalCells},
    "domainSize": { "x": ${(plan.fractureLengthM ?? 100)}, "y": ${geometry.fractureHeightM}, "z": ${geometry.fractureWidthM} }
  },
  "simulationParams": {
    "injectionRate": ${plan.injectionRate},
    "proppantConcentration": ${plan.proppantConcentration},
    "fluidViscosity": ${plan.fluidViscosity},
    "treatingPressure": ${plan.treatingPressure}
  }
}
METRICS_EOF`;
}

function velocityAndAlphaTables(stages: PumpingScheduleStage[], fractureHeightM: number, fractureWidthM: number): { velocityTableEntries: string; alphaTableEntries: string } {
  const velocityLines: string[] = [];
  const alphaLines: string[] = [];
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    const v = pumpRateToVelocity(stage.pumpRateBblMin, fractureHeightM, fractureWidthM);
    const vf = proppantPpgToVolumeFraction(stage.proppantConcentrationPpg);
    velocityLines.push(`        (${stage.startTimeSeconds}      (${v} 0 0))`);
    alphaLines.push(`        (${stage.startTimeSeconds}      ${vf})`);
    if (i === stages.length - 1) {
      velocityLines.push(`        (${stage.endTimeSeconds}      (${v} 0 0))`);
      alphaLines.push(`        (${stage.endTimeSeconds}      ${vf})`);
    }
  }
  return { velocityTableEntries: velocityLines.join('\n'), alphaTableEntries: alphaLines.join('\n') };
}

/**
 * Builds a Slurm batch script that stages an OpenFOAM case on FSx and runs it
 * — steady `simpleFoam` when `plan.stages` is absent, transient `pimpleFoam`
 * (time-varying inlet BCs from the pumping schedule) when present. Falls
 * back to writing a heuristic metrics.json when OpenFOAM isn't installed on
 * the compute node (e.g. a bare AMI without the toolchain baked in).
 */
export function buildCfdSlurmScript(plan: TreatmentPlan, jobName: string, hpcBucket: string): string {
  const transient = !!plan.stages?.length;
  const resources = transient
    ? { nodes: 4, tasksPerNode: 16, time: '01:00:00' }
    : { nodes: 4, tasksPerNode: 16, time: '00:30:00' };
  const maxProcs = resources.nodes * resources.tasksPerNode;
  const geometry = computeGeometry(plan, transient, maxProcs);
  const fractureLengthM = plan.fractureLengthM ?? 100;

  const inletBc = transient
    ? (() => {
      const { velocityTableEntries, alphaTableEntries } = velocityAndAlphaTables(plan.stages!, geometry.fractureHeightM, geometry.fractureWidthM);
      return {
        uVelocity: `type            uniformFixedValue;\n        uniformValue    table\n        (\n${velocityTableEntries}\n        );`,
        alpha: `type            uniformFixedValue;\n        uniformValue    table\n        (\n${alphaTableEntries}\n        );`,
      };
    })()
    : (() => {
      const inletVelocity = plan.injectionRate / (geometry.fractureHeightM * geometry.fractureWidthM);
      return {
        uVelocity: `type            fixedValue;\n        value           uniform (${inletVelocity} 0 0);`,
        alpha: `type            fixedValue;\n        value           uniform ${plan.proppantConcentration};`,
      };
    })();

  const controlDict = transient
    ? (() => {
      const maxPumpRate = Math.max(...plan.stages!.map((s) => s.pumpRateBblMin));
      const maxVelocity = pumpRateToVelocity(maxPumpRate, geometry.fractureHeightM, geometry.fractureWidthM);
      const minCellSize = Math.min(fractureLengthM / geometry.nx, geometry.fractureWidthM / geometry.nz);
      const deltaT = Math.max(0.001, Math.min(1.0, (0.5 * minCellSize) / maxVelocity));
      const shortestStage = Math.min(...plan.stages!.map((s) => s.endTimeSeconds - s.startTimeSeconds));
      const writeInterval = Math.max(deltaT, shortestStage);
      return { application: 'pimpleFoam', endTime: plan.stages!.reduce((max, s) => Math.max(max, s.endTimeSeconds), 0), deltaT, writeInterval, writeControl: 'adjustableRunTime', extra: 'adjustTimeStep  yes;\n\nmaxCo           0.9;\n\nmaxDeltaT       ' + writeInterval + ';\n\n' };
    })()
    : { application: 'simpleFoam', endTime: 800, deltaT: 1, writeInterval: 100, writeControl: 'timeStep', extra: '' };

  const fvSolutionExtra = transient
    ? `\n    pFinal\n    {\n        \$p;\n        relTol          0;\n    }\n`
    : '';
  const uSolutionExtra = transient ? `\n\n    UFinal\n    {\n        \$U;\n        relTol          0;\n    }\n\n    "alpha.*Final"\n    {\n        \${"alpha.*"};\n        relTol          0;\n    }` : '';
  const pimpleOrSimpleBlock = transient
    ? `PIMPLE\n{\n    nOuterCorrectors    3;\n    nCorrectors         2;\n    nNonOrthogonalCorrectors 1;\n}`
    : `SIMPLE\n{\n    nNonOrthogonalCorrectors 1;\n    consistent      yes;\n\n    residualControl\n    {\n        p               1e-05;\n        U               1e-05;\n        "alpha.*"       1e-05;\n    }\n}\n\nrelaxationFactors\n{\n    fields\n    {\n        p               0.3;\n    }\n    equations\n    {\n        U               0.7;\n        "alpha.*"       0.7;\n    }\n}`;
  const ddtScheme = transient ? 'Euler' : 'steadyState';
  const solverBin = transient ? 'pimpleFoam' : 'simpleFoam';
  // Transient runs need every timestep reconstructed so calculate_metrics.py can
  // build a time series; steady only needs the converged (latest) field.
  const reconstructArgs = transient ? '' : ' -latestTime';
  const metricsTransientFlag = transient ? ' \\\n    --transient' : '';

  return `#!/bin/bash
#SBATCH --job-name=${jobName}
#SBATCH --nodes=${resources.nodes}
#SBATCH --ntasks-per-node=${resources.tasksPerNode}
#SBATCH --time=${resources.time}
#SBATCH --output=/fsx/cfd-simulations/logs/%j.out
#SBATCH --error=/fsx/cfd-simulations/logs/%j.err

export INJECTION_RATE=${plan.injectionRate}
export PROPPANT_CONCENTRATION=${plan.proppantConcentration}
export FLUID_VISCOSITY=${plan.fluidViscosity}
export TREATING_PRESSURE=${plan.treatingPressure}
export HPC_BUCKET="${hpcBucket}"

WORK_DIR="/fsx/cfd-simulations/\${SLURM_JOB_ID}"
RESULTS_DIR="\${WORK_DIR}/results"
mkdir -p \${WORK_DIR}/0 \${WORK_DIR}/constant \${WORK_DIR}/system \${RESULTS_DIR}
cd \${WORK_DIR}

if [ -f /opt/openfoam/etc/bashrc ]; then
  echo "OpenFOAM found, running ${transient ? 'transient pimpleFoam' : 'steady simpleFoam'} simulation..."
  source /opt/openfoam/etc/bashrc
  export PATH=/opt/aws/pcs/scheduler/slurm-25.05/bin:/opt/amazon/openmpi5/bin:\${PATH}
  export LD_LIBRARY_PATH=/opt/amazon/openmpi5/lib64:\${LD_LIBRARY_PATH:-}
  export HOME=\${WORK_DIR}

  cat > \${WORK_DIR}/system/blockMeshDict << 'BLOCKMESH_EOF'
FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
convertToMeters 1;
vertices
(
    (0 0 0)
    (${fractureLengthM} 0 0)
    (${fractureLengthM} ${geometry.fractureHeightM} 0)
    (0 ${geometry.fractureHeightM} 0)
    (0 0 ${geometry.fractureWidthM})
    (${fractureLengthM} 0 ${geometry.fractureWidthM})
    (${fractureLengthM} ${geometry.fractureHeightM} ${geometry.fractureWidthM})
    (0 ${geometry.fractureHeightM} ${geometry.fractureWidthM})
);
blocks
(
    hex (0 1 2 3 4 5 6 7) (${geometry.nx} ${geometry.ny} ${geometry.nz}) simpleGrading (1 1 1)
);
boundary
(
    inlet { type patch; faces ((0 4 7 3)); }
    outlet { type patch; faces ((1 2 6 5)); }
    top { type wall; faces ((3 7 6 2)); }
    bottom { type wall; faces ((0 1 5 4)); }
    frontWall { type wall; faces ((4 5 6 7)); }
    backWall { type wall; faces ((0 3 2 1)); }
);
BLOCKMESH_EOF

  cat > \${WORK_DIR}/constant/g << 'G_EOF'
FoamFile { version 2.0; format ascii; class uniformDimensionedVectorField; object g; }
dimensions [0 1 -2 0 0 0 0];
value (0 -9.81 0);
G_EOF

  cat > \${WORK_DIR}/0/U << U_EOF
FoamFile { version 2.0; format ascii; class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    inlet
    {
        ${inletBc.uVelocity}
    }
    outlet { type zeroGradient; }
    top { type noSlip; }
    bottom { type noSlip; }
    frontWall { type noSlip; }
    backWall { type noSlip; }
}
U_EOF

  cat > \${WORK_DIR}/0/p << 'P_EOF'
FoamFile { version 2.0; format ascii; class volScalarField; object p; }
dimensions [0 2 -2 0 0 0 0];
internalField uniform 0;
boundaryField
{
    inlet { type zeroGradient; }
    outlet { type fixedValue; value uniform 0; }
    top { type zeroGradient; }
    bottom { type zeroGradient; }
    frontWall { type zeroGradient; }
    backWall { type zeroGradient; }
}
P_EOF

  cat > \${WORK_DIR}/0/alpha.proppant << ALPHA_EOF
FoamFile { version 2.0; format ascii; class volScalarField; object alpha.proppant; }
dimensions [0 0 0 0 0 0 0];
internalField uniform 0;
boundaryField
{
    inlet
    {
        ${inletBc.alpha}
    }
    outlet { type zeroGradient; }
    top { type zeroGradient; }
    bottom { type zeroGradient; }
    frontWall { type zeroGradient; }
    backWall { type zeroGradient; }
}
ALPHA_EOF

  cat > \${WORK_DIR}/constant/turbulenceProperties << 'TURBULENCE_EOF'
FoamFile { version 2.0; format ascii; class dictionary; object turbulenceProperties; }
simulationType laminar;
TURBULENCE_EOF

  cat > \${WORK_DIR}/constant/transportProperties << TRANSPORT_EOF
FoamFile { version 2.0; format ascii; class dictionary; object transportProperties; }
transportModel Newtonian;
nu [0 2 -1 0 0 0 0] ${plan.fluidViscosity};
TRANSPORT_EOF

  cat > \${WORK_DIR}/system/fvSchemes << FVSCHEMES_EOF
FoamFile { version 2.0; format ascii; class dictionary; object fvSchemes; }
ddtSchemes { default ${ddtScheme}; }
gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes
{
    default none;
    div(phi,U) bounded Gauss linearUpwind grad(U);
    div(phi,alpha.proppant) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
FVSCHEMES_EOF

  cat > \${WORK_DIR}/system/fvSolution << FVSOLUTION_EOF
FoamFile { version 2.0; format ascii; class dictionary; object fvSolution; }
solvers
{
    p
    {
        solver PCG;
        preconditioner DIC;
        tolerance 1e-06;
        relTol 0.01;
    }
${fvSolutionExtra}
    U
    {
        solver PBiCGStab;
        preconditioner DILU;
        tolerance 1e-06;
        relTol 0.01;
    }${uSolutionExtra}

    "alpha.*"
    {
        solver PBiCGStab;
        preconditioner DILU;
        tolerance 1e-08;
        relTol 0.01;
    }
}

${pimpleOrSimpleBlock}
FVSOLUTION_EOF

  cat > \${WORK_DIR}/system/controlDict << CONTROLDICT_EOF
FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application ${controlDict.application};
startFrom startTime;
startTime 0;
stopAt endTime;
endTime ${controlDict.endTime};
deltaT ${controlDict.deltaT};
writeControl ${controlDict.writeControl};
writeInterval ${controlDict.writeInterval};
purgeWrite ${transient ? 0 : 3};
${controlDict.extra}writeFormat ascii;
writePrecision 6;
writeCompression off;
timeFormat general;
timePrecision 6;
runTimeModifiable true;
functions
{
    proppantTransport
    {
        type scalarTransport;
        libs (solverFunctionObjects);
        field alpha.proppant;
        resetOnStartUp false;
        nCorr 1;
        fvOptions {}
    }
}
CONTROLDICT_EOF

  NPROCS=\$(( SLURM_NTASKS < ${geometry.idealProcs} ? SLURM_NTASKS : ${geometry.idealProcs} ))
  cat > \${WORK_DIR}/system/decomposeParDict << DECOMPOSE_EOF
FoamFile { version 2.0; format ascii; class dictionary; object decomposeParDict; }
numberOfSubdomains \${NPROCS};
method scotch;
DECOMPOSE_EOF

  run_step() {
    local STEP_NAME="\$1"
    shift
    echo "Running \${STEP_NAME}..."
    "\$@" > \${STEP_NAME}.log 2>&1
    local RC=\$?
    if [ \$RC -ne 0 ]; then
      echo "ERROR: \${STEP_NAME} failed with exit code \${RC}" | tee -a \${RESULTS_DIR}/error.log
      cp -r *.log \${RESULTS_DIR}/ 2>/dev/null || true
      exit 1
    fi
  }

  run_step blockMesh blockMesh
  run_step decomposePar decomposePar -force
  run_step ${solverBin} mpirun --allow-run-as-root -np \${NPROCS} ${solverBin} -parallel
  run_step reconstructPar reconstructPar${reconstructArgs}
  run_step foamToVTK foamToVTK

  # Field-extracted metrics: read the solved alpha.proppant / U / p fields and
  # derive screen-out risk, placement efficiency, fracture-geometry score and
  # predicted max treating pressure. Prefer the version shipped to S3
  # (scripts/calculate_metrics.py, deployed from the repo) so metric changes
  # take effect without rebuilding the AMI; fall back to the AMI-baked copy.
  echo "Running calculate_metrics.py on solved fields..."
  METRICS_SCRIPT="/tmp/calculate_metrics_\${SLURM_JOB_ID}.py"
  aws s3 cp s3://\${HPC_BUCKET}/scripts/calculate_metrics.py \${METRICS_SCRIPT} 2>/dev/null \\
    || METRICS_SCRIPT="/opt/scripts/calculate_metrics.py"
  if python3 \${METRICS_SCRIPT} \\
    --work-dir \${WORK_DIR} \\
    --injection-rate ${plan.injectionRate} \\
    --proppant-concentration ${plan.proppantConcentration} \\
    --fluid-viscosity ${plan.fluidViscosity}${metricsTransientFlag} > \${WORK_DIR}/calculate_metrics.log 2>&1; then
    echo "Field-extracted metrics written to \${RESULTS_DIR}/metrics.json"
  else
    echo "WARNING: calculate_metrics.py failed (see calculate_metrics.log) -- writing heuristic metrics as fallback"
    cp \${WORK_DIR}/calculate_metrics.log \${RESULTS_DIR}/ 2>/dev/null || true
${metricsJsonHeredoc(plan, geometry)}
  fi
else
  echo "OpenFOAM not installed -- skipping solver, writing heuristic metrics only..."
${metricsJsonHeredoc(plan, geometry)}
fi

cp -r \${WORK_DIR}/*.log \${RESULTS_DIR}/ 2>/dev/null || true

if [ -n "\${HPC_BUCKET}" ]; then
  echo "Uploading results to s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/..."
  aws s3 cp \${RESULTS_DIR}/ s3://\${HPC_BUCKET}/cfd-simulations/\${SLURM_JOB_ID}/results/ --recursive 2>&1 || echo "S3 upload failed -- results remain on FSx only"
fi

echo "Simulation complete -- results at \${RESULTS_DIR}"
`;
}
