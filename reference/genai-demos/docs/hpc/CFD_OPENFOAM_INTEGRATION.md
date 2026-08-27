# OpenFOAM CFD Integration Guide

> ⚠️ **SUPERSEDED (historical).** This guide describes the earlier **AWS Batch** compute model (Spot `c5n.18xlarge`, 0–256 vCPUs). The shipped system runs OpenFOAM on an **AWS PCS SLURM cluster** (`hpc7g.4xlarge`, 0–10). For the current architecture and how the agent invokes CFD, see **[README.md](README.md)**. Kept for historical reference only.

This guide explains the OpenFOAM integration for real-time CFD monitoring and "What-If" analysis in well fracturing operations.

## Overview

The system integrates OpenFOAM computational fluid dynamics (CFD) simulations with AWS Batch for scalable compute, enabling:

- **Real-time monitoring** of fracturing operations
- **What-If analysis** by restarting from existing solutions (<10 minutes)
- **Automated visualization** of pressure, velocity, and fracture propagation
- **Cost tracking** and resource optimization

## Architecture

```
Frontend (Next.js)
    ↓
GraphQL API (AppSync)
    ↓
CFD Simulation Manager (Lambda)
    ↓
AWS Batch (OpenFOAM Container)
    ↓
S3 Storage (Results & Visualizations)
```

### Components

1. **Data Model** (`amplify/data/schemas/cfd.schema.ts`)
   - CFDSimulation: Main simulation records
   - SimulationSnapshot: Visualization snapshots at time steps
   - ParallelClusterConfig: Cluster configuration
   - Custom mutations for job management

2. **Compute Environment** (`amplify/custom/parallelCluster.ts`)
   - AWS Batch compute environment with auto-scaling
   - Spot instances for cost optimization (80% bid)
   - c5n.18xlarge instances for high-performance computing
   - OpenFOAM 11 container with ParaView 5.10

3. **Lambda Function** (`amplify/functions/cfd-simulation-manager/`)
   - Submit simulations to AWS Batch
   - Monitor job status and progress
   - Cancel running simulations
   - Generate visualization snapshots

4. **Frontend Pages**
   - `/simulations` - List all simulations
   - `/simulations/[id]` - Detailed view with progress and results

## Simulation Types

### 1. Fracturing Simulation
Full CFD simulation of hydraulic fracturing process.

**Parameters:**
- Treating pressure (psi)
- Pump rate (bbl/min)
- Fluid viscosity (cP)
- Proppant concentration (ppg)
- Formation properties (permeability, porosity, stress)

**Use Case:** Initial analysis of fracturing design

### 2. What-If Analysis
Fast restart from existing solution to test parameter changes.

**Parameters:**
- Parent simulation ID
- Restart time
- Modified parameters (e.g., increased treating pressure)

**Use Case:** Real-time operational decisions (<10 minutes)

### 3. Production Simulation
Flow simulation for production optimization.

**Use Case:** Post-fracturing production forecasting

### 4. Optimization
Parameter sweep for optimal design.

**Use Case:** Design optimization studies

## Usage

### Creating a Simulation

```typescript
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

const client = generateClient<Schema>();

// Create simulation record
const { data: simulation } = await client.models.CFDSimulation.create({
  name: 'Well A-1 Fracturing',
  simulationType: 'fracturing',
  status: 'queued',
  wellName: 'A-1',
  meshConfig: JSON.stringify({
    cellsX: 100,
    cellsY: 100,
    cellsZ: 50,
    refinementLevel: 2,
    domainSizeX: 1000,
    domainSizeY: 1000,
    domainSizeZ: 500,
  }),
  solverConfig: JSON.stringify({
    solver: 'simpleFoam',
    timeStep: 0.01,
    endTime: 100,
    writeInterval: 10,
  }),
  fracturingParams: JSON.stringify({
    treatingPressure: 8000,
    pumpRate: 50,
    fluidViscosity: 10,
    formationPermeability: 0.1,
    formationPorosity: 0.15,
    youngModulus: 5e6,
    poissonRatio: 0.25,
    minimumStress: 6000,
    maximumStress: 9000,
  }),
  computeResources: JSON.stringify({
    nodeCount: 4,
    coresPerNode: 72,
    instanceType: 'c5n.18xlarge',
  }),
  submittedAt: new Date().toISOString(),
});

// Submit to AWS Batch
const result = await client.mutations.submitCFDSimulation({
  input: JSON.stringify({
    simulationId: simulation.id,
    name: simulation.name,
    simulationType: simulation.simulationType,
    fracturingParams: JSON.parse(simulation.fracturingParams),
    meshConfig: JSON.parse(simulation.meshConfig),
    solverConfig: JSON.parse(simulation.solverConfig),
  }),
});
```

### What-If Analysis (Fast Restart)

```typescript
// Create what-if simulation from existing
const { data: whatIfSim } = await client.models.CFDSimulation.create({
  name: 'What-If: Increased Pressure',
  simulationType: 'whatif',
  status: 'queued',
  wellName: 'A-1',
  parentSimulationId: parentSimulation.id,
  restartFromTime: 50.0, // Restart at 50 seconds
  meshConfig: parentSimulation.meshConfig, // Reuse mesh
  solverConfig: JSON.stringify({
    ...JSON.parse(parentSimulation.solverConfig),
    endTime: 100, // Continue to 100s
  }),
  fracturingParams: JSON.stringify({
    ...JSON.parse(parentSimulation.fracturingParams),
    treatingPressure: 9000, // Increased from 8000
  }),
  computeResources: parentSimulation.computeResources,
  submittedAt: new Date().toISOString(),
});

// Submit (will copy restart files automatically)
await client.mutations.submitCFDSimulation({
  input: JSON.stringify({
    simulationId: whatIfSim.id,
    parentSimulationId: parentSimulation.id,
    restartFromTime: 50.0,
    // ... other params
  }),
});
```

### Monitoring Progress

```typescript
// Poll for status updates
const statusResult = await client.queries.getCFDSimulationStatus({
  simulationId: simulation.id,
});

const status = JSON.parse(statusResult.data);
console.log('Status:', status.status);
console.log('Progress:', status.progress?.percentComplete);
```

### Cancelling a Simulation

```typescript
await client.mutations.cancelCFDSimulation({
  simulationId: simulation.id,
});
```

## S3 Storage Structure

```
cfd-simulations/
  {simulation-id}/
    config.json              # Simulation configuration
    blockMesh.log           # Mesh generation log
    solver.log              # Solver execution log
    results/
      0/                    # Initial conditions
      10/                   # Time step 10s
      20/                   # Time step 20s
      ...
      VTK/                  # ParaView visualization files
    snapshots/
      pressure-10s.png      # Pressure visualization
      velocity-20s.png      # Velocity visualization
      fracture-50s.png      # Fracture propagation
```

## OpenFOAM Container

The AWS Batch job uses the official OpenFOAM container:
- Image: `openfoam/openfoam11-paraview510`
- Pre-installed solvers: simpleFoam, pimpleFoam, interFoam, etc.
- ParaView for post-processing
- MPI support for parallel execution

### Custom Solver Script

The Lambda function generates a bash script that:
1. Downloads configuration from S3
2. Generates mesh using blockMesh
3. Copies restart data (for what-if analysis)
4. Runs OpenFOAM solver
5. Post-processes with foamToVTK
6. Uploads results to S3

## Cost Optimization

### Spot Instances
- 80% bid percentage for cost savings
- Automatic retry on spot interruption
- Typical cost: $0.50-$2.00 per simulation hour

### Instance Selection
- c5n.18xlarge: 72 vCPUs, 192 GB RAM, 100 Gbps network
- Optimal for CFD workloads
- Auto-scaling from 0 to 256 vCPUs

### What-If Analysis Savings
- Full simulation: 2-4 hours
- What-if restart: 5-10 minutes
- Cost reduction: 95%+

## Visualization

### Automatic Snapshots
The system can generate visualization snapshots at specified time steps:

```typescript
await client.mutations.generateSimulationSnapshots({
  simulationId: simulation.id,
  timeSteps: [10, 20, 30, 40, 50], // seconds
});
```

### Snapshot Types
- **Pressure**: Pressure distribution in formation
- **Velocity**: Fluid velocity vectors
- **Fracture**: Fracture propagation and geometry

### ParaView Integration
Results are exported in VTK format for advanced visualization:
1. Download results from S3
2. Open in ParaView
3. Create custom visualizations
4. Export images/animations

## Performance

### Typical Simulation Times

| Mesh Size | Cores | Time Steps | Duration |
|-----------|-------|------------|----------|
| 100k cells | 36 | 1000 | 30 min |
| 500k cells | 72 | 1000 | 2 hours |
| 1M cells | 144 | 1000 | 4 hours |

### What-If Analysis
- Restart overhead: 1-2 minutes
- Additional time steps: 5-8 minutes
- Total: <10 minutes

## Troubleshooting

### Simulation Failed
1. Check `solver.log` in S3
2. Review error message in simulation record
3. Verify mesh quality (blockMesh.log)
4. Check parameter ranges

### Slow Performance
1. Increase instance count
2. Optimize mesh refinement
3. Adjust time step size
4. Use coarser mesh for what-if analysis

### High Costs
1. Use spot instances (already enabled)
2. Reduce mesh size
3. Optimize solver settings
4. Use what-if analysis for parameter studies

## Future Enhancements

1. **Real-time Streaming**: Stream solver output to frontend
2. **Adaptive Mesh Refinement**: Automatic mesh optimization
3. **ML Surrogate Models**: Fast approximations for screening
4. **Multi-well Optimization**: Batch optimization across wells
5. **Integration with Sensors**: Real-time data assimilation

## References

- [OpenFOAM Documentation](https://www.openfoam.com/documentation/)
- [AWS Batch User Guide](https://docs.aws.amazon.com/batch/)
- [ParaView Guide](https://www.paraview.org/documentation/)
- [Feasibility Study](./genai_hpc_cfd_screen_out_feasibility.md)

## Support

For issues or questions:
1. Check CloudWatch Logs for Lambda and Batch
2. Review S3 logs (solver.log, blockMesh.log)
3. Verify IAM permissions
4. Check AWS Batch console for job status
